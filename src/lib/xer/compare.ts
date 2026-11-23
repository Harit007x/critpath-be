/**
 * Compares two exports of the same schedule, such as last week's update and this week's: which
 * activities and relationships were added, deleted or changed, how far the project finish moved,
 * and how each DCMA check came out in each.
 *
 * Activities are matched by activity ID (TASK.task_code), as planners and P6's own comparison do.
 * task_id is the database's key, and changes when a schedule is exported from another database or
 * restored from a copy. Relationships are matched by their two activity IDs, then by type: an
 * activity pair linked once in each file with a different type is a changed link, not a deleted one
 * and an added one.
 *
 * Each file is read on its own into a small snapshot (`snapshotOf`), so two 50 MB files are never
 * held parsed at the same time. Baseline projects exported alongside the schedule are left out, as
 * in the dashboard.
 */
import { FALLBACK_HOURS_PER_DAY, checkSchedule, type CheckId, type CheckReport } from "./checks";
import type { ParsedXer, XerRow } from "./parse";

/** What can change on an activity, in the order they are listed. */
export const ACTIVITY_FIELDS = [
  // What the activity is: changes here are edits to the plan.
  "name",
  "wbs",
  "type",
  "calendar",
  "originalDuration",
  "constraint",
  // Progress recorded in the update.
  "status",
  "actualStart",
  "actualFinish",
  "remainingDuration",
  "percentComplete",
  // What the schedule worked out from the two above.
  "start",
  "finish",
  "totalFloat",
  "critical",
] as const;

export type ActivityField = (typeof ACTIVITY_FIELDS)[number];

/** plan: the activity was edited; progress: the update recorded progress; dates: the schedule moved. */
export const FIELD_GROUP: Record<ActivityField, "plan" | "progress" | "dates"> = {
  name: "plan",
  wbs: "plan",
  type: "plan",
  calendar: "plan",
  originalDuration: "plan",
  constraint: "plan",
  status: "progress",
  actualStart: "progress",
  actualFinish: "progress",
  remainingDuration: "progress",
  percentComplete: "progress",
  start: "dates",
  finish: "dates",
  totalFloat: "dates",
  critical: "dates",
};

type Value = string | number | boolean | null;

/** One activity as the comparison sees it. Dates are "YYYY-MM-DD"; durations and float are working days. */
export type ActivitySnapshot = {
  code: string;
  name: string;
  /** WBS codes from the top, joined with dots ("AREA-A.L1"). */
  wbs: string;
  type: string;
  calendar: string | null;
  originalDuration: number | null;
  /** "Finish on or before 2026-03-01", both constraints joined; null when none. */
  constraint: string | null;
  status: string;
  actualStart: string | null;
  actualFinish: string | null;
  remainingDuration: number | null;
  /** The percent P6 shows for the activity's percent complete type; null for units percent. */
  percentComplete: number | null;
  /** Actual start, else early start. */
  start: string | null;
  /** Actual finish, else early finish. */
  finish: string | null;
  totalFloat: number | null;
  critical: boolean;
};

export type LinkSnapshot = {
  pred: string;
  succ: string;
  /** PR_FS, PR_SS, PR_FF or PR_SF. */
  type: string;
  /** Working days on the predecessor's calendar. */
  lagDays: number;
};

/** One file reduced to what the comparison needs. */
export type ScheduleSnapshot = {
  projectName: string | null;
  dataDate: string | null;
  /** The latest finish of any activity. */
  finish: string | null;
  activities: Map<string, ActivitySnapshot>;
  links: LinkSnapshot[];
  /** Activity IDs used by more than one activity; only the first is compared. */
  duplicateCodes: number;
  report: Omit<CheckReport, "brokenRows"> & { brokenRowCount: number };
};

export type ComparedFile = {
  id: string;
  name: string;
  uploadedAt: string;
  projectName: string | null;
  dataDate: string | null;
  finish: string | null;
  activities: number;
  relationships: number;
  critical: number;
  brokenRows: number;
};

export type FieldChange = { field: ActivityField; from: Value; to: Value };

