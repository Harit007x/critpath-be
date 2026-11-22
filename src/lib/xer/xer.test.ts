import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { checkSchedule, floatHistogram } from "./checks";
import { checkXer } from "./index";
import { parseXer } from "./parse";

/** Builds an XER from tables, ending each line with a tab as P6 does. */
function xer(tables: Record<string, string[][]>, header = "ERMHDR\t8.3\t2026-11-01"): string {
  const lines = [header];
  for (const [name, [fields, ...rows]] of Object.entries(tables)) {
    lines.push(`%T\t${name}`, `%F\t${fields.join("\t")}\t`);
    for (const row of rows) lines.push(`%R\t${row.join("\t")}\t`);
  }
  lines.push("%E");
  return lines.join("\r\n");
}

const CALENDAR = [
  ["clndr_id", "day_hr_cnt"],
  ["1", "8"],
  ["2", "10"],
];
const TASK_FIELDS = ["task_id", "clndr_id", "task_code", "task_name", "task_type", "status_code", "total_float_hr_cnt"];
const PRED_FIELDS = ["task_pred_id", "task_id", "pred_task_id", "pred_type", "lag_hr_cnt"];

const run = (text: string) => checkSchedule(parseXer(text));
const check = (report: ReturnType<typeof run>, id: string) => report.checks.find(c => c.id === id)!;

describe("parseXer", () => {
  it("reads tables and ignores P6's trailing tab", () => {
    const parsed = parseXer(xer({ CALENDAR }));
    expect(parsed.fatal).toEqual(["This export has no activities (no TASK table) to check."]);
    expect(parsed.tables.get("CALENDAR")!.fields).toEqual(["clndr_id", "day_hr_cnt"]);
    expect(parsed.tables.get("CALENDAR")!.rows[1].values).toEqual({ clndr_id: "2", day_hr_cnt: "10" });
    expect(parsed.brokenRows).toEqual([]);
  });

  it("rejects a file without an ERMHDR header", () => {
    expect(parseXer("hello\tworld").fatal).toEqual(["This isn't a Primavera P6 export (.xer)."]);
  });

  it("rejects an empty file with one plain reason", () => {
    expect(parseXer("").fatal).toEqual(["This file is empty."]);
    expect(parseXer("\uFEFF \r\n").fatal).toEqual(["This file is empty."]);
  });

  it("flags rows with too few or too many values, with their line and row number", () => {
    const text = [
      "ERMHDR\t8.3",
      "%T\tTASK",
      "%F\ttask_id\ttask_code\t",
      "%R\t1\tA100\t",
      "%R\t2",
      "%R\t3\tA300\textra\t",
      "%E",
    ].join("\n");
    const parsed = parseXer(text);
    expect(parsed.tables.get("TASK")!.rows.map(r => r.values.task_id)).toEqual(["1"]);
    expect(parsed.tables.get("TASK")!.rowCount).toBe(3);
    expect(parsed.brokenRows).toEqual([
      expect.objectContaining({ table: "TASK", line: 5, rowNumber: 2, reason: "Row has 1 values but the table has 2 fields" }),
      expect.objectContaining({ table: "TASK", line: 6, rowNumber: 3, reason: "Row has 3 values but the table has 2 fields" }),
    ]);
  });

  it("flags rows outside a table and unknown lines", () => {
    const parsed = parseXer(["ERMHDR\t8.3", "%R\t1", "garbage", "%T\tTASK", "%R\t1", "%E"].join("\n"));
    expect(parsed.brokenRows.map(r => r.reason)).toEqual([
      "%R row before any %T table",
      'Unrecognised line (starts with "garbage")',
      "Row before the table's %F field list",
    ]);
  });
});

