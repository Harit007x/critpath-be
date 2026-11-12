/**
 * The schedule checks. Every number here is plain code over the parsed file; nothing is estimated.
 *
 * Which activities are checked: those not yet complete (status other than TK_Complete), leaving out
 * level-of-effort (TT_LOE) and WBS summary (TT_WBS) activities, which take their dates from other
 * activities and are not expected to carry logic of their own (DCMA 14-point convention).
 *
 * Float is stored in hours in an XER. It is turned into days with each activity's own calendar
 * (CALENDAR.day_hr_cnt), never a fixed 8 hours: a 10-hour-day calendar has 10 hours in a day.
 */
import type { BrokenRow, ParsedXer, XerRow } from "./parse";

/** DCMA 14-point check 6: more than 44 working days of total float is "high". */
export const HIGH_FLOAT_DAYS = 44;
/** Used only when an activity's calendar is missing or has no hours per day (reported as broken). */
export const FALLBACK_HOURS_PER_DAY = 8;

const STATUSES = new Set(["TK_NotStart", "TK_Active", "TK_Complete"]);
const LINK_TYPES = new Set(["PR_FS", "PR_SS", "PR_FF", "PR_SF"]);
const EXCLUDED_TYPES = new Set(["TT_LOE", "TT_WBS"]);
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

export type CheckId = "missing_links" | "negative_float" | "high_float";

export type CheckResult = {
  id: CheckId;
  name: string;
  rule: string;
  /** Activities that fail the check. */
  count: number;
  /** Activities the check looked at. */
  denominator: number;
  pct: number;
  activities: (Activity & { detail: string })[];
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
  }

  const all = [...activities.values()];
  const checked = all.filter(a => a.status !== "TK_Complete" && !EXCLUDED_TYPES.has(a.type));
  const withFloat = checked.filter(a => a.totalFloatDays !== null);

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
    name: string,
    rule: string,
    failing: CheckResult["activities"],
    denominator: number
  ): CheckResult => ({
    id,
    name,
    rule,
    count: failing.length,
    denominator,
    pct: denominator === 0 ? 0 : round((failing.length / denominator) * 100, 1),
    activities: failing,
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
        "Missing links",
        "Activity has no predecessor, no successor, or neither",
        missingLinks,
        checked.length
      ),
      result("negative_float", "Negative float", "Total float below 0 working days", negativeFloat, withFloat.length),
      result(
        "high_float",
        "High float",
        `Total float above ${HIGH_FLOAT_DAYS} working days`,
        highFloat,
        withFloat.length
      ),
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

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function formatDays(days: number): string {
  const value = round(days, 1);
  return `${value} working day${Math.abs(value) === 1 ? "" : "s"}`;
}
