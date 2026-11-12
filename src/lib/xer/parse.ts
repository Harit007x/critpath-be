/**
 * Reads a Primavera P6 XER export into tables, and records every row it could not read.
 *
 * An XER file is tab-separated text:
 *   ERMHDR  <version> <export date> ...   the header, first line
 *   %T  <table>                           starts a table
 *   %F  <field> <field> ...               its field names
 *   %R  <value> <value> ...               one row
 *   %E                                    end of file
 *
 * This layer only checks structure (markers, field counts). Whether a value makes sense
 * (a number, a date, a link to a row that exists) is decided in `checks.ts`.
 */

export type XerRow = {
  /** 1-based line in the file, so a user can find the row in a text editor. */
  line: number;
  /** 1-based position of the row within its table. */
  rowNumber: number;
  values: Record<string, string>;
};

export type XerTable = {
  name: string;
  fields: string[];
  /** The rows that could be read; broken ones are in `brokenRows` instead. */
  rows: XerRow[];
  /** Every %R line in the table, read or not. */
  rowCount: number;
};

export type BrokenRow = {
  table: string;
  line: number;
  /** Row number within its table, when the line is a row. */
  rowNumber: number | null;
  /** structure: the file's layout; value: a field that is not a valid number or date;
   *  reference: a link to a row that does not exist; duplicate: a repeated id. */
  kind: "structure" | "value" | "reference" | "duplicate";
  field: string | null;
  reason: string;
};

export type ParsedXer = {
  header: { p6Version: string | null; exportDate: string | null } | null;
  tables: Map<string, XerTable>;
  brokenRows: BrokenRow[];
  /** Problems that make the file unreadable as XER at all. */
  fatal: string[];
};

/** XER is usually exported as Windows-1252; latin1 maps every byte, so nothing is lost. */
export function decodeXer(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  // U+FFFD means the bytes were not valid UTF-8: read them as latin1 instead.
  return text.includes("\uFFFD") ? bytes.toString("latin1") : text;
}

export function parseXer(text: string): ParsedXer {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const tables = new Map<string, XerTable>();
  const brokenRows: BrokenRow[] = [];
  const fatal: string[] = [];
  let header: ParsedXer["header"] = null;
  let current: XerTable | null = null;
  let sawFields = false;

  const broken = (table: string, line: number, rowNumber: number | null, reason: string) =>
    brokenRows.push({ table, line, rowNumber, kind: "structure", field: null, reason });

  if (text.trim() === "") fatal.push("This file is empty.");

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    const cells = raw.split("\t");
    const marker = cells[0];

    if (index === 0) {
      if (marker === "ERMHDR") {
        header = { p6Version: cells[1] || null, exportDate: cells[2] || null };
        return;
      }
      fatal.push("This isn't a Primavera P6 export (.xer).");
    }

    switch (marker) {
      case "ERMHDR":
        broken("(file)", line, null, "A second ERMHDR header in the middle of the file");
        return;
      case "%T": {
        const name = (cells[1] ?? "").trim();
        if (!name) {
          broken("(file)", line, null, "%T line without a table name");
          current = null;
          return;
        }
        if (tables.has(name)) broken(name, line, null, `Table ${name} appears a second time`);
        current = tables.get(name) ?? { name, fields: [], rows: [], rowCount: 0 };
        tables.set(name, current);
        sawFields = false;
        return;
      }
      case "%F":
        if (!current) {
          broken("(file)", line, null, "%F field list before any %T table");
          return;
        }
        // P6 ends each line with a tab, which leaves an empty name at the end.
        current.fields = trimTrailingEmpty(cells.slice(1));
        sawFields = true;
        return;
      case "%R": {
        if (!current) {
          broken("(file)", line, null, "%R row before any %T table");
          return;
        }
        const rowNumber = ++current.rowCount;
        if (!sawFields) {
          broken(current.name, line, rowNumber, "Row before the table's %F field list");
          return;
        }
        const values = cells.slice(1);
        const expected = current.fields.length;
        // A trailing tab adds an empty last value; any other extra value is a real problem.
        const extra = values.slice(expected);
        if (values.length < expected) {
          broken(
            current.name,
            line,
            rowNumber,
            `Row has ${values.length} values but the table has ${expected} fields`
          );
          return;
        }
        if (extra.some(value => value !== "")) {
          broken(
            current.name,
            line,
            rowNumber,
            `Row has ${trimTrailingEmpty(values).length} values but the table has ${expected} fields`
          );
          return;
        }
        const record: Record<string, string> = {};
        current.fields.forEach((field, i) => (record[field] = values[i] ?? ""));
        current.rows.push({ line, rowNumber, values: record });
        return;
      }
      case "%E":
        current = null;
        return;
      default:
        if (index === 0) return;
        broken(current?.name ?? "(file)", line, null, `Unrecognised line (starts with "${marker.slice(0, 20)}")`);
    }
  });

  if (fatal.length === 0 && !tables.has("TASK")) {
    fatal.push("This export has no activities (no TASK table) to check.");
  }

  return { header, tables, brokenRows, fatal };
}

function trimTrailingEmpty(cells: string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === "") end--;
  return cells.slice(0, end);
}