describe("checkSchedule", () => {
  // A100 → A200 → A300 in a chain; A400 is unlinked; A500 is complete; A600 is level of effort.
  const schedule = xer({
    CALENDAR,
    TASK: [
      TASK_FIELDS,
      ["1", "1", "A100", "Start", "TT_Mile", "TK_NotStart", "0"],
      ["2", "2", "A200", "Pour", "TT_Task", "TK_Active", "-40"], // -4 days on a 10 h calendar
      ["3", "1", "A300", "Finish", "TT_FinMile", "TK_NotStart", "360"], // 45 days on 8 h
      ["4", "1", "A400", "Loose", "TT_Task", "TK_NotStart", "352"], // exactly 44 days: not high
      ["5", "1", "A500", "Done", "TT_Task", "TK_Complete", "-80"],
      ["6", "1", "A600", "Supervision", "TT_LOE", "TK_NotStart", "-8"],
    ],
    TASKPRED: [PRED_FIELDS, ["1", "2", "1", "PR_FS", "0"], ["2", "3", "2", "PR_FS", "0"]],
  });
  const report = run(schedule);

  it("checks incomplete activities and leaves out complete and level-of-effort ones", () => {
    expect(report.counts).toEqual({
      activities: 6,
      checked: 4,
      complete: 1,
      excluded: 1,
      relationships: 2,
      noFloatValue: 0,
    });
  });

  it("finds missing predecessors and successors", () => {
    const missing = check(report, "missing_links");
    expect(missing.activities.map(a => [a.code, a.detail])).toEqual([
      ["A100", "No predecessor"],
      ["A300", "No successor"],
      ["A400", "No predecessor and no successor"],
    ]);
    expect(missing.denominator).toBe(4);
    expect(missing.pct).toBe(75);
  });

  it("converts float with each activity's own calendar", () => {
    const negative = check(report, "negative_float");
    expect(negative.activities.map(a => [a.code, a.totalFloatDays])).toEqual([["A200", -4]]);
  });

  it("counts float above 44 working days as high, and exactly 44 as not", () => {
    const high = check(report, "high_float");
    expect(high.activities.map(a => [a.code, a.totalFloatDays])).toEqual([["A300", 45]]);
  });

  it("bins float into the chart's bands", () => {
    expect(report.floatHistogram.map(b => [b.label, b.count])).toEqual([
      ["< 0", 1],
      ["0", 1],
      ["0–10", 0],
      ["10–20", 0],
      ["20–44", 1],
      ["> 44", 1],
    ]);
  });

  it("flags bad values and broken links, and ignores the broken links", () => {
    const broken = run(
      xer({
        CALENDAR: [
          ["clndr_id", "day_hr_cnt", "default_flag"],
          ["1", "8", "Y"],
          ["3", "zero", "N"],
        ],
        TASK: [
          [...TASK_FIELDS, "early_start_date"],
          ["1", "1", "A100", "Start", "TT_Task", "TK_NotStart", "abc", "2026-13-xx"],
          ["1", "1", "A100b", "Duplicate", "TT_Task", "TK_NotStart", "0", ""],
          ["2", "9", "A200", "Unknown calendar", "TT_Task", "Running", "16", ""],
          ["3", "", "A300", "Blank calendar", "TT_Task", "TK_NotStart", "16", ""],
        ],
        TASKPRED: [PRED_FIELDS, ["1", "2", "99", "PR_FS", "0"], ["2", "2", "1", "PR_XX", "x"]],
      })
    );
    expect(broken.brokenRows.map(r => [r.table, r.kind, r.field])).toEqual([
      ["CALENDAR", "value", "day_hr_cnt"],
      ["TASK", "value", "early_start_date"],
      ["TASK", "value", "total_float_hr_cnt"],
      ["TASK", "duplicate", "task_id"],
      ["TASK", "value", "status_code"],
      ["TASK", "reference", "clndr_id"],
      ["TASKPRED", "reference", "pred_task_id"],
      ["TASKPRED", "value", "pred_type"],
      ["TASKPRED", "value", "lag_hr_cnt"],
    ]);
    expect(broken.brokenRows.find(r => r.field === "clndr_id")!.reason).toBe(
      "Calendar 9 does not exist in CALENDAR; the project's default calendar 1, 8 h/day, is used"
    );
    expect(broken.counts.relationships).toBe(1);
    expect(broken.counts.noFloatValue).toBe(1);
  });
});

