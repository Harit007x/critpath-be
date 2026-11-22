/**
 * The schedule checks. Every number here is plain code over the parsed file; nothing is estimated.
 *
 * Which activities are checked: those not yet complete (status other than TK_Complete), leaving out
 * level-of-effort (TT_LOE) and WBS summary (TT_WBS) activities, which take their dates from other
 * activities and are not expected to carry logic of their own (DCMA 14-point convention).
 *
 * Float is stored in hours in an XER. It is turned into days with each activity's own calendar
 * (CALENDAR.day_hr_cnt), never a fixed 8 hours: a 10-hour-day calendar has 10 hours in a day.
 * Lag is converted on the predecessor's calendar, P6's default for relationship lag.
 *
 * Which relationships are checked: those with at least one end among the checked activities.
 * Invalid dates is the exception: it also looks at complete activities, whose actual dates can be
 * wrong too, and needs the project's data date.
 */
import { parseCalendar, workingDaysBetween, type WorkCalendar } from "./calendar";
import { criticalPathTest, projectFinish, type PathActivity } from "./critical-path";
import type { BrokenRow, ParsedXer, XerRow } from "./parse";

/** DCMA 14-point check 6: more than 44 working days of total float is "high". */
export const HIGH_FLOAT_DAYS = 44;
/** DCMA 14-point check 14: the Baseline Execution Index should be at least 0.95. */
export const MIN_BEI = 0.95;
/** DCMA 14-point check 13: the Critical Path Length Index should be at least 0.95. */
export const MIN_CPLI = 0.95;
/** DCMA 14-point check 8: more than 44 working days of remaining duration is "high". */
export const HIGH_DURATION_DAYS = 44;
/** Used only when an activity's calendar is missing or has no hours per day (reported as broken). */
export const FALLBACK_HOURS_PER_DAY = 8;

const STATUSES = new Set(["TK_NotStart", "TK_Active", "TK_Complete"]);
const LINK_TYPES = new Set(["PR_FS", "PR_SS", "PR_FF", "PR_SF"]);
/**
 * P6's hard constraints: they fix a date regardless of logic (DCMA check 5). Soft ones (start or
 * finish on or after, as late as possible) only push dates later and are not counted.
 */
const HARD_CONSTRAINTS: Record<string, string> = {
  CS_MSO: "Start on",
  CS_MEO: "Finish on",
  CS_MSOB: "Start on or before",
  CS_MEOB: "Finish on or before",
  CS_MANDSTART: "Mandatory start",
  CS_MANDFIN: "Mandatory finish",
};
/** What a non-finish-to-start link is, for the relationship types check. */
const NON_FS_DETAIL: Record<string, string> = {
  PR_SS: "Start to start",
  PR_FF: "Finish to finish",
  PR_SF: "Start to finish (rarely valid)",
};
const EXCLUDED_TYPES = new Set(["TT_LOE", "TT_WBS"]);
const MILESTONES = new Set(["TT_Mile", "TT_FinMile"]);
const TASK_DATE_FIELDS = [
  "target_start_date",
  "target_end_date",
  "early_start_date",
  "early_end_date",
  "late_start_date",
  "late_end_date",
  "act_start_date",
  "act_end_date",
];
const DATE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

export type Activity = {
  taskId: string;
  code: string;
  name: string;
  type: string;
  status: string;
  calendar: string | null;
  /** Total float in working days on the activity's calendar; null when the file has no value. */
  totalFloatDays: number | null;
  predecessors: number;
  successors: number;
  /** Where it is in the file. */
  line: number;
};

/** One relationship (TASKPRED row) that fails a check. */
export type CheckedLink = {
  predCode: string;
  predName: string;
  succCode: string;
  succName: string;
  /** PR_FS, PR_SS, PR_FF or PR_SF. */
  type: string;
  /** Lag in working days on the predecessor's calendar. */
  lagDays: number;
  /** Where it is in the file. */
  line: number;
  detail: string;
};

export type CheckId =
  | "missing_links"
  | "leads"
  | "lags"
  | "relationship_types"
  | "hard_constraints"
  | "high_duration"
  | "invalid_dates"
  | "resources"
  | "missed_tasks"
  | "critical_path_test"
  | "cpli"
  | "bei"
  | "negative_float"
  | "high_float";

