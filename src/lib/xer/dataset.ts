/**
 * The whole schedule for the dashboard: every activity with what a planner slices by (WBS,
 * activity codes, status, float, dates, DCMA findings), so the web app can filter and chart it
 * in the browser the way Power BI does.
 *
 * Activities are sent column by column ("struct of arrays"): one array per field, all the same
 * length, with repeated strings (types, statuses, code values) sent once and referenced by index.
 * Dates are day numbers (days since 1970-01-01), which are smaller than strings and need no
 * parsing to chart. For a 16,000-activity schedule that is a few MB of JSON that compresses to
 * about half a MB.
 *
 * Baseline projects exported alongside the schedule (PROJECT.sum_base_proj_id) are left out:
 * they are copies of the same activities at an earlier date.
 */
import { FALLBACK_HOURS_PER_DAY, checkSchedule, type CheckId, type CheckReport } from "./checks";
import type { ParsedXer, XerRow } from "./parse";

export type ScheduleDataset = {
  project: {
    name: string;
    shortName: string;
    /** Day number; null when the file has none. */
    dataDate: number | null;
  };
  /** Strings that activity columns refer to by index. */
  dictionaries: { type: string[]; status: string[] };
  /** The WBS as a flat list; `parent` is an index into it, -1 for a top node. */
  wbs: { name: string; code: string; parent: number }[];
  /** Activity code types that at least one activity uses; `values[i].parent` is an index into `values`. */
  codeTypes: { name: string; values: { code: string; name: string; parent: number }[] }[];
  /** The checks behind `activities.findings`: bit i set means the activity fails `checks[i]`. */
  checks: { id: CheckId; dcma: number; name: string }[];
  resources: { name: string; type: string }[];
  activities: {
    count: number;
    code: string[];
    name: string[];
    /** Index into `wbs`, -1 when unknown. */
    wbs: number[];
    type: number[];
    status: number[];
    /** Actual start, else forecast (early) start. Day number or null. */
    start: (number | null)[];
    /** Actual finish, else forecast (early) finish. */
    finish: (number | null)[];
    /** Latest the finish can be without delaying the project. */
    lateFinish: (number | null)[];
    /** Planned finish (P6 target). */
    plannedFinish: (number | null)[];
    /** Working days on the activity's calendar. */
    totalFloat: (number | null)[];
    originalDuration: (number | null)[];
    remainingDuration: (number | null)[];
    /** Total float within the project's critical threshold. */
    critical: boolean[];
    /** Bit mask over `checks`. */
    findings: number[];
    /** One array per entry of `codeTypes`: index into its `values`, -1 when the activity has none. */
    codes: number[][];
    /** Where the activity is in the file. */
    line: number[];
  };
  /** Resource assignments (TASKRSRC), column by column. */
  assignments: {
    count: number;
    /** Index into `activities`. */
    activity: number[];
    /** Index into `resources`. */
    resource: number[];
    budgetUnits: number[];
    remainingUnits: number[];
    actualUnits: number[];
  };
};

const SKIP_TYPES = new Set(["TT_LOE", "TT_WBS"]);