describe("hard constraints", () => {
  const FIELDS = [...TASK_FIELDS, "cstr_type", "cstr_date", "cstr_type2", "cstr_date2"];
  const report = run(
    xer({
      CALENDAR,
      TASK: [
        FIELDS,
        ["1", "1", "A100", "Fixed", "TT_Task", "TK_NotStart", "0", "CS_MEOB", "2026-03-01 17:00", "", ""],
        ["2", "1", "A200", "Two", "TT_Task", "TK_Active", "0", "CS_MSOA", "2026-01-01 08:00", "CS_MANDFIN", "2026-04-01 17:00"],
        ["3", "1", "A300", "Soft only", "TT_Task", "TK_NotStart", "0", "CS_ALAP", "", "", ""],
        ["4", "1", "A400", "Done", "TT_Task", "TK_Complete", "0", "CS_MSO", "2025-01-01 08:00", "", ""],
        ["5", "1", "A500", "Free", "TT_Task", "TK_NotStart", "0", "", "", "", ""],
      ],
    })
  );

  it("counts open activities with a hard constraint, primary or secondary, and ignores soft ones", () => {
    const hard = check(report, "hard_constraints");
    expect(hard).toMatchObject({ dcma: 5, subject: "activities", count: 2, denominator: 4, pct: 50 });
    expect(hard.activities.map(a => [a.code, a.detail])).toEqual([
      ["A100", "Finish on or before 2026-03-01"],
      ["A200", "Mandatory finish 2026-04-01"],
    ]);
  });
});

describe("high duration", () => {
  const FIELDS = [...TASK_FIELDS, "remain_drtn_hr_cnt", "target_drtn_hr_cnt"];
  const report = run(
    xer({
      CALENDAR,
      TASK: [
        FIELDS,
        ["1", "1", "A100", "Long", "TT_Task", "TK_NotStart", "0", "360", "360"], // 45 days on 8 h
        ["2", "1", "A200", "Exactly 44", "TT_Task", "TK_NotStart", "0", "352", "352"],
        ["3", "2", "A300", "Long on 10 h", "TT_Task", "TK_Active", "0", "500", "900"], // 50 days left of 90
        ["4", "2", "A400", "Short now", "TT_Task", "TK_Active", "0", "100", "900"], // 10 days left of 90
        ["5", "1", "A500", "No remaining", "TT_Task", "TK_NotStart", "0", "", "400"], // falls back: 50 days
        ["6", "1", "A600", "Milestone", "TT_FinMile", "TK_NotStart", "0", "0", "0"],
        ["7", "1", "A700", "Done", "TT_Task", "TK_Complete", "0", "0", "800"],
        ["8", "1", "A800", "Bad", "TT_Task", "TK_NotStart", "0", "lots", ""],
      ],
    })
  );

  it("counts open non-milestones with more than 44 working days remaining, on their own calendar", () => {
    const high = check(report, "high_duration");
    expect(high).toMatchObject({ dcma: 8, subject: "activities", count: 3, denominator: 5, pct: 60 });
    expect(high.activities.map(a => [a.code, a.detail])).toEqual([
      ["A300", "50 working days remaining"],
      ["A500", "50 working days remaining"],
      ["A100", "45 working days remaining"],
    ]);
  });

  it("flags a duration that is not a number", () => {
    expect(report.brokenRows.map(r => [r.field, r.reason])).toContainEqual([
      "remain_drtn_hr_cnt",
      'Duration "lots" is not a number',
    ]);
  });
});

