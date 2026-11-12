import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { readXer } from "./index";
import { parseXer } from "./parse";
import { sha256Of, tableRecords } from "./store";

const SAMPLE = readFileSync(path.join(__dirname, "../../../samples/events-example.xer"));

describe("tableRecords", () => {
  it("keeps every readable row with its table, position and line", () => {
    const text = [
      "ERMHDR\t8.3",
      "%T\tCALENDAR",
      "%F\tclndr_id\tday_hr_cnt\t",
      "%R\t1\t8\t",
      "%R\tonly-one-value-too-many\t8\textra\t",
      "%R\t2\t10\t",
      "%E",
    ].join("\r\n");
    const { tables, rows } = tableRecords(parseXer(text));

    // The broken row still counts towards the table's rows but is not stored as one.
    expect(tables).toEqual([{ name: "CALENDAR", fields: ["clndr_id", "day_hr_cnt"], rowCount: 3 }]);
    expect(rows).toEqual([
      { table: "CALENDAR", rowNumber: 1, line: 4, values: { clndr_id: "1", day_hr_cnt: "8" } },
      { table: "CALENDAR", rowNumber: 3, line: 6, values: { clndr_id: "2", day_hr_cnt: "10" } },
    ]);
  });

  it("gives every row of a sample a unique key, as the primary key needs", () => {
    const { tables, rows } = tableRecords(readXer(SAMPLE));
    const keys = new Set(rows.map(row => `${row.table}#${row.rowNumber}`));
    expect(keys.size).toBe(rows.length);
    expect(tables.find(t => t.name === "TASK")?.rowCount).toBe(83);
  });
});

describe("sha256Of", () => {
  it("is the same for the same bytes and differs otherwise", () => {
    expect(sha256Of(SAMPLE)).toBe(sha256Of(Buffer.from(SAMPLE)));
    expect(sha256Of(SAMPLE)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Of(Buffer.concat([SAMPLE, Buffer.from("\r\n")]))).not.toBe(sha256Of(SAMPLE));
  });
});