export type ActivityChange = {
  kind: "added" | "deleted" | "changed";
  code: string;
  /** From the later file, or the earlier one for a deleted activity. */
  name: string;
  wbs: string;
  type: string;
  status: string;
  /** Empty for an added or deleted activity. */
  changes: FieldChange[];
  finish: { from: string | null; to: string | null };
  /** Calendar days the finish moved: positive is later. Null unless both files have a finish. */
  finishDays: number | null;
  totalFloat: { from: number | null; to: number | null };
};

export type LinkChange = {
  kind: "added" | "deleted" | "changed";
  predCode: string;
  predName: string;
  succCode: string;
  succName: string;
  from: { type: string; lagDays: number } | null;
  to: { type: string; lagDays: number } | null;
};

/** How one check came out in each file, and which activities or links moved in or out of it. */
export type CheckChange = {
  id: CheckId | "broken_rows";
  dcma: number | null;
  name: string;
  subject: "activities" | "relationships" | "rows";
  from: CheckSide;
  to: CheckSide;
  /**
   * Activities or links that fail in the later file and did not in the earlier one. 0 for a check
   * that is one result (the critical path test, CPLI) or was skipped in either file.
   */
  newlyFailing: number;
  /** Activities or links that failed in the earlier file and no longer do (or are gone). */
  resolved: number;
};

type CheckSide = {
  count: number;
  pct: number | null;
  skipped?: string;
  index?: number | null;
  passed?: boolean;
};

export type ScheduleComparison = {
  from: ComparedFile;
  to: ComparedFile;
  summary: {
    /** Activities in both files. Few means these are probably different schedules. */
    matched: number;
    /**
     * Of those, how many kept their name. P6 numbers new activities A1000, A1010 and so on, so two
     * unrelated schedules can share most activity IDs; few names in common gives them away.
     */
    sameName: number;
    activities: { added: number; deleted: number; changed: number; unchanged: number };
    relationships: { added: number; deleted: number; changed: number; unchanged: number };
    /** How many activities changed each field. */
    fields: Record<ActivityField, number>;
    /** Calendar days the project finish moved: positive is later. */
    finishDays: number | null;
    duplicateCodes: { from: number; to: number };
  };
  checks: CheckChange[];
  /** Added, deleted and changed activities; unchanged ones are left out. */
  activities: ActivityChange[];
  links: LinkChange[];
};

const CONSTRAINT_LABEL: Record<string, string> = {
  CS_MSO: "Start on",
  CS_MSOA: "Start on or after",
  CS_MSOB: "Start on or before",
  CS_MEO: "Finish on",
  CS_MEOA: "Finish on or after",
  CS_MEOB: "Finish on or before",
  CS_ALAP: "As late as possible",
  CS_MANDSTART: "Mandatory start",
  CS_MANDFIN: "Mandatory finish",
};