describe("invalid dates", () => {
  const FIELDS = [...TASK_FIELDS, "proj_id", "act_start_date", "act_end_date", "early_start_date", "early_end_date"];
  const tasks = [
    FIELDS,
    ["1", "1", "A100", "Fine", "TT_Task", "TK_NotStart", "0", "P1", "", "", "2026-06-01 08:00", "2026-06-05 17:00"],
    ["2", "1", "A200", "Late forecast", "TT_Task", "TK_NotStart", "0", "P1", "", "", "2026-05-20 08:00", "2026-06-05 17:00"],
    ["3", "1", "A300", "Future actual", "TT_Task", "TK_Active", "0", "P1", "2026-06-02 08:00", "", "2026-06-01 08:00", "2026-05-30 17:00"],
    ["4", "1", "A400", "Done later", "TT_Task", "TK_Complete", "0", "P1", "2026-05-01 08:00", "2026-06-03 17:00", "", ""],
    ["5", "1", "A500", "Done", "TT_Task", "TK_Complete", "0", "P1", "2026-05-01 08:00", "2026-05-10 17:00", "", ""],
    ["6", "1", "A600", "Same day", "TT_Task", "TK_NotStart", "0", "P1", "", "", "2026-06-01", "2026-06-01 17:00"],
    ["7", "1", "A700", "LOE", "TT_LOE", "TK_NotStart", "0", "P1", "", "", "2020-01-01 08:00", "2020-01-01 17:00"],
  ];
  const withProject = (dataDate: string) =>
    run(xer({ CALENDAR, PROJECT: [["proj_id", "proj_short_name", "last_recalc_date"], ["P1", "P1", dataDate]], TASK: tasks }));

  it("flags actual dates after the data date and forecast dates before it, complete activities included", () => {
    const invalid = check(withProject("2026-06-01 00:00"), "invalid_dates");
    expect(invalid).toMatchObject({ dcma: 9, subject: "activities", count: 3, denominator: 6 });
    expect(invalid.skipped).toBeUndefined();
    expect(invalid.activities.map(a => [a.code, a.detail])).toEqual([
      ["A200", "Forecast start 2026-05-20 is before the data date 2026-06-01"],
      [
        "A300",
        "Actual start 2026-06-02 is after the data date 2026-06-01; Forecast finish 2026-05-30 is before the data date 2026-06-01",
      ],
      ["A400", "Actual finish 2026-06-03 is after the data date 2026-06-01"],
    ]);
  });

  it("is skipped, not passed, when the file has no data date", () => {
    const invalid = check(withProject(""), "invalid_dates");
    expect(invalid).toMatchObject({ count: 0, denominator: 0, skipped: "The file has no data date to compare against." });
  });
});

describe("resources", () => {
  const FIELDS = [...TASK_FIELDS, "remain_drtn_hr_cnt"];
  const TASK = [
    FIELDS,
    ["1", "1", "A100", "Staffed", "TT_Task", "TK_NotStart", "0", "40"],
    ["2", "1", "A200", "Nobody", "TT_Task", "TK_Active", "0", "16"],
    ["3", "1", "A300", "Expense only", "TT_Task", "TK_NotStart", "0", "8"],
    ["4", "1", "A400", "No work left", "TT_Task", "TK_Active", "0", "0"],
    ["5", "1", "A500", "Milestone", "TT_FinMile", "TK_NotStart", "0", "0"],
    ["6", "1", "A600", "Done", "TT_Task", "TK_Complete", "0", "0"],
  ];

  it("flags activities with remaining work and no resource, role or expense", () => {
    const report = run(
      xer({
        CALENDAR,
        TASK,
        TASKRSRC: [["taskrsrc_id", "task_id", "rsrc_id"], ["1", "1", "10"]],
        PROJCOST: [["cost_item_id", "task_id"], ["1", "3"]],
      })
    );
    const resources = check(report, "resources");
    expect(resources).toMatchObject({ dcma: 10, subject: "activities", count: 1, denominator: 3 });
    expect(resources.activities.map(a => a.code)).toEqual(["A200"]);
  });

  it("is skipped when the file carries no resources or expenses at all", () => {
    const resources = check(run(xer({ CALENDAR, TASK })), "resources");
    expect(resources).toMatchObject({ count: 0, denominator: 0, skipped: "The file has no resource or expense assignments." });
  });
});