export type CheckResult = {
  id: CheckId;
  /** The check's number in the DCMA 14-point assessment. */
  dcma: number;
  name: string;
  rule: string;
  /** What the check counts: activities, or relationships. */
  subject: "activities" | "relationships";
  /** Activities or relationships that fail the check. */
  count: number;
  /** Activities or relationships the check looked at. */
  denominator: number;
  pct: number;
  /** The failing activities, for an activity check; empty otherwise. */
  activities: (Activity & { detail: string })[];
  /** The failing relationships, for a relationship check; empty otherwise. */
  links: CheckedLink[];
  /** Why the check could not run on this file (e.g. no data date); absent when it ran. */
  skipped?: string;
  /** For a check scored as an index (BEI): its value (null when nothing to divide by) and DCMA's minimum. */
  index?: { value: number | null; min: number };
  /** For a pass/fail test (the critical path test): whether it passed. */
  test?: { passed: boolean };
};

export type FloatBin = { id: string; label: string; count: number };

export type CheckReport = {
  p6Version: string | null;
  exportDate: string | null;
  projects: { id: string; shortName: string; name: string; dataDate: string | null }[];
  tables: { name: string; rows: number }[];
  counts: {
    activities: number;
    checked: number;
    complete: number;
    excluded: number;
    relationships: number;
    noFloatValue: number;
  };
  brokenRows: BrokenRow[];
  checks: CheckResult[];
  floatHistogram: FloatBin[];
};

