import { describe, expect, it } from "vitest";

import { atLeast, daysInMonth, earliestSchedule, fieldText, moveField, stepField, typeDigit } from "../datepicker.js";
import { formatScheduleInput } from "../schedule.js";

const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute);
const show = (value: Date) => formatScheduleInput(value);

describe("date picker fields", () => {
  it("pads each field to its width", () => {
    const value = at(2026, 3, 4, 5, 6);
    expect(["year", "month", "day", "hour", "minute"].map((field) => fieldText(value, field as never))).toEqual(["2026", "03", "04", "05", "06"]);
  });

  it("steps a field and wraps the small ones without carrying", () => {
    expect(show(stepField(at(2026, 9, 27, 23, 59), "minute", 1))).toBe("2026-09-27 23:00");
    expect(show(stepField(at(2026, 9, 27, 23, 59), "hour", 1))).toBe("2026-09-27 00:59");
    expect(show(stepField(at(2026, 9, 27, 0, 0), "hour", -1))).toBe("2026-09-27 23:00");
    expect(show(stepField(at(2026, 12, 15), "month", 1))).toBe("2026-01-15 12:00");
    expect(show(stepField(at(2026, 9, 30), "day", 1))).toBe("2026-09-01 12:00");
    expect(show(stepField(at(2026, 9, 1), "day", -1))).toBe("2026-09-30 12:00");
    expect(show(stepField(at(2026, 9, 27), "year", 1))).toBe("2027-09-27 12:00");
  });

  it("keeps the day inside the month when the month or year moves under it", () => {
    expect(show(stepField(at(2026, 1, 31), "month", 1))).toBe("2026-02-28 12:00");
    expect(show(stepField(at(2028, 2, 29), "year", 1))).toBe("2029-02-28 12:00");
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it("moves between fields and stops at the ends", () => {
    expect(moveField("year", -1)).toBe("year");
    expect(moveField("year", 1)).toBe("month");
    expect(moveField("minute", 1)).toBe("minute");
  });

  it("types over a field, moving on once no more digits could fit", () => {
    let state = typeDigit(at(2026, 9, 27, 14, 30), "hour", "", "0");
    expect(show(state.at)).toBe("2026-09-27 00:30");
    expect(state).toMatchObject({ typed: "0", advance: false });
    state = typeDigit(state.at, "hour", state.typed, "9");
    expect(show(state.at)).toBe("2026-09-27 09:30");
    expect(state).toMatchObject({ typed: "", advance: true });

    // No hour starts with a 3, so it is the whole hour.
    state = typeDigit(at(2026, 9, 27, 14, 30), "hour", "", "3");
    expect(show(state.at)).toBe("2026-09-27 03:30");
    expect(state.advance).toBe(true);
  });

  it("holds out-of-range digits to the nearest valid value", () => {
    expect(show(typeDigit(at(2026, 9, 27), "minute", "7", "5").at)).toBe("2026-09-27 12:59");
    expect(show(typeDigit(at(2026, 9, 27), "month", "1", "9").at)).toBe("2026-12-27 12:00");
    expect(show(typeDigit(at(2026, 2, 10), "day", "3", "5").at)).toBe("2026-02-28 12:00");
  });

  it("changes the year only once all four digits are in", () => {
    let state = typeDigit(at(2026, 9, 27), "year", "", "2");
    expect(show(state.at)).toBe("2026-09-27 12:00");
    state = typeDigit(state.at, "year", state.typed, "0");
    state = typeDigit(state.at, "year", state.typed, "2");
    expect(show(state.at)).toBe("2026-09-27 12:00");
    state = typeDigit(state.at, "year", state.typed, "7");
    expect(show(state.at)).toBe("2027-09-27 12:00");
    expect(state.advance).toBe(true);
  });

  it("ignores anything but digits", () => {
    const start = at(2026, 9, 27);
    expect(typeDigit(start, "day", "", "x")).toEqual({ at: start, typed: "", advance: false });
  });
});

describe("the earliest time the picker allows", () => {
  it("is five minutes ahead, rounded up to the next whole minute", () => {
    expect(show(earliestSchedule(new Date(2026, 9, 16, 14, 30, 0, 0)))).toBe("2026-10-16 14:35");
    expect(show(earliestSchedule(new Date(2026, 9, 16, 14, 30, 20, 0)))).toBe("2026-10-16 14:36");
    expect(show(earliestSchedule(new Date(2026, 9, 16, 23, 58, 5)))).toBe("2026-10-17 00:04");
  });

  it("holds an earlier time up to it, and leaves a later one alone", () => {
    const earliest = at(2026, 10, 16, 14, 35);
    expect(atLeast(at(2026, 10, 16, 9, 0), earliest)).toBe(earliest);
    expect(atLeast(at(2026, 10, 16, 14, 34), earliest)).toBe(earliest);
    const later = at(2026, 10, 17, 9, 0);
    expect(atLeast(later, earliest)).toBe(later);
  });
});
