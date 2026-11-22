/**
 * P6 calendars (CALENDAR.clndr_data): which days are worked, for counting working days.
 *
 * clndr_data is a nested list, each node written `(0||name(params)(children))`:
 *
 *   (0||CalendarData()(
 *     (0||DaysOfWeek()(
 *       (0||1()( (0||0(s|08:00|f|12:00)()) ... ))   day 1 = Sunday … 7 = Saturday; no hours = day off
 *       ...))
 *     (0||Exceptions()(
 *       (0||0(d|40367)())                           a day off (date as days since 1899-12-30)
 *       (0||1(d|40400)( (0||0(s|08:00|f|17:00)()) ))  an extra working day
 *     ))))
 *
 * Line breaks in it are written as DEL (0x7F). Only whole days matter here: a day is worked when
 * it has any hours.
 */

export type WorkCalendar = {
  /** Worked or not, Sunday first (JavaScript's getUTCDay order). */
  weekdays: boolean[];
  /** "YYYY-MM-DD" → worked or not, overriding the weekday. */
  exceptions: Map<string, boolean>;
};

type Node = { name: string; params: string; children: Node[] };

/** Reads clndr_data; null when it isn't in the format above. */
export function parseCalendar(data: string | undefined): WorkCalendar | null {
  if (!data) return null;
  let root: Node;
  try {
    root = parseNode(data, { i: 0 });
  } catch {
    return null;
  }
  const find = (node: Node, name: string): Node | undefined =>
    node.name === name ? node : node.children.map(child => find(child, name)).find(Boolean);
  const week = find(root, "DaysOfWeek");
  if (!week) return null;

  const weekdays = Array<boolean>(7).fill(false);
  for (const day of week.children) {
    const n = Number(day.name);
    if (n >= 1 && n <= 7) weekdays[n - 1] = day.children.length > 0;
  }
  const exceptions = new Map<string, boolean>();
  for (const day of find(root, "Exceptions")?.children ?? []) {
    const serial = Number(/d\|(\d+)/.exec(day.params)?.[1]);
    if (Number.isFinite(serial)) exceptions.set(fromSerial(serial), day.children.length > 0);
  }
  return { weekdays, exceptions };
}

/**
 * Working days from `from` to `to`, both "YYYY-MM-DD…", counting both ends. Without a calendar,
 * Monday to Friday is assumed. 0 when `to` is before `from`.
 */
export function workingDaysBetween(calendar: WorkCalendar | null, from: string, to: string): number {
  const weekdays = calendar?.weekdays ?? [false, true, true, true, true, true, false];
  const day = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  let count = 0;
  for (; day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const exception = calendar?.exceptions.get(day.toISOString().slice(0, 10));
    if (exception ?? weekdays[day.getUTCDay()]) count++;
  }
  return count;
}

/** P6 stores exception dates as days since 1899-12-30 (the spreadsheet epoch). */
function fromSerial(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
}

function parseNode(text: string, at: { i: number }): Node {
  const skip = () => {
    // XER writes the line breaks inside clndr_data as DEL (0x7F).
    while (/[\s\x7f]/.test(text[at.i] ?? "")) at.i++;
  };
  const expect = (char: string) => {
    skip();
    if (text[at.i] !== char) throw new Error(`Expected "${char}" at ${at.i}`);
    at.i++;
  };
  const until = (char: string) => {
    const start = at.i;
    const end = text.indexOf(char, start);
    if (end < 0) throw new Error(`Missing "${char}"`);
    at.i = end;
    return text.slice(start, end);
  };

  expect("(");
  const head = until("(");
  const name = head.slice(head.lastIndexOf("|") + 1).trim();
  expect("(");
  const params = until(")");
  expect(")");
  expect("(");
  const children: Node[] = [];
  for (skip(); text[at.i] === "("; skip()) children.push(parseNode(text, at));
  expect(")");
  expect(")");
  return { name, params, children };
}