export function checkSchedule(parsed: ParsedXer): CheckReport {
  const brokenRows: BrokenRow[] = [...parsed.brokenRows];
  const rowsOf = (table: string) => parsed.tables.get(table)?.rows ?? [];
  const hasTable = (table: string) => parsed.tables.has(table);
  const flag = (
    table: string,
    row: XerRow,
    kind: BrokenRow["kind"],
    field: string | null,
    reason: string
  ) => brokenRows.push({ table, line: row.line, rowNumber: row.rowNumber, kind, field, reason });

  // Calendars: hours in a working day.
  const hoursPerDay = new Map<string, number>();
  for (const row of rowsOf("CALENDAR")) {
    const id = row.values.clndr_id;
    const hours = Number(row.values.day_hr_cnt);
    if (!id) {
      flag("CALENDAR", row, "value", "clndr_id", "Calendar has no clndr_id");
      continue;
    }
    if (!isNumber(row.values.day_hr_cnt) || hours <= 0) {
      flag(
        "CALENDAR",
        row,
        "value",
        "day_hr_cnt",
        `Hours per day "${row.values.day_hr_cnt}" is not a positive number; ${FALLBACK_HOURS_PER_DAY} is used`
      );
      hoursPerDay.set(id, FALLBACK_HOURS_PER_DAY);
      continue;
    }
    hoursPerDay.set(id, hours);
  }

  const calendarNames = new Map(rowsOf("CALENDAR").map(row => [row.values.clndr_id, row.values.clndr_name]));
  const globalDefault =
    rowsOf("CALENDAR").find(row => row.values.default_flag === "Y" && hoursPerDay.has(row.values.clndr_id))
      ?.values.clndr_id ?? null;
  const projectDefaults = new Map(
    rowsOf("PROJECT").map(row => [
      row.values.proj_id,
      hoursPerDay.has(row.values.clndr_id) ? row.values.clndr_id : globalDefault,
    ])
  );
  /** The project's default calendar (PROJECT.clndr_id), else the database default (default_flag). */
  const defaultCalendar = (projectId: string | undefined) =>
    (projectId && projectDefaults.get(projectId)) || globalDefault;
  const describeCalendar = (id: string | null) =>
    id
      ? `the project's default calendar ${id}${calendarNames.get(id) ? ` (${calendarNames.get(id)})` : ""}, ${hoursPerDay.get(id)} h/day,`
      : `${FALLBACK_HOURS_PER_DAY} h/day`;

  const wbsIds = new Set(rowsOf("PROJWBS").map(row => row.values.wbs_id));

  // Activities.
  const activities = new Map<string, Activity>();
  /** Each activity's hard constraints, as "Finish on or before 2026-03-01". */
  const hardConstraints = new Map<string, string[]>();
  /** The data date of each project (PROJECT.last_recalc_date), as "YYYY-MM-DD HH:MM". */
  const dataDates = new Map(
    rowsOf("PROJECT")
      .filter(row => DATE.test(row.values.last_recalc_date ?? ""))
      .map(row => [row.values.proj_id ?? "", normalizeDate(row.values.last_recalc_date)])
  );
  const onlyDataDate = dataDates.size === 1 ? [...dataDates.values()][0] : undefined;
  /** Activities whose project has a data date, with the dates that are wrong against it. */
  const invalidDates = new Map<string, string[]>();
  /** What the critical path test needs to know about each activity. */
  const pathActivities = new Map<string, PathActivity>();
  /** Remaining duration in working days (original duration when there is no remaining value). */
  const remainingDays = new Map<string, number>();
  for (const row of rowsOf("TASK")) {
    const v = row.values;
    if (!v.task_id) {
      flag("TASK", row, "value", "task_id", "Activity has no task_id, so it cannot be linked or checked");
      continue;
    }
    if (activities.has(v.task_id)) {
      flag("TASK", row, "duplicate", "task_id", `task_id ${v.task_id} is used by an earlier row; this row is skipped`);
      continue;
    }
    if (!v.task_code) flag("TASK", row, "value", "task_code", "Activity has no activity ID (task_code)");
    if (!STATUSES.has(v.status_code))
      flag("TASK", row, "value", "status_code", `Unknown status "${v.status_code}"`);
    for (const field of TASK_DATE_FIELDS) {
      const value = v[field];
      if (value && !DATE.test(value)) flag("TASK", row, "value", field, `"${value}" is not a date`);
    }
    if (hasTable("PROJWBS") && v.wbs_id && !wbsIds.has(v.wbs_id))
      flag("TASK", row, "reference", "wbs_id", `WBS ${v.wbs_id} does not exist in PROJWBS`);

    // A blank calendar means the project's default one, as in P6.
    const fallback = defaultCalendar(v.proj_id);
    let calendar: string | null = v.clndr_id || fallback;
    if (v.clndr_id && !hoursPerDay.has(v.clndr_id)) {
      flag(
        "TASK",
        row,
        "reference",
        "clndr_id",
        `Calendar ${v.clndr_id} does not exist in CALENDAR; ${describeCalendar(fallback)} is used`
      );
      calendar = fallback;
    } else if (!calendar) {
      flag("TASK", row, "reference", "clndr_id", `Activity has no calendar and the project has no default; ${FALLBACK_HOURS_PER_DAY} h/day is used`);
    }

    let totalFloatDays: number | null = null;
    const floatHours = v.total_float_hr_cnt;
    if (floatHours !== undefined && floatHours !== "") {
      if (isNumber(floatHours)) {
        const perDay = (calendar && hoursPerDay.get(calendar)) || FALLBACK_HOURS_PER_DAY;
        totalFloatDays = round(Number(floatHours) / perDay, 2);
      } else {
        flag("TASK", row, "value", "total_float_hr_cnt", `Total float "${floatHours}" is not a number`);
      }
    }

    const hard = [
      [v.cstr_type, v.cstr_date],
      [v.cstr_type2, v.cstr_date2],
    ]
      .filter(([type]) => type && HARD_CONSTRAINTS[type])
      .map(([type, date]) => [HARD_CONSTRAINTS[type!], date?.slice(0, 10)].filter(Boolean).join(" "));
    if (hard.length > 0) hardConstraints.set(v.task_id, hard);

    // A blank remaining duration falls back to the original one; a bad one is flagged.
    const dataDate = (v.proj_id && dataDates.get(v.proj_id)) || onlyDataDate;
    if (dataDate) {
      const date = (field: string) => (DATE.test(v[field] ?? "") ? normalizeDate(v[field]) : null);
      const shown = dataDate.slice(0, 10);
      const problems: string[] = [];
      // Actual dates are history: none can be after the data date.
      for (const [field, label] of [["act_start_date", "Actual start"], ["act_end_date", "Actual finish"]]) {
        const d = date(field);
        if (d && d > dataDate) problems.push(`${label} ${d.slice(0, 10)} is after the data date ${shown}`);
      }
      // Forecast dates are the future: unfinished work cannot be planned before the data date.
      const forecasts =
        v.status_code === "TK_NotStart"
          ? [["early_start_date", "Forecast start"], ["early_end_date", "Forecast finish"]]
          : v.status_code === "TK_Active"
            ? [["early_end_date", "Forecast finish"]]
            : [];
      for (const [field, label] of forecasts) {
        const d = date(field);
        if (d && d < dataDate) problems.push(`${label} ${d.slice(0, 10)} is before the data date ${shown}`);
      }
      invalidDates.set(v.task_id, problems);
    }

    const durationField = v.remain_drtn_hr_cnt ? "remain_drtn_hr_cnt" : "target_drtn_hr_cnt";
    if (isNumber(v[durationField])) {
      const perDay = (calendar && hoursPerDay.get(calendar)) || FALLBACK_HOURS_PER_DAY;
      remainingDays.set(v.task_id, round(Number(v[durationField]) / perDay, 2));
    } else if (v[durationField]) {
      flag("TASK", row, "value", durationField, `Duration "${v[durationField]}" is not a number`);
    }

    pathActivities.set(v.task_id, {
      taskId: v.task_id,
      type: v.task_type ?? "",
      status: v.status_code ?? "",
      earlyStart: DATE.test(v.early_start_date ?? "") ? normalizeDate(v.early_start_date) : null,
      earlyFinish: DATE.test(v.early_end_date ?? "") ? normalizeDate(v.early_end_date) : null,
      totalFloatHours: isNumber(floatHours) ? Number(floatHours) : null,
      mandatory: [v.cstr_type, v.cstr_type2].some(c => c === "CS_MANDSTART" || c === "CS_MANDFIN"),
      line: row.line,
    });

    activities.set(v.task_id, {
      taskId: v.task_id,
      code: v.task_code || `(task_id ${v.task_id})`,
      name: v.task_name ?? "",
      type: v.task_type ?? "",
      status: v.status_code ?? "",
      calendar,
      totalFloatDays,
      predecessors: 0,
      successors: 0,
      line: row.line,
    });
  }

  // Relationships: only links whose both ends exist count.
  let relationships = 0;
  const links: { pred: Activity; succ: Activity; type: string; lagDays: number; line: number }[] = [];
  for (const row of rowsOf("TASKPRED")) {
    const { task_id: succ, pred_task_id: pred, pred_type: type, lag_hr_cnt: lag } = row.values;
    const succActivity = succ ? activities.get(succ) : undefined;
    const predActivity = pred ? activities.get(pred) : undefined;
    if (!succActivity || !predActivity) {
      const missing = [
        !predActivity && `predecessor ${pred || "(blank)"}`,
        !succActivity && `successor ${succ || "(blank)"}`,
      ].filter(Boolean);
      flag(
        "TASKPRED",
        row,
        "reference",
        !predActivity ? "pred_task_id" : "task_id",
        `Link points to an activity that is not in TASK (${missing.join(", ")}); the link is ignored`
      );
      continue;
    }
    if (succ === pred) {
      flag("TASKPRED", row, "value", "pred_task_id", `Activity ${succActivity.code} is linked to itself; the link is ignored`);
      continue;
    }
    if (type && !LINK_TYPES.has(type)) flag("TASKPRED", row, "value", "pred_type", `Unknown link type "${type}"`);
    if (lag && !isNumber(lag)) flag("TASKPRED", row, "value", "lag_hr_cnt", `Lag "${lag}" is not a number`);
    predActivity.successors++;
    succActivity.predecessors++;
    relationships++;
    const lagHours = isNumber(lag) ? Number(lag) : 0;
    const perDay = (predActivity.calendar && hoursPerDay.get(predActivity.calendar)) || FALLBACK_HOURS_PER_DAY;
    links.push({ pred: predActivity, succ: succActivity, type: type ?? "", lagDays: round(lagHours / perDay, 2), line: row.line });
  }

  const all = [...activities.values()];
  const checked = all.filter(a => a.status !== "TK_Complete" && !EXCLUDED_TYPES.has(a.type));
  const withFloat = checked.filter(a => a.totalFloatDays !== null);
  const checkedIds = new Set(checked.map(a => a.taskId));
  const checkedLinks = links.filter(l => checkedIds.has(l.pred.taskId) || checkedIds.has(l.succ.taskId));
  const linkResult = (l: (typeof links)[number], detail: string): CheckedLink => ({
    predCode: l.pred.code,
    predName: l.pred.name,
    succCode: l.succ.code,
    succName: l.succ.name,
    type: l.type,
    lagDays: l.lagDays,
    line: l.line,
    detail,
  });

  const missingLinks = checked
    .filter(a => a.predecessors === 0 || a.successors === 0)
    .map(a => ({
      ...a,
      detail:
        a.predecessors === 0 && a.successors === 0
          ? "No predecessor and no successor"
          : a.predecessors === 0
            ? "No predecessor"
            : "No successor",
    }));
  const leads = checkedLinks
    .filter(l => l.lagDays < 0)
    .sort((a, b) => a.lagDays - b.lagDays)
    .map(l => linkResult(l, `${formatDays(l.lagDays)} lag`));
  const lags = checkedLinks
    .filter(l => l.lagDays > 0)
    .sort((a, b) => b.lagDays - a.lagDays)
    .map(l => linkResult(l, `${formatDays(l.lagDays)} lag`));
  const nonFinishToStart = checkedLinks
    .filter(l => l.type !== "PR_FS")
    .map(l => linkResult(l, NON_FS_DETAIL[l.type] ?? `Unknown type "${l.type}"`));
  const constrained = checked
    .filter(a => hardConstraints.has(a.taskId))
    .map(a => ({ ...a, detail: hardConstraints.get(a.taskId)!.join("; ") }));
  const withDuration = checked.filter(a => !MILESTONES.has(a.type) && remainingDays.has(a.taskId));
  const highDuration = withDuration
    .filter(a => remainingDays.get(a.taskId)! > HIGH_DURATION_DAYS)
    .sort((a, b) => remainingDays.get(b.taskId)! - remainingDays.get(a.taskId)!)
    .map(a => ({ ...a, detail: `${formatDays(remainingDays.get(a.taskId)!)} remaining` }));
  // Resources: a resource or role (TASKRSRC) or an expense (PROJCOST) counts as assigned.
  const assignmentRows = [...rowsOf("TASKRSRC"), ...rowsOf("PROJCOST")];
  const assigned = new Set(assignmentRows.map(row => row.values.task_id));
  const needResources = checked.filter(a => !MILESTONES.has(a.type) && (remainingDays.get(a.taskId) ?? 0) > 0);
  const unresourced =
    assignmentRows.length === 0
      ? []
      : needResources
          .filter(a => !assigned.has(a.taskId))
          .map(a => ({ ...a, detail: "No resource, role or expense assigned" }));

  // Missed tasks: needs each project's baseline (PROJECT.sum_base_proj_id) exported in the same
  // file. P6's planned dates are no stand-in: on unstarted work they move with the early dates.
  const projectIds = new Set(rowsOf("PROJECT").map(row => row.values.proj_id));
  const baselineOf = new Map(
    rowsOf("PROJECT")
      .map(row => [row.values.proj_id, row.values.sum_base_proj_id] as const)
      .filter(([id, base]) => base && base !== id && projectIds.has(base))
  );
  const baselineIds = new Set(baselineOf.values());
  /** A task's finish as the baseline recorded it: actual if it was done, else forecast. */
  const finishOf = (v: Record<string, string>) =>
    [v.act_end_date, v.early_end_date, v.target_end_date].find(d => d && DATE.test(d));
  const baselineFinish = new Map<string, string>();
  for (const row of rowsOf("TASK")) {
    const finish = finishOf(row.values);
    if (baselineIds.has(row.values.proj_id) && finish)
      baselineFinish.set(`${row.values.proj_id}|${row.values.task_code}`, normalizeDate(finish));
  }
  const dueByDataDate: Activity[] = [];
  const missed: CheckResult["activities"] = [];
  const dueNotFinished: CheckResult["activities"] = [];
  /** Activities in the baseline that are finished, whenever the baseline had them due (BEI's numerator). */
  let finishedInBaseline = 0;
  for (const row of rowsOf("TASK")) {
    const v = row.values;
    const activity = activities.get(v.task_id);
    const base = baselineOf.get(v.proj_id);
    const dataDate = dataDates.get(v.proj_id);
    if (!activity || activity.line !== row.line || !base || !dataDate || EXCLUDED_TYPES.has(activity.type)) continue;
    const planned = baselineFinish.get(`${base}|${v.task_code}`);
    if (!planned) continue;
    const actual = DATE.test(v.act_end_date ?? "") ? normalizeDate(v.act_end_date) : null;
    if (actual && actual <= dataDate) finishedInBaseline++;
    if (planned > dataDate) continue;
    dueByDataDate.push(activity);
    if (!actual) dueNotFinished.push({ ...activity, detail: `Baseline finish ${planned.slice(0, 10)}; not finished` });
    if (!actual || actual > planned)
      missed.push({
        ...activity,
        detail: `Baseline finish ${planned.slice(0, 10)}; ${actual ? `finished ${actual.slice(0, 10)}` : "not finished"}`,
      });
  }
  const missedSkipped =
    baselineOf.size === 0
      ? "The file has no baseline project. Export the baseline with the schedule to run this check."
      : dataDates.size === 0
        ? "The file has no data date to compare against."
        : undefined;

  // Critical path test (critical-path.ts).
  const criticalHours = Number(rowsOf("PROJECT")[0]?.values.critical_drtn_hr_cnt);
  const pathTest = criticalPathTest(
    pathActivities,
    links.map(l => ({ pred: l.pred.taskId, succ: l.succ.taskId, type: l.type })),
    Number.isFinite(criticalHours) ? criticalHours : 0
  );
  const LINK_NAME: Record<string, string> = { PR_FS: "FS", PR_SS: "SS", PR_FF: "FF", PR_SF: "SF" };
  const ran = "passed" in pathTest ? pathTest : null;

  // CPLI: (critical path length + the finish's total float) ÷ critical path length, in working days
  // on the finish's calendar, from the data date to its forecast finish.
  const calendars = new Map<string, WorkCalendar | null>(
    rowsOf("CALENDAR").map(row => [row.values.clndr_id, parseCalendar(row.values.clndr_data)])
  );
  const finish = projectFinish(pathActivities);
  const finishActivity = finish && activities.get(finish.taskId)!;
  const finishProject = finish && rowsOf("TASK").find(row => row.line === finish.line)?.values.proj_id;
  const cplDataDate = (finishProject && dataDates.get(finishProject)) || onlyDataDate;
  const cpl =
    finish && cplDataDate
      ? workingDaysBetween(calendars.get(finishActivity!.calendar ?? "") ?? null, cplDataDate, finish.earlyFinish!)
      : 0;
  const finishFloat = finishActivity?.totalFloatDays ?? null;
  const cpli = cpl > 0 && finishFloat !== null ? round((cpl + finishFloat) / cpl, 2) : null;
  const cpliSkipped = !finish
    ? "No unfinished activity has a forecast finish."
    : !cplDataDate
      ? "The file has no data date to measure the critical path from."
      : finishFloat === null
        ? "The finish activity has no total float."
        : cpl <= 0
          ? "The finish is not after the data date."
          : undefined;
  const pathRows: CheckResult["activities"] = !ran
    ? []
    : ran.passed
      ? ran.path.map(step => ({
          ...activities.get(step.taskId)!,
          detail:
            step.taskId === ran.start
              ? "Delay added here (first critical activity)"
              : `${step.taskId === ran.finish ? "Project finish, pushed" : "Pushed"} by ${LINK_NAME[step.via ?? ""] ?? step.via} from ${activities.get(step.from!)!.code}`,
        }))
      : [
          {
            ...activities.get(ran.start)!,
            detail: `Delay added here (first critical activity)${ran.stops.length === 0 ? "; it has no successor to pass it on" : ""}`,
          },
          ...ran.stops.map(stop => ({ ...activities.get(stop.taskId)!, detail: stop.reason })),
          { ...activities.get(ran.finish)!, detail: "Project finish: the delay never reaches it" },
        ];

  const dated = all.filter(a => !EXCLUDED_TYPES.has(a.type) && invalidDates.has(a.taskId));
  const badDates = dated
    .filter(a => invalidDates.get(a.taskId)!.length > 0)
    .map(a => ({ ...a, detail: invalidDates.get(a.taskId)!.join("; ") }));
  const negativeFloat = withFloat
    .filter(a => a.totalFloatDays! < 0)
    .sort((a, b) => a.totalFloatDays! - b.totalFloatDays!)
    .map(a => ({ ...a, detail: `${formatDays(a.totalFloatDays!)} total float` }));
  const highFloat = withFloat
    .filter(a => a.totalFloatDays! > HIGH_FLOAT_DAYS)
    .sort((a, b) => b.totalFloatDays! - a.totalFloatDays!)
    .map(a => ({ ...a, detail: `${formatDays(a.totalFloatDays!)} total float` }));

  const result = (
    id: CheckId,
    dcma: number,
    name: string,
    rule: string,
    failing: CheckResult["activities"] | CheckedLink[],
    subject: CheckResult["subject"],
    denominator: number
  ): CheckResult => ({
    id,
    dcma,
    name,
    rule,
    subject,
    count: failing.length,
    denominator,
    pct: denominator === 0 ? 0 : round((failing.length / denominator) * 100, 1),
    activities: subject === "activities" ? (failing as CheckResult["activities"]) : [],
    links: subject === "relationships" ? (failing as CheckedLink[]) : [],
  });

  return {
    p6Version: parsed.header?.p6Version ?? null,
    exportDate: parsed.header?.exportDate ?? null,
    projects: rowsOf("PROJECT").map(row => {
      const id = row.values.proj_id ?? "";
      // The project's full name is on its root WBS node, not on PROJECT.
      const root = rowsOf("PROJWBS").find(
        wbs => wbs.values.proj_id === id && wbs.values.proj_node_flag === "Y"
      );
      return {
        id,
        shortName: row.values.proj_short_name ?? "",
        name: root?.values.wbs_name || row.values.proj_short_name || "",
        dataDate: row.values.last_recalc_date || null,
      };
    }),
    tables: [...parsed.tables.values()].map(t => ({ name: t.name, rows: t.rowCount })),
    counts: {
      activities: all.length,
      checked: checked.length,
      complete: all.filter(a => a.status === "TK_Complete").length,
      excluded: all.filter(a => a.status !== "TK_Complete" && EXCLUDED_TYPES.has(a.type)).length,
      relationships,
      noFloatValue: checked.length - withFloat.length,
    },
    brokenRows: brokenRows.sort((a, b) => a.line - b.line),
    checks: [
      result(
        "missing_links",
        1,
        "Missing links",
        "Activity has no predecessor, no successor, or neither",
        missingLinks,
        "activities",
        checked.length
      ),
      result(
        "leads",
        2,
        "Leads",
        "Relationship has a negative lag (a lead)",
        leads,
        "relationships",
        checkedLinks.length
      ),
      result(
        "lags",
        3,
        "Lags",
        "Relationship has a positive lag",
        lags,
        "relationships",
        checkedLinks.length
      ),
      result(
        "relationship_types",
        4,
        "Relationship types",
        "Relationship is not finish-to-start",
        nonFinishToStart,
        "relationships",
        checkedLinks.length
      ),
      result(
        "hard_constraints",
        5,
        "Hard constraints",
        "Activity has a constraint that fixes its date regardless of logic",
        constrained,
        "activities",
        checked.length
      ),
      result(
        "high_float",
        6,
        "High float",
        `Total float above ${HIGH_FLOAT_DAYS} working days`,
        highFloat,
        "activities",
        withFloat.length
      ),
      result(
        "negative_float",
        7,
        "Negative float",
        "Total float below 0 working days",
        negativeFloat,
        "activities",
        withFloat.length
      ),
      result(
        "high_duration",
        8,
        "High duration",
        `Remaining duration above ${HIGH_DURATION_DAYS} working days`,
        highDuration,
        "activities",
        withDuration.length
      ),
      {
        ...result(
          "invalid_dates",
          9,
          "Invalid dates",
          "Actual date after the data date, or forecast date before it",
          badDates,
          "activities",
          dated.length
        ),
        ...(dataDates.size === 0 && { skipped: "The file has no data date to compare against." }),
      },
      {
        ...result(
          "resources",
          10,
          "Resources",
          "Activity with remaining work has no resource, role or expense",
          unresourced,
          "activities",
          assignmentRows.length === 0 ? 0 : needResources.length
        ),
        ...(assignmentRows.length === 0 && { skipped: "The file has no resource or expense assignments." }),
      },
      {
        ...result(
          "missed_tasks",
          11,
          "Missed tasks",
          "Due by the data date in the baseline, but finished late or not at all",
          missed,
          "activities",
          dueByDataDate.length
        ),
        ...(missedSkipped && { skipped: missedSkipped }),
      },
      {
        ...result(
          "critical_path_test",
          12,
          "Critical path test",
          "A large delay on the first critical activity must move the project finish",
          pathRows,
          "activities",
          1
        ),
        count: ran && !ran.passed ? 1 : 0,
        pct: ran && !ran.passed ? 100 : 0,
        ...(ran ? { test: { passed: ran.passed } } : { skipped: (pathTest as { skipped: string }).skipped }),
      },
      {
        ...result(
          "cpli",
          13,
          "Critical path length (CPLI)",
          `(Critical path length + finish float) ÷ critical path length; at least ${MIN_CPLI}`,
          cpli === null
            ? []
            : [
                {
                  ...finishActivity!,
                  detail: `${cpl} working days from the data date ${cplDataDate!.slice(0, 10)} to the finish, with ${formatDays(finishFloat!)} of float: CPLI ${cpli}`,
                },
              ],
          "activities",
          1
        ),
        count: cpli !== null && cpli < MIN_CPLI ? 1 : 0,
        pct: cpli !== null && cpli < MIN_CPLI ? 100 : 0,
        index: { value: cpli, min: MIN_CPLI },
        ...(cpliSkipped && { skipped: cpliSkipped }),
      },
      {
        ...result(
          "bei",
          14,
          "Baseline execution (BEI)",
          `Activities finished ÷ activities the baseline had due by the data date; at least ${MIN_BEI}`,
          dueNotFinished,
          "activities",
          dueByDataDate.length
        ),
        index: {
          value: dueByDataDate.length === 0 ? null : round(finishedInBaseline / dueByDataDate.length, 2),
          min: MIN_BEI,
        },
        ...(missedSkipped && { skipped: missedSkipped }),
      },
    ],
    floatHistogram: floatHistogram(withFloat.map(a => a.totalFloatDays!)),
  };
}

