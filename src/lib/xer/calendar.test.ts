import { describe, expect, it } from "vitest";
import { parseCalendar, workingDaysBetween } from "./calendar";

const day = (n: number, hours: boolean) => `(0||${n}()(${hours ? "(0||0(s|08:00|f|16:00)())" : ""}))`;
/** A Sunday-to-Thursday week. */
const DEL = "\x7f";
const data = [
  "(0||CalendarData()(",
  `(0||DaysOfWeek()(${[1, 2, 3, 4, 5].map(n => day(n, true)).join(DEL)}${day(6, false)}${day(7, false)}))`,
  "(0||VIEW(ShowTotal|Y)())",
  // 46177 = 2026-06-04 (a Thursday, taken off); 46179 = 2026-06-06 (a Saturday, worked).
  `(0||Exceptions()(${DEL}(0||0(d|46177)())${DEL}(0||1(d|46179)((0||0(s|08:00|f|12:00)())))))`,
  "))",
].join(DEL);

describe("parseCalendar", () => {
  it("reads the working week, Sunday first, and exceptions, through P6's DEL line breaks", () => {
    const calendar = parseCalendar(data)!;
    expect(calendar.weekdays).toEqual([true, true, true, true, true, false, false]);
    expect([...calendar.exceptions]).toEqual([
      ["2026-06-04", false],
      ["2026-06-06", true],
    ]);
  });

  it("returns null for data it can't read", () => {
    expect(parseCalendar("")).toBeNull();
    expect(parseCalendar("(0||CalendarData()(")).toBeNull();
    expect(parseCalendar("(0||CalendarData()())")).toBeNull();
  });
});

describe("workingDaysBetween", () => {
  it("counts worked days at both ends, applying exceptions", () => {
    const calendar = parseCalendar(data)!;
    // Sun 05-31 to Sat 06-06: Sun–Wed worked, Thu off (exception), Fri off, Sat worked (exception).
    expect(workingDaysBetween(calendar, "2026-05-31 08:00", "2026-06-06 17:00")).toBe(5);
  });

  it("assumes Monday to Friday without a calendar, and gives 0 for a backwards range", () => {
    expect(workingDaysBetween(null, "2026-06-01", "2026-06-14")).toBe(10);
    expect(workingDaysBetween(null, "2026-06-14", "2026-06-01")).toBe(0);
  });
});