/** Reduces a parsed file to what the comparison needs: its activities, links and check report. */
export function snapshotOf(parsed: ParsedXer): ScheduleSnapshot {
  const rowsOf = (table: string): XerRow[] => parsed.tables.get(table)?.rows ?? [];
  const { brokenRows, ...report } = checkSchedule(parsed);

  const projects = rowsOf("PROJECT");
  const baselineIds = new Set(projects.map(p => p.values.sum_base_proj_id).filter(Boolean));
  const own = projects.filter(p => !baselineIds.has(p.values.proj_id));
  const ownIds = new Set((own.length > 0 ? own : projects).map(p => p.values.proj_id));
  const main = own[0] ?? projects[0];
  const criticalHours = Math.max(Number(main?.values.critical_drtn_hr_cnt) || 0, 0);

  const calendars = new Map(
    rowsOf("CALENDAR").map(r => [
      r.values.clndr_id,
      { name: r.values.clndr_name || r.values.clndr_id, hours: Number(r.values.day_hr_cnt) > 0 ? Number(r.values.day_hr_cnt) : FALLBACK_HOURS_PER_DAY },
    ])
  );
  const defaultCalendar = main?.values.clndr_id ?? rowsOf("CALENDAR").find(r => r.values.default_flag === "Y")?.values.clndr_id;

  // WBS paths of short names, leaving out the project node at the top.
  const wbsRows = new Map(rowsOf("PROJWBS").map(r => [r.values.wbs_id, r]));
  const wbsPaths = new Map<string, string>();
  const wbsPath = (id: string, seen = new Set<string>()): string => {
    const known = wbsPaths.get(id);
    if (known !== undefined) return known;
    const row = wbsRows.get(id);
    if (!row || row.values.proj_node_flag === "Y" || seen.has(id)) return "";
    seen.add(id);
    const parent = wbsPath(row.values.parent_wbs_id, seen);
    const path = parent ? `${parent}.${row.values.wbs_short_name}` : row.values.wbs_short_name;
    wbsPaths.set(id, path);
    return path;
  };

  const activities = new Map<string, ActivitySnapshot>();
  const codeOf = new Map<string, string>();
  const hoursOf = new Map<string, number>();
  let duplicateCodes = 0;
  let finish: string | null = null;
  for (const r of rowsOf("TASK")) {
    const v = r.values;
    if (!ownIds.has(v.proj_id) || !v.task_code) continue;
    if (activities.has(v.task_code)) {
      duplicateCodes++;
      continue;
    }
    const calendar = calendars.get(v.clndr_id) ?? calendars.get(defaultCalendar ?? "");
    const perDay = calendar?.hours ?? FALLBACK_HOURS_PER_DAY;
    const days = (hours: string | undefined) => (isNumber(hours) ? round(Number(hours) / perDay) : null);
    const floatHours = isNumber(v.total_float_hr_cnt) ? Number(v.total_float_hr_cnt) : null;
    const snapshot: ActivitySnapshot = {
      code: v.task_code,
      name: v.task_name ?? "",
      wbs: wbsPath(v.wbs_id ?? ""),
      type: v.task_type ?? "",
      calendar: calendar?.name ?? null,
      originalDuration: days(v.target_drtn_hr_cnt),
      constraint: constraintOf(v),
      status: v.status_code ?? "",
      actualStart: date(v.act_start_date),
      actualFinish: date(v.act_end_date),
      remainingDuration: days(v.remain_drtn_hr_cnt),
      percentComplete: percentOf(v),
      start: date(v.act_start_date) ?? date(v.early_start_date),
      finish: date(v.act_end_date) ?? date(v.early_end_date),
      totalFloat: floatHours === null ? null : round(floatHours / perDay),
      critical: v.status_code !== "TK_Complete" && floatHours !== null && floatHours <= criticalHours,
    };
    activities.set(v.task_code, snapshot);
    codeOf.set(v.task_id, v.task_code);
    hoursOf.set(v.task_id, perDay);
    if (snapshot.finish && (!finish || snapshot.finish > finish)) finish = snapshot.finish;
  }

  // Links between two of the schedule's own activities; lag on the predecessor's calendar, as P6 does.
  const links: LinkSnapshot[] = [];
  for (const r of rowsOf("TASKPRED")) {
    const pred = codeOf.get(r.values.pred_task_id);
    const succ = codeOf.get(r.values.task_id);
    if (!pred || !succ) continue;
    const lag = Number(r.values.lag_hr_cnt);
    const perDay = hoursOf.get(r.values.pred_task_id) ?? FALLBACK_HOURS_PER_DAY;
    links.push({ pred, succ, type: r.values.pred_type ?? "", lagDays: Number.isFinite(lag) ? round(lag / perDay) : 0 });
  }

  const summary = report.projects.find(p => p.id === main?.values.proj_id) ?? report.projects[0];
  return {
    projectName: summary ? summary.name || summary.shortName || null : null,
    dataDate: date(main?.values.last_recalc_date),
    finish,
    activities,
    links,
    duplicateCodes,
    report: { ...report, brokenRowCount: brokenRows.length },
  };
}