describe("missed tasks", () => {
  const PROJECT = [
    ["proj_id", "proj_short_name", "last_recalc_date", "sum_base_proj_id"],
    ["P1", "Current", "2026-06-01 00:00", "B1"],
    ["B1", "Baseline", "2026-01-01 00:00", ""],
  ];
  const FIELDS = [...TASK_FIELDS, "proj_id", "act_end_date", "early_end_date"];
  const TASK = [
    FIELDS,
    // The current schedule.
    ["1", "1", "A100", "On time", "TT_Task", "TK_Complete", "0", "P1", "2026-04-30 17:00", ""],
    ["2", "1", "A200", "Late", "TT_Task", "TK_Complete", "0", "P1", "2026-05-15 17:00", ""],
    ["3", "1", "A300", "Not done", "TT_Task", "TK_Active", "0", "P1", "", "2026-06-10 17:00"],
    ["4", "1", "A400", "Not due", "TT_Task", "TK_NotStart", "0", "P1", "", "2026-07-10 17:00"],
    ["5", "1", "A500", "Added since", "TT_Task", "TK_NotStart", "0", "P1", "", "2026-06-10 17:00"],
    ["6", "1", "A600", "LOE", "TT_LOE", "TK_Active", "0", "P1", "", "2026-06-10 17:00"],
    // Its baseline: finishes as planned back then.
    ["11", "1", "A100", "On time", "TT_Task", "TK_NotStart", "0", "B1", "", "2026-05-01 17:00"],
    ["12", "1", "A200", "Late", "TT_Task", "TK_NotStart", "0", "B1", "", "2026-05-01 17:00"],
    ["13", "1", "A300", "Not done", "TT_Task", "TK_NotStart", "0", "B1", "", "2026-05-20 17:00"],
    ["14", "1", "A400", "Not due", "TT_Task", "TK_NotStart", "0", "B1", "", "2026-06-20 17:00"],
    ["16", "1", "A600", "LOE", "TT_LOE", "TK_NotStart", "0", "B1", "", "2026-05-01 17:00"],
  ];

  it("compares finishes with the baseline project in the same file", () => {
    const missed = check(run(xer({ CALENDAR, PROJECT, TASK })), "missed_tasks");
    expect(missed).toMatchObject({ dcma: 11, subject: "activities", count: 2, denominator: 3 });
    expect(missed.skipped).toBeUndefined();
    expect(missed.activities.map(a => [a.code, a.detail])).toEqual([
      ["A200", "Baseline finish 2026-05-01; finished 2026-05-15"],
      ["A300", "Baseline finish 2026-05-20; not finished"],
    ]);
  });

  it("scores BEI as finished ÷ due, counting work finished ahead of the baseline", () => {
    const early = [...TASK, ["7", "1", "A700", "Early", "TT_Task", "TK_Complete", "0", "P1", "2026-05-20 17:00", ""]];
    early.push(["17", "1", "A700", "Early", "TT_Task", "TK_NotStart", "0", "B1", "", "2026-08-01 17:00"]);
    const bei = check(run(xer({ CALENDAR, PROJECT, TASK: early })), "bei");
    // Due: A100, A200, A300. Finished: A100, A200 and A700 (early) → 3 / 3.
    expect(bei).toMatchObject({ dcma: 14, count: 1, denominator: 3, index: { value: 1, min: 0.95 } });
    expect(bei.activities.map(a => [a.code, a.detail])).toEqual([["A300", "Baseline finish 2026-05-20; not finished"]]);
    // Without the early finish: 2 / 3.
    expect(check(run(xer({ CALENDAR, PROJECT, TASK })), "bei").index).toEqual({ value: 0.67, min: 0.95 });
  });

  it("is skipped when the baseline is not in the file", () => {
    const noBaseline = PROJECT.map(row => row.slice(0, 3));
    const report = run(xer({ CALENDAR, PROJECT: noBaseline, TASK }));
    expect(check(report, "missed_tasks")).toMatchObject({ count: 0, denominator: 0 });
    expect(check(report, "missed_tasks").skipped).toMatch(/no baseline project/);
    expect(check(report, "bei")).toMatchObject({ index: { value: null }, skipped: expect.stringMatching(/no baseline/) });
  });
});

