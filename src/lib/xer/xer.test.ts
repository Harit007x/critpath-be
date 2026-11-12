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
  });

  it("flags every activity in groupdocs-sample.xer as unlinked", () => {
    const report = sample("groupdocs-sample.xer");
    expect(report.counts.activities).toBe(70);
    expect(report.counts.relationships).toBe(0);
    expect(check(report, "missing_links").count).toBe(70);
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