/** Bands of total float in working days, matching the two float checks' thresholds. */
export function floatHistogram(days: number[]): FloatBin[] {
  const bins: (FloatBin & { test: (d: number) => boolean })[] = [
    { id: "negative", label: "< 0", count: 0, test: d => d < 0 },
    { id: "zero", label: "0", count: 0, test: d => d === 0 },
    { id: "1-10", label: "0–10", count: 0, test: d => d > 0 && d <= 10 },
    { id: "11-20", label: "10–20", count: 0, test: d => d > 10 && d <= 20 },
    { id: "21-44", label: `20–${HIGH_FLOAT_DAYS}`, count: 0, test: d => d > 20 && d <= HIGH_FLOAT_DAYS },
    { id: "high", label: `> ${HIGH_FLOAT_DAYS}`, count: 0, test: d => d > HIGH_FLOAT_DAYS },
  ];
  for (const d of days) bins.find(bin => bin.test(d))!.count++;
  return bins.map(({ id, label, count }) => ({ id, label, count }));
}

function isNumber(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value));
}

/** "2026-03-01" or "2026-03-01 08:00:00" as "2026-03-01 08:00", so dates compare as text. */
function normalizeDate(value: string): string {
  return value.length === 10 ? `${value} 00:00` : value.slice(0, 16);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function formatDays(days: number): string {
  const value = round(days, 1);
  return `${value} working day${Math.abs(value) === 1 ? "" : "s"}`;
}