describe("critical path test", () => {
  const FIELDS = [...TASK_FIELDS, "early_start_date", "early_end_date", "cstr_type"];
  // A100 → A200 → A400 (finish) is critical; A300 has float and offers a shorter way round.
  const task = (id: string, code: string, type: string, float: string, start: string, end: string, cstr = "") => [
    id, "1", code, code, type, "TK_NotStart", float, start, end, cstr,
  ];
  const TASK = [
    FIELDS,
    task("1", "A100", "TT_Task", "0", "2026-06-01 08:00", "2026-06-05 17:00"),
    task("2", "A200", "TT_Task", "0", "2026-06-08 08:00", "2026-06-12 17:00"),
    task("3", "A300", "TT_Task", "40", "2026-06-08 08:00", "2026-06-09 17:00"),
    task("4", "A400", "TT_FinMile", "0", "2026-06-12 17:00", "2026-06-12 17:00"),
  ];
  const test = (links: string[][], tasks = TASK) =>
    check(run(xer({ CALENDAR, TASK: tasks, TASKPRED: [PRED_FIELDS, ...links] })), "critical_path_test");

  it("passes when the delay reaches the finish, and shows the critical path it took", () => {
    const result = test([
      ["1", "2", "1", "PR_FS", "0"],
      ["2", "4", "2", "PR_FS", "0"],
      ["3", "3", "1", "PR_FS", "0"],
      ["4", "4", "3", "PR_FS", "0"],
    ]);
    expect(result).toMatchObject({ dcma: 12, test: { passed: true }, count: 0 });
    expect(result.activities.map(a => [a.code, a.detail])).toEqual([
      ["A100", "Delay added here (first critical activity)"],
      ["A200", "Pushed by FS from A100"],
      ["A400", "Project finish, pushed by FS from A200"],
    ]);
  });

  it("fails when a mandatory constraint holds the delay back", () => {
    const tasks = TASK.map(row => (row[2] === "A200" ? [...row.slice(0, 9), "CS_MANDSTART"] : row));
    const result = test([["1", "2", "1", "PR_FS", "0"], ["2", "4", "2", "PR_FS", "0"]], tasks);
    expect(result).toMatchObject({ test: { passed: false }, count: 1 });
    expect(result.activities.map(a => [a.code, a.detail])).toEqual([
      ["A100", "Delay added here (first critical activity)"],
      ["A200", "Mandatory constraint holds it in place"],
      ["A400", "Project finish: the delay never reaches it"],
    ]);
  });

  it("does not carry a longer duration through a start-to-start link", () => {
    const result = test([["1", "2", "1", "PR_SS", "0"], ["2", "4", "2", "PR_FS", "0"]]);
    expect(result.test).toEqual({ passed: false });
    expect(result.activities[0].detail).toBe("Delay added here (first critical activity); it has no successor to pass it on");
  });

  it("scores CPLI from the data date to the finish, in working days on the finish's calendar", () => {
    const PROJECT = [["proj_id", "proj_short_name", "last_recalc_date"], ["P1", "P1", "2026-06-01 00:00"]];
    // A400 (finish) on calendar 1, Monday to Friday by default: 2026-06-01 to 06-12 is 10 working days.
    const withFloat = (hours: string) =>
      TASK.map((row, i) => (i === 0 ? [...row, "proj_id"] : [...row.slice(0, 6), row[2] === "A400" ? hours : row[6], ...row.slice(7), "P1"]));
    const cpli = (hours: string) =>
      check(run(xer({ CALENDAR, PROJECT, TASK: withFloat(hours), TASKPRED: [PRED_FIELDS] })), "cpli");

    expect(cpli("16")).toMatchObject({ dcma: 13, count: 0, index: { value: 1.2, min: 0.95 } }); // (10 + 2) / 10
    expect(cpli("16").activities.map(a => [a.code, a.detail])).toEqual([
      ["A400", "10 working days from the data date 2026-06-01 to the finish, with 2 working days of float: CPLI 1.2"],
    ]);
    expect(cpli("-8")).toMatchObject({ count: 1, index: { value: 0.9 } }); // (10 - 1) / 10
    expect(cpli("0").index).toEqual({ value: 1, min: 0.95 });
  });

  it("skips CPLI without a data date", () => {
    const cpli = check(run(xer({ CALENDAR, TASK })), "cpli");
    expect(cpli).toMatchObject({ index: { value: null }, skipped: "The file has no data date to measure the critical path from." });
  });

  it("is skipped when nothing unfinished has a forecast finish", () => {
    const noDates = TASK.map((row, i) => (i === 0 ? row : [...row.slice(0, 7), "", "", ""]));
    const result = test([], noDates);
    expect(result.skipped).toBe("No unfinished activity has a forecast finish.");
    expect(result.test).toBeUndefined();
  });
});