/** Compares an earlier file (`a`) with a later one (`b`). Pure, for tests. */
export function compareSnapshots(
  a: ScheduleSnapshot,
  b: ScheduleSnapshot,
  files: { from: Omit<ComparedFile, keyof FileFacts>; to: Omit<ComparedFile, keyof FileFacts> }
): ScheduleComparison {
  const fields = Object.fromEntries(ACTIVITY_FIELDS.map(f => [f, 0])) as Record<ActivityField, number>;
  const activities: ActivityChange[] = [];
  const counts = { added: 0, deleted: 0, changed: 0, unchanged: 0 };
  let matched = 0;
  let sameName = 0;

  for (const [code, before] of a.activities) {
    const after = b.activities.get(code);
    if (!after) {
      counts.deleted++;
      activities.push(activityChange("deleted", before, null, []));
      continue;
    }
    matched++;
    if (before.name === after.name) sameName++;
    const changes: FieldChange[] = [];
    for (const field of ACTIVITY_FIELDS) {
      if (!same(before[field], after[field])) {
        changes.push({ field, from: before[field], to: after[field] });
        fields[field]++;
      }
    }
    if (changes.length === 0) {
      counts.unchanged++;
      continue;
    }
    counts.changed++;
    activities.push(activityChange("changed", before, after, changes));
  }
  for (const [code, after] of b.activities) {
    if (a.activities.has(code)) continue;
    counts.added++;
    activities.push(activityChange("added", null, after, []));
  }

  const { links, linkCounts } = compareLinks(a, b);

  return {
    from: { ...files.from, ...factsOf(a) },
    to: { ...files.to, ...factsOf(b) },
    summary: {
      matched,
      sameName,
      activities: counts,
      relationships: linkCounts,
      fields,
      finishDays: daysBetween(a.finish, b.finish),
      duplicateCodes: { from: a.duplicateCodes, to: b.duplicateCodes },
    },
    checks: compareChecks(a.report, b.report),
    activities,
    links,
  };
}

type FileFacts = Pick<
  ComparedFile,
  "projectName" | "dataDate" | "finish" | "activities" | "relationships" | "critical" | "brokenRows"
>;

function factsOf(s: ScheduleSnapshot): FileFacts {
  let critical = 0;
  for (const a of s.activities.values()) if (a.critical) critical++;
  return {
    projectName: s.projectName,
    dataDate: s.dataDate,
    finish: s.finish,
    activities: s.activities.size,
    relationships: s.links.length,
    critical,
    brokenRows: s.report.brokenRowCount,
  };
}

function activityChange(
  kind: ActivityChange["kind"],
  before: ActivitySnapshot | null,
  after: ActivitySnapshot | null,
  changes: FieldChange[]
): ActivityChange {
  const latest = (after ?? before)!;
  return {
    kind,
    code: latest.code,
    name: latest.name,
    wbs: latest.wbs,
    type: latest.type,
    status: latest.status,
    changes,
    finish: { from: before?.finish ?? null, to: after?.finish ?? null },
    finishDays: daysBetween(before?.finish ?? null, after?.finish ?? null),
    totalFloat: { from: before?.totalFloat ?? null, to: after?.totalFloat ?? null },
  };
}

function compareLinks(a: ScheduleSnapshot, b: ScheduleSnapshot) {
  const byPair = (links: LinkSnapshot[]) => {
    const map = new Map<string, LinkSnapshot[]>();
    for (const l of links) {
      const key = `${l.pred}\u0000${l.succ}`;
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    return map;
  };
  const before = byPair(a.links);
  const after = byPair(b.links);
  const nameIn = (code: string) => b.activities.get(code)?.name ?? a.activities.get(code)?.name ?? "";
  const links: LinkChange[] = [];
  const linkCounts = { added: 0, deleted: 0, changed: 0, unchanged: 0 };
  const push = (kind: LinkChange["kind"], from: LinkSnapshot | null, to: LinkSnapshot | null) => {
    const l = (to ?? from)!;
    linkCounts[kind]++;
    links.push({
      kind,
      predCode: l.pred,
      predName: nameIn(l.pred),
      succCode: l.succ,
      succName: nameIn(l.succ),
      from: from && { type: from.type, lagDays: from.lagDays },
      to: to && { type: to.type, lagDays: to.lagDays },
    });
  };

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = [...(before.get(key) ?? [])];
    const now = [...(after.get(key) ?? [])];
    // Same type on both sides: the same link, changed only if its lag did.
    for (let i = was.length - 1; i >= 0; i--) {
      const j = now.findIndex(l => l.type === was[i].type);
      if (j < 0) continue;
      if (same(was[i].lagDays, now[j].lagDays)) linkCounts.unchanged++;
      else push("changed", was[i], now[j]);
      was.splice(i, 1);
      now.splice(j, 1);
    }
    // One link left on each side: its type changed.
    if (was.length === 1 && now.length === 1) {
      push("changed", was[0], now[0]);
      continue;
    }
    for (const l of was) push("deleted", l, null);
    for (const l of now) push("added", null, l);
  }
  return { links, linkCounts };
}