export function scheduleDataset(parsed: ParsedXer, report: CheckReport = checkSchedule(parsed)): ScheduleDataset {
  const rowsOf = (table: string): XerRow[] => parsed.tables.get(table)?.rows ?? [];

  // The schedule's own projects, without baselines exported alongside it.
  const projects = rowsOf("PROJECT");
  const baselineIds = new Set(projects.map(p => p.values.sum_base_proj_id).filter(Boolean));
  const own = projects.filter(p => !baselineIds.has(p.values.proj_id));
  const ownIds = new Set((own.length > 0 ? own : projects).map(p => p.values.proj_id));
  const main = own[0] ?? projects[0];

  const hoursPerDay = new Map<string, number>();
  for (const row of rowsOf("CALENDAR")) {
    const hours = Number(row.values.day_hr_cnt);
    if (hours > 0) hoursPerDay.set(row.values.clndr_id, hours);
  }
  const criticalHours = Math.max(Number(main?.values.critical_drtn_hr_cnt) || 0, 0);

  // WBS: only the schedule's own nodes, parents before children is not guaranteed, so index first.
  const wbsRows = rowsOf("PROJWBS").filter(r => ownIds.has(r.values.proj_id) && r.values.proj_node_flag !== "Y");
  const wbsIndex = new Map(wbsRows.map((r, i) => [r.values.wbs_id, i]));
  const wbs = wbsRows.map(r => ({
    name: r.values.wbs_name,
    code: r.values.wbs_short_name,
    parent: wbsIndex.get(r.values.parent_wbs_id) ?? -1,
  }));

  // Findings per activity, from the checks already run on this file.
  const checks = report.checks.map(c => ({ id: c.id, dcma: c.dcma, name: c.name }));
  const failingIds = new Map<string, number>();
  const failingCodes = new Map<string, number>();
  report.checks.forEach((check, bit) => {
    for (const a of check.activities) failingIds.set(a.taskId, (failingIds.get(a.taskId) ?? 0) | (1 << bit));
    for (const l of check.links) {
      for (const code of [l.predCode, l.succCode]) failingCodes.set(code, (failingCodes.get(code) ?? 0) | (1 << bit));
    }
  });

  const tasks = rowsOf("TASK").filter(r => ownIds.has(r.values.proj_id) && !SKIP_TYPES.has(r.values.task_type));
  const taskIndex = new Map(tasks.map((r, i) => [r.values.task_id, i]));
  const types: string[] = [];
  const statuses: string[] = [];
  const indexIn = (list: string[], value: string) => {
    const i = list.indexOf(value);
    return i >= 0 ? i : list.push(value) - 1;
  };

  // Activity codes: keep the types the schedule's activities actually use.
  const codeRows = rowsOf("ACTVCODE");
  const codeById = new Map(codeRows.map(r => [r.values.actv_code_id, r]));
  const assigned = new Map<string, Map<number, string>>();
  for (const r of rowsOf("TASKACTV")) {
    const i = taskIndex.get(r.values.task_id);
    if (i === undefined) continue;
    const byTask = assigned.get(r.values.actv_code_type_id) ?? new Map<number, string>();
    byTask.set(i, r.values.actv_code_id);
    assigned.set(r.values.actv_code_type_id, byTask);
  }
  const codeTypes: ScheduleDataset["codeTypes"] = [];
  const codes: number[][] = [];
  const typeRows = [...rowsOf("ACTVTYPE")].sort((a, b) => Number(a.values.seq_num) - Number(b.values.seq_num));
  for (const t of typeRows) {
    const byTask = assigned.get(t.values.actv_code_type_id);
    if (!byTask || byTask.size === 0) continue;
    const valueRows = codeRows
      .filter(r => r.values.actv_code_type_id === t.values.actv_code_type_id)
      .sort((a, b) => Number(a.values.seq_num) - Number(b.values.seq_num));
    const valueIndex = new Map(valueRows.map((r, i) => [r.values.actv_code_id, i]));
    codeTypes.push({
      name: t.values.actv_code_type,
      values: valueRows.map(r => ({
        code: r.values.short_name,
        name: r.values.actv_code_name,
        parent: valueIndex.get(r.values.parent_actv_code_id) ?? -1,
      })),
    });
    const column = Array<number>(tasks.length).fill(-1);
    for (const [i, codeId] of byTask) if (codeById.has(codeId)) column[i] = valueIndex.get(codeId) ?? -1;
    codes.push(column);
  }

  const days = (hours: string, perDay: number) => (hours === "" || !Number.isFinite(Number(hours)) ? null : round(Number(hours) / perDay));
  const activities: ScheduleDataset["activities"] = {
    count: tasks.length,
    code: [],
    name: [],
    wbs: [],
    type: [],
    status: [],
    start: [],
    finish: [],
    lateFinish: [],
    plannedFinish: [],
    totalFloat: [],
    originalDuration: [],
    remainingDuration: [],
    critical: [],
    findings: [],
    codes,
    line: [],
  };
  for (const r of tasks) {
    const v = r.values;
    const perDay = hoursPerDay.get(v.clndr_id) ?? FALLBACK_HOURS_PER_DAY;
    const floatHours = v.total_float_hr_cnt === "" ? null : Number(v.total_float_hr_cnt);
    activities.code.push(v.task_code);
    activities.name.push(v.task_name);
    activities.wbs.push(wbsIndex.get(v.wbs_id) ?? -1);
    activities.type.push(indexIn(types, v.task_type));
    activities.status.push(indexIn(statuses, v.status_code));
    activities.start.push(day(v.act_start_date || v.early_start_date));
    activities.finish.push(day(v.act_end_date || v.early_end_date));
    activities.lateFinish.push(day(v.late_end_date));
    activities.plannedFinish.push(day(v.target_end_date));
    activities.totalFloat.push(floatHours === null || !Number.isFinite(floatHours) ? null : round(floatHours / perDay));
    activities.originalDuration.push(days(v.target_drtn_hr_cnt, perDay));
    activities.remainingDuration.push(days(v.remain_drtn_hr_cnt, perDay));
    activities.critical.push(
      v.status_code !== "TK_Complete" && floatHours !== null && Number.isFinite(floatHours) && floatHours <= criticalHours
    );
    activities.findings.push((failingIds.get(v.task_id) ?? 0) | (failingCodes.get(v.task_code) ?? 0));
    activities.line.push(r.line);
  }

  // Resources and their assignments to the schedule's activities.
  const resourceRows = rowsOf("RSRC");
  const resourceIndex = new Map(resourceRows.map((r, i) => [r.values.rsrc_id, i]));
  const assignments: ScheduleDataset["assignments"] = {
    count: 0,
    activity: [],
    resource: [],
    budgetUnits: [],
    remainingUnits: [],
    actualUnits: [],
  };
  for (const r of rowsOf("TASKRSRC")) {
    const a = taskIndex.get(r.values.task_id);
    const res = resourceIndex.get(r.values.rsrc_id);
    if (a === undefined || res === undefined) continue;
    assignments.activity.push(a);
    assignments.resource.push(res);
    assignments.budgetUnits.push(num(r.values.target_qty));
    assignments.remainingUnits.push(num(r.values.remain_qty));
    assignments.actualUnits.push(num(r.values.act_reg_qty) + num(r.values.act_ot_qty));
    assignments.count++;
  }

  const summary = report.projects.find(p => p.id === main?.values.proj_id) ?? report.projects[0];
  return {
    project: {
      name: summary?.name || summary?.shortName || "",
      shortName: summary?.shortName ?? "",
      dataDate: day(main?.values.last_recalc_date ?? ""),
    },
    dictionaries: { type: types, status: statuses },
    wbs,
    codeTypes,
    checks,
    resources: resourceRows.map(r => ({ name: r.values.rsrc_name || r.values.rsrc_short_name, type: r.values.rsrc_type })),
    activities,
    assignments,
  };
}

/** Days since 1970-01-01 for a P6 date ("YYYY-MM-DD HH:MM"), or null. */
function day(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : null;
}

function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