describe("relationship checks", () => {
  // A100 (8 h) → A200 (10 h) → A300; A400 is complete; A500 is level of effort.
  const links = (rows: string[][]) =>
    run(
      xer({
        CALENDAR,
        TASK: [
          TASK_FIELDS,
          ["1", "1", "A100", "Start", "TT_Task", "TK_NotStart", "0"],
          ["2", "2", "A200", "Pour", "TT_Task", "TK_NotStart", "0"],
          ["3", "1", "A300", "Finish", "TT_FinMile", "TK_NotStart", "0"],
          ["4", "1", "A400", "Done", "TT_Task", "TK_Complete", "0"],
          ["5", "1", "A500", "Supervision", "TT_LOE", "TK_NotStart", "0"],
          ["6", "1", "A600", "Also done", "TT_Task", "TK_Complete", "0"],
        ],
        TASKPRED: [PRED_FIELDS, ...rows],
      })
    );

  it("finds leads, converting lag on the predecessor's calendar", () => {
    const report = links([
      ["1", "2", "1", "PR_FS", "-16"], // A100 → A200: -2 days on 8 h
      ["2", "3", "2", "PR_SS", "-40"], // A200 → A300: -4 days on 10 h
      ["3", "3", "1", "PR_FS", "8"], // a lag, not a lead
      ["4", "2", "4", "PR_FS", "0"], // complete → open: still checked
    ]);
    const leads = check(report, "leads");
    expect(leads).toMatchObject({ dcma: 2, subject: "relationships", count: 2, denominator: 4, pct: 50, activities: [] });
    expect(leads.links.map(l => [l.predCode, l.succCode, l.type, l.lagDays, l.detail])).toEqual([
      ["A200", "A300", "PR_SS", -4, "-4 working days lag"],
      ["A100", "A200", "PR_FS", -2, "-2 working days lag"],
    ]);
  });

  it("finds lags, largest first", () => {
    const report = links([
      ["1", "2", "1", "PR_FS", "8"], // 1 day on 8 h
      ["2", "3", "2", "PR_FS", "50"], // 5 days on 10 h
      ["3", "3", "1", "PR_FS", "-8"], // a lead, not a lag
      ["4", "3", "1", "PR_SS", "0"],
    ]);
    const lags = check(report, "lags");
    expect(lags).toMatchObject({ dcma: 3, count: 2, denominator: 4, pct: 50 });
    expect(lags.links.map(l => [l.predCode, l.succCode, l.lagDays])).toEqual([
      ["A200", "A300", 5],
      ["A100", "A200", 1],
    ]);
  });

  it("lists every link that is not finish-to-start", () => {
    const report = links([
      ["1", "2", "1", "PR_FS", "0"],
      ["2", "3", "2", "PR_SS", "0"],
      ["3", "3", "1", "PR_FF", "0"],
      ["4", "3", "1", "PR_SF", "0"],
    ]);
    const types = check(report, "relationship_types");
    expect(types).toMatchObject({ dcma: 4, count: 3, denominator: 4, pct: 75 });
    expect(types.links.map(l => [l.type, l.detail])).toEqual([
      ["PR_SS", "Start to start"],
      ["PR_FF", "Finish to finish"],
      ["PR_SF", "Start to finish (rarely valid)"],
    ]);
  });

  it("leaves out links whose both ends are complete or level of effort", () => {
    const report = links([
      ["1", "6", "4", "PR_FS", "-8"], // complete → complete
      ["2", "4", "5", "PR_FS", "-8"], // LOE → complete
    ]);
    for (const id of ["leads", "lags", "relationship_types"])
      expect(check(report, id)).toMatchObject({ count: 0, denominator: 0, pct: 0 });
    expect(report.counts.relationships).toBe(2);
  });

  it("gives every check its DCMA number, in DCMA order", () => {
    expect(links([]).checks.map(c => [c.dcma, c.id, c.subject])).toEqual([
      [1, "missing_links", "activities"],
      [2, "leads", "relationships"],
      [3, "lags", "relationships"],
      [4, "relationship_types", "relationships"],
      [5, "hard_constraints", "activities"],
      [6, "high_float", "activities"],
      [7, "negative_float", "activities"],
      [8, "high_duration", "activities"],
      [9, "invalid_dates", "activities"],
      [10, "resources", "activities"],
      [11, "missed_tasks", "activities"],
      [12, "critical_path_test", "activities"],
      [13, "cpli", "activities"],
      [14, "bei", "activities"],
    ]);
  });
});

