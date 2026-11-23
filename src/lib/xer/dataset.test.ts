import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { scheduleDataset } from "./dataset";
import { decodeXer, parseXer } from "./parse";

function xer(tables: Record<string, string[][]>): string {
  const lines = ["ERMHDR\t8.3\t2026-11-01"];
  for (const [name, [fields, ...rows]] of Object.entries(tables)) {
    lines.push(`%T\t${name}`, `%F\t${fields.join("\t")}\t`);
    for (const row of rows) lines.push(`%R\t${row.join("\t")}\t`);
  }
  lines.push("%E");
  return lines.join("\r\n");
}

const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

const schedule = () =>
  scheduleDataset(
    parseXer(
      xer({
        PROJECT: [
          ["proj_id", "proj_short_name", "sum_base_proj_id", "critical_drtn_hr_cnt", "last_recalc_date"],
          ["1", "MAIN", "9", "0", "2026-01-05 08:00"],
          ["9", "BASE", "", "0", "2025-12-01 08:00"],
        ],
        CALENDAR: [["clndr_id", "day_hr_cnt"], ["1", "10"]],
        PROJWBS: [
          ["wbs_id", "proj_id", "proj_node_flag", "wbs_short_name", "wbs_name", "parent_wbs_id"],
          ["100", "1", "Y", "MAIN", "Main project", ""],
          ["101", "1", "N", "A", "Area A", "100"],
          ["102", "1", "N", "A.1", "Level 1", "101"],
        ],
        TASK: [
          [
            "task_id", "proj_id", "wbs_id", "clndr_id", "task_code", "task_name", "task_type", "status_code",
            "total_float_hr_cnt", "target_drtn_hr_cnt", "remain_drtn_hr_cnt", "act_start_date",
            "early_start_date", "early_end_date", "late_end_date", "target_end_date",
          ],
          ["1", "1", "102", "1", "A100", "Pour slab", "TT_Task", "TK_Active", "0", "100", "50",
            "2026-01-02 08:00", "2026-01-05 08:00", "2026-01-09 17:00", "2026-01-09 17:00", "2026-01-08 17:00"],
          ["2", "1", "101", "1", "A200", "Strip forms", "TT_Task", "TK_NotStart", "-20", "30", "30",
            "", "2026-01-12 08:00", "2026-01-14 17:00", "2026-01-12 17:00", "2026-01-14 17:00"],
          ["3", "1", "101", "1", "LOE", "Supervision", "TT_LOE", "TK_Active", "0", "0", "0", "", "", "", "", ""],
          ["8", "9", "101", "1", "A100", "Pour slab (baseline)", "TT_Task", "TK_NotStart", "0", "100", "100",
            "", "2026-01-01 08:00", "2026-01-05 17:00", "", ""],
        ],
        ACTVTYPE: [
          ["actv_code_type_id", "actv_code_type", "seq_num"],
          ["50", "Building", "1"],
          ["51", "Unused", "2"],
        ],
        ACTVCODE: [
          ["actv_code_id", "parent_actv_code_id", "actv_code_type_id", "actv_code_name", "short_name", "seq_num"],
          ["500", "", "50", "Tower", "TWR", "1"],
          ["501", "", "50", "Podium", "POD", "2"],
        ],
        TASKACTV: [["task_id", "actv_code_type_id", "actv_code_id", "proj_id"], ["2", "50", "501", "1"]],
        RSRC: [["rsrc_id", "rsrc_name", "rsrc_type"], ["7", "Carpenter", "RT_Labor"]],
        TASKRSRC: [
          ["task_id", "rsrc_id", "target_qty", "remain_qty", "act_reg_qty", "act_ot_qty"],
          ["1", "7", "80", "40", "35", "5"],
          ["8", "7", "80", "80", "0", "0"],
        ],
        TASKPRED: [["task_pred_id", "task_id", "pred_task_id", "pred_type", "lag_hr_cnt"], ["1", "2", "1", "PR_FS", "0"]],
      })
    )
  );

describe("scheduleDataset", () => {
  it("keeps the schedule's own activities, not its baseline or LOE", () => {
    const d = schedule();
    expect(d.activities.count).toBe(2);
    expect(d.activities.code).toEqual(["A100", "A200"]);
    expect(d.project).toMatchObject({ shortName: "MAIN", dataDate: day("2026-01-05") });
  });

  it("gives float and durations in days on the activity's calendar, and dates as day numbers", () => {
    const { activities: a } = schedule();
    expect(a.totalFloat).toEqual([0, -2]);
    expect(a.originalDuration).toEqual([10, 3]);
    expect(a.remainingDuration).toEqual([5, 3]);
    // An activity that started shows its actual start; one that hasn't, its forecast.
    expect(a.start).toEqual([day("2026-01-02"), day("2026-01-12")]);
    expect(a.finish).toEqual([day("2026-01-09"), day("2026-01-14")]);
    expect(a.critical).toEqual([true, true]);
  });

  it("refers to the WBS and repeated strings by index", () => {
    const d = schedule();
    expect(d.wbs).toEqual([
      { name: "Area A", code: "A", parent: -1 },
      { name: "Level 1", code: "A.1", parent: 0 },
    ]);
    expect(d.activities.wbs).toEqual([1, 0]);
    expect(d.activities.status.map(i => d.dictionaries.status[i])).toEqual(["TK_Active", "TK_NotStart"]);
  });

  it("keeps only the activity code types in use, one column each", () => {
    const d = schedule();
    expect(d.codeTypes.map(t => t.name)).toEqual(["Building"]);
    expect(d.activities.codes).toEqual([[-1, 1]]);
    expect(d.codeTypes[0].values[1]).toEqual({ code: "POD", name: "Podium", parent: -1 });
  });

  it("marks each activity's DCMA findings as bits over the checks", () => {
    const d = schedule();
    const has = (i: number, id: string) => (d.activities.findings[i] & (1 << d.checks.findIndex(c => c.id === id))) !== 0;
    expect(has(1, "negative_float")).toBe(true);
    expect(has(0, "negative_float")).toBe(false);
  });

  it("lists resource assignments of the schedule's activities only", () => {
    const d = schedule();
    expect(d.resources).toEqual([{ name: "Carpenter", type: "RT_Labor" }]);
    expect(d.assignments).toEqual({
      count: 1,
      activity: [0],
      resource: [0],
      budgetUnits: [80],
      remainingUnits: [40],
      actualUnits: [40],
    });
  });

  it("reads a real sample", () => {
    const bytes = readFileSync(path.resolve(__dirname, "../../../samples/events-example.xer"));
    const d = scheduleDataset(parseXer(decodeXer(bytes)));
    expect(d.activities.count).toBe(83);
    expect(d.activities.code.length).toBe(83);
    expect(d.wbs.length).toBeGreaterThan(0);
  });
});