type Report = ScheduleSnapshot["report"];

function compareChecks(a: Report, b: Report): CheckChange[] {
  const failing = (check: CheckReport["checks"][number] | undefined) =>
    new Set(
      check?.subject === "relationships"
        ? check.links.map(l => `${l.predCode}\u0000${l.succCode}\u0000${l.type}`)
        : (check?.activities ?? []).map(x => x.code)
    );
  const side = (check: CheckReport["checks"][number] | undefined): CheckSide =>
    check
      ? {
          count: check.count,
          pct: check.skipped ? null : check.pct,
          ...(check.skipped && { skipped: check.skipped }),
          ...(check.index && { index: check.index.value }),
          ...(check.test && { passed: check.test.passed }),
        }
      : { count: 0, pct: null, skipped: "Not in this file's report" };

  const ids = [...new Set([...a.checks.map(c => c.id), ...b.checks.map(c => c.id)])];
  const checks: CheckChange[] = ids.map(id => {
    const before = a.checks.find(c => c.id === id);
    const after = b.checks.find(c => c.id === id);
    const latest = (after ?? before)!;
    // The critical path test and CPLI list the activities that explain one result, not failures.
    const listsFailures = latest.test === undefined && latest.id !== "cpli" && !before?.skipped && !after?.skipped;
    const was = listsFailures ? failing(before) : new Set<string>();
    const now = listsFailures ? failing(after) : new Set<string>();
    return {
      id,
      dcma: latest.dcma,
      name: latest.name,
      subject: latest.subject,
      from: side(before),
      to: side(after),
      newlyFailing: [...now].filter(k => !was.has(k)).length,
      resolved: [...was].filter(k => !now.has(k)).length,
    };
  });
  checks.push({
    id: "broken_rows",
    dcma: null,
    name: "Broken rows",
    subject: "rows",
    from: { count: a.brokenRowCount, pct: null },
    to: { count: b.brokenRowCount, pct: null },
    newlyFailing: Math.max(b.brokenRowCount - a.brokenRowCount, 0),
    resolved: Math.max(a.brokenRowCount - b.brokenRowCount, 0),
  });
  return checks;
}

function constraintOf(v: Record<string, string>): string | null {
  const one = (type: string | undefined, when: string | undefined) => {
    if (!type) return null;
    const label = CONSTRAINT_LABEL[type] ?? type;
    const on = date(when);
    return on && type !== "CS_ALAP" ? `${label} ${on}` : label;
  };
  const parts = [one(v.cstr_type, v.cstr_date), one(v.cstr_type2, v.cstr_date2)].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** The percent complete P6 shows for the activity's percent complete type. */
function percentOf(v: Record<string, string>): number | null {
  if (v.complete_pct_type === "CP_Phys") return isNumber(v.phys_complete_pct) ? round(Number(v.phys_complete_pct)) : null;
  if (v.complete_pct_type === "CP_Drtn" || !v.complete_pct_type) {
    if (v.status_code === "TK_Complete") return 100;
    const total = Number(v.target_drtn_hr_cnt);
    const left = Number(v.remain_drtn_hr_cnt);
    if (!isNumber(v.target_drtn_hr_cnt) || !isNumber(v.remain_drtn_hr_cnt) || total <= 0) return null;
    return round(Math.min(Math.max(((total - left) / total) * 100, 0), 100));
  }
  return null;
}

/** "YYYY-MM-DD" from a P6 date ("YYYY-MM-DD HH:MM"), or null. The time of day is not compared. */
function date(value: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "");
  return m ? m[1] : null;
}

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Equal, allowing for the rounding of hours into days. */
function same(x: Value, y: Value): boolean {
  if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) < 0.01;
  return x === y;
}

function isNumber(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