describe("floatHistogram", () => {
  it("puts each value in exactly one band", () => {
    const bins = floatHistogram([-0.5, 0, 0.1, 10, 10.1, 20, 44, 44.01]);
    expect(bins.map(b => b.count)).toEqual([1, 1, 2, 2, 1, 1]);
  });
});

describe("the bundled samples", () => {
  const sample = (file: string) => checkXer(readFileSync(path.join(__dirname, "../../../samples", file)), file);

  it("reads events-example.xer cleanly", () => {
    const report = sample("events-example.xer");
    expect(report.p6Version).toBe("8.3");
    expect(report.projects[0].shortName).toBe("EventsExample2002");
    expect(report.counts.activities).toBe(83);
    expect(report.counts.relationships).toBe(86);
    expect(report.brokenRows).toEqual([]);
    expect(check(report, "negative_float").count).toBe(0);
    expect(check(report, "high_float").count).toBe(5);
    expect(check(report, "leads")).toMatchObject({ count: 0, denominator: 86 });
    expect(check(report, "lags").count).toBe(0);
    expect(check(report, "relationship_types").links.map(l => l.type)).toEqual(Array(5).fill("PR_SS"));
    expect(check(report, "invalid_dates").skipped).toBe("The file has no data date to compare against.");
    expect(check(report, "resources")).toMatchObject({ count: 3, denominator: 78 });
  });

  it("flags every activity in groupdocs-sample.xer as unlinked", () => {
    const report = sample("groupdocs-sample.xer");
    expect(report.counts.activities).toBe(70);
    expect(report.counts.relationships).toBe(0);
    expect(check(report, "missing_links").count).toBe(70);
    expect(check(report, "resources").skipped).toBe("The file has no resource or expense assignments.");
    // Every activity points at calendar -1, which the file does not define.
    expect(report.brokenRows).toHaveLength(70);
    expect(report.brokenRows[0].reason).toBe(
      "Calendar -1 does not exist in CALENDAR; the project's default calendar 1 (Standard), 8 h/day, is used"
    );
  });

  it("refuses a file that is not XER", () => {
    expect(() => checkXer(Buffer.from("name,start\nA,2026-01-01"), "x.xer")).toThrow(/isn.t a Primavera P6 export/);
  });
});
