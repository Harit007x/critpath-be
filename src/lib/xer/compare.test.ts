import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { compareSnapshots, snapshotOf } from "./compare";
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

const TASK_FIELDS = [
  "task_id", "proj_id", "wbs_id", "clndr_id", "task_code", "task_name", "task_type", "status_code",
  "total_float_hr_cnt", "target_drtn_hr_cnt", "remain_drtn_hr_cnt", "act_start_date", "act_end_date",
  "early_start_date", "early_end_date", "cstr_type", "cstr_date",
];
const PRED_FIELDS = ["task_pred_id", "task_id", "pred_task_id", "pred_type", "lag_hr_cnt"];

/** A small schedule; `tasks` and `links` replace the defaults when given. */
function schedule({ dataDate, tasks, links }: { dataDate: string; tasks: string[][]; links: string[][] }) {
  return snapshotOf(
    parseXer(
      xer({
        PROJECT: [
          ["proj_id", "proj_short_name", "sum_base_proj_id", "critical_drtn_hr_cnt", "last_recalc_date", "clndr_id"],
          ["1", "AIRPORT", "", "0", `${dataDate} 08:00`, "1"],
        ],
        CALENDAR: [["clndr_id", "clndr_name", "day_hr_cnt"], ["1", "5-day", "8"], ["2", "6-day 10h", "10"]],
        PROJWBS: [
          ["wbs_id", "proj_id", "proj_node_flag", "wbs_short_name", "wbs_name", "parent_wbs_id"],
          ["100", "1", "Y", "AIRPORT", "Airport", ""],
          ["101", "1", "N", "T1", "Terminal 1", "100"],
          ["102", "1", "N", "APR", "Apron", "100"],
        ],
        TASK: [TASK_FIELDS, ...tasks],
        TASKPRED: [PRED_FIELDS, ...links],
      })
    )
  );
}

const week1 = schedule({
  dataDate: "2026-11-02",
  tasks: [
    ["1", "1", "101", "1", "A100", "Excavate", "TT_Task", "TK_Active", "0", "80", "40", "2026-10-26 08:00", "", "", "2026-11-06 17:00", "", ""],
    ["2", "1", "101", "1", "A200", "Foundations", "TT_Task", "TK_NotStart", "0", "160", "160", "", "", "2026-11-09 08:00", "2026-11-20 17:00", "", ""],
    ["3", "1", "102", "1", "A300", "Apron paving", "TT_Task", "TK_NotStart", "80", "40", "40", "", "", "2026-11-09 08:00", "2026-11-13 17:00", "", ""],
    ["4", "1", "102", "1", "A400", "Old temp road", "TT_Task", "TK_NotStart", "40", "8", "8", "", "", "2026-11-09 08:00", "2026-11-09 17:00", "", ""],
    // A baseline copy's activities would share codes; this one is in project 1, so it is compared.
  ],
  links: [
    ["10", "2", "1", "PR_FS", "0"],
    ["11", "3", "1", "PR_SS", "16"],
    ["12", "4", "1", "PR_FS", "0"],
    ["13", "4", "3", "PR_FF", "0"],
  ],
});

const week2 = schedule({
  dataDate: "2026-11-09",
  tasks: [
    // Finished, three days late.
    ["1", "1", "101", "1", "A100", "Excavate", "TT_Task", "TK_Complete", "", "80", "0", "2026-10-26 08:00", "2026-11-11 17:00", "", "", "", ""],
    // Pushed by A100, original duration cut to hide it, and now critical (negative float).
    ["2", "1", "101", "1", "A200", "Foundations", "TT_Task", "TK_NotStart", "-24", "120", "120", "", "", "2026-11-12 08:00", "2026-11-24 17:00", "", ""],
    // Renamed and constrained; dates the same.
    ["3", "1", "102", "1", "A300", "Apron paving, stage 1", "TT_Task", "TK_NotStart", "80", "40", "40", "", "", "2026-11-09 08:00", "2026-11-13 17:00", "CS_MEOB", "2026-11-20 17:00"],
    // A400 deleted, A500 added.
    ["5", "1", "102", "2", "A500", "Apron lighting", "TT_Task", "TK_NotStart", "50", "50", "50", "", "", "2026-11-16 08:00", "2026-11-20 17:00", "", ""],
  ],
  links: [
    ["10", "2", "1", "PR_FS", "0"], // unchanged
    ["11", "3", "1", "PR_SS", "40"], // lag 2d -> 5d
    ["14", "5", "3", "PR_FS", "0"], // added
  ],
});

const compare = (a = week1, b = week2) =>
  compareSnapshots(a, b, {
    from: { id: "w1", name: "airport-w1.xer", uploadedAt: "2026-11-02T00:00:00.000Z" },
    to: { id: "w2", name: "airport-w2.xer", uploadedAt: "2026-11-09T00:00:00.000Z" },
  });

describe("compareSnapshots", () => {
  const result = compare();
  const activity = (code: string) => result.activities.find(a => a.code === code);
  const fieldsOf = (code: string) => activity(code)?.changes.map(c => c.field);

  it("counts added, deleted, changed and unchanged activities by activity ID", () => {
    expect(result.summary.matched).toBe(3);
    expect(result.summary.sameName).toBe(2);
    expect(result.summary.activities).toEqual({ added: 1, deleted: 1, changed: 3, unchanged: 0 });
    expect(activity("A400")).toMatchObject({ kind: "deleted", name: "Old temp road", changes: [] });
    expect(activity("A500")).toMatchObject({
      kind: "added",
      wbs: "APR",
      finish: { from: null, to: "2026-11-20" },
      totalFloat: { from: null, to: 5 },
    });
  });

  it("records each changed field with its value before and after", () => {
    // Complete, so no longer critical.
    expect(fieldsOf("A100")).toEqual([
      "status", "actualFinish", "remainingDuration", "percentComplete", "finish", "totalFloat", "critical",
    ]);
    expect(activity("A100")!.changes).toContainEqual({ field: "status", from: "TK_Active", to: "TK_Complete" });
    expect(activity("A100")).toMatchObject({ finishDays: 5, finish: { from: "2026-11-06", to: "2026-11-11" } });

    // Critical in both, so that is not a change.
    expect(fieldsOf("A200")).toEqual(["originalDuration", "remainingDuration", "start", "finish", "totalFloat"]);
    expect(activity("A200")!.changes).toContainEqual({ field: "originalDuration", from: 20, to: 15 });
    expect(activity("A200")!.changes).toContainEqual({ field: "totalFloat", from: 0, to: -3 });
  });

  it("flags renames and new constraints, and leaves the time of day out", () => {
    expect(activity("A300")!.changes).toEqual([
      { field: "name", from: "Apron paving", to: "Apron paving, stage 1" },
      { field: "constraint", from: null, to: "Finish on or before 2026-11-20" },
    ]);
  });

  it("matches links by their activities, so a lag change is one changed link", () => {
    expect(result.summary.relationships).toEqual({ added: 1, deleted: 2, changed: 1, unchanged: 1 });
    expect(result.links).toContainEqual(
      expect.objectContaining({
        kind: "changed",
        predCode: "A100",
        succCode: "A300",
        from: { type: "PR_SS", lagDays: 2 },
        to: { type: "PR_SS", lagDays: 5 },
      })
    );
    // A400 is gone, and its links with it; their names come from the earlier file.
    expect(result.links.filter(l => l.kind === "deleted").map(l => `${l.predCode}->${l.succCode}`)).toEqual([
      "A100->A400",
      "A300->A400",
    ]);
    expect(result.links.find(l => l.kind === "deleted")!.succName).toBe("Old temp road");
  });

  it("reports how far the project finish moved and the file facts", () => {
    expect(result.summary.finishDays).toBe(4);
    expect(result.from).toMatchObject({ id: "w1", dataDate: "2026-11-02", finish: "2026-11-20", activities: 4, relationships: 4 });
    expect(result.to).toMatchObject({ id: "w2", dataDate: "2026-11-09", finish: "2026-11-24", activities: 4, relationships: 3 });
  });

  it("compares the checks, with what newly fails and what was fixed", () => {
    const negative = result.checks.find(c => c.id === "negative_float")!;
    expect(negative).toMatchObject({ from: { count: 0 }, to: { count: 1 }, newlyFailing: 1, resolved: 0 });
    const constraints = result.checks.find(c => c.id === "hard_constraints")!;
    expect(constraints).toMatchObject({ to: { count: 1 }, newlyFailing: 1 });
    expect(result.checks.at(-1)).toMatchObject({ id: "broken_rows", subject: "rows" });
  });

  it("treats a link whose type changed as one changed link", () => {
    const before = schedule({ dataDate: "2026-11-02", tasks: week1Tasks(), links: [["10", "2", "1", "PR_FS", "0"]] });
    const after = schedule({ dataDate: "2026-11-02", tasks: week1Tasks(), links: [["10", "2", "1", "PR_SS", "0"]] });
    const { links, summary } = compare(before, after);
    expect(summary.relationships).toEqual({ added: 0, deleted: 0, changed: 1, unchanged: 0 });
    expect(links[0]).toMatchObject({ from: { type: "PR_FS" }, to: { type: "PR_SS" } });
  });

  it("finds nothing to report between a file and itself", () => {
    const same = compare(week1, week1);
    expect(same.activities).toEqual([]);
    expect(same.links).toEqual([]);
    expect(same.summary.activities.unchanged).toBe(4);
    expect(same.summary.finishDays).toBe(0);
  });
});

function week1Tasks() {
  return [
    ["1", "1", "101", "1", "A100", "Excavate", "TT_Task", "TK_Active", "0", "80", "40", "", "", "", "", "", ""],
    ["2", "1", "101", "1", "A200", "Foundations", "TT_Task", "TK_NotStart", "0", "160", "160", "", "", "", "", "", ""],
  ];
}

describe("compare on the samples", () => {
  const read = (name: string) =>
    snapshotOf(parseXer(decodeXer(readFileSync(path.resolve(__dirname, "../../../samples", name)))));

  it("matches every activity of a sample with itself", () => {
    const sample = read("events-example.xer");
    const result = compareSnapshots(sample, sample, {
      from: { id: "a", name: "a", uploadedAt: "" },
      to: { id: "b", name: "b", uploadedAt: "" },
    });
    expect(result.summary.matched).toBe(sample.activities.size);
    expect(result.summary.sameName).toBe(sample.activities.size);
    expect(result.activities).toEqual([]);
    expect(result.summary.relationships.unchanged).toBe(sample.links.length);
  });

  it("tells two different schedules apart by their names, though they share activity IDs", () => {
    const result = compareSnapshots(read("events-example.xer"), read("groupdocs-sample.xer"), {
      from: { id: "a", name: "a", uploadedAt: "" },
      to: { id: "b", name: "b", uploadedAt: "" },
    });
    // Both number their activities A1000, A1010, ... as P6 does by default.
    expect(result.summary.matched).toBe(70);
    expect(result.summary.sameName).toBe(0);
  });
});
