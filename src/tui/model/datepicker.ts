/**
 * The state behind the Schedule message picker: a date and time read as five
 * digit fields (year, month, day, hour, minute), each changed on its own —
 * stepped with ↑ ↓ or typed over — so the moment is always a real one and
 * there is no text to get wrong. All in the user's local time.
 */

export const DATE_FIELDS = ["year", "month", "day", "hour", "minute"] as const;
export type DateField = (typeof DATE_FIELDS)[number];

/** How many digits a field shows and takes. */
export const FIELD_WIDTH: Record<DateField, number> = { year: 4, month: 2, day: 2, hour: 2, minute: 2 };

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** The field's number, as the person reads it (month 1–12). */
export function fieldValue(at: Date, field: DateField): number {
  switch (field) {
    case "year":
      return at.getFullYear();
    case "month":
      return at.getMonth() + 1;
    case "day":
      return at.getDate();
    case "hour":
      return at.getHours();
    case "minute":
      return at.getMinutes();
  }
}

export function fieldText(at: Date, field: DateField): string {
  return String(fieldValue(at, field)).padStart(FIELD_WIDTH[field], "0");
}

/** `at` with one field set, the day pulled back into the month when the month or year changed under it. */
function withField(at: Date, field: DateField, value: number): Date {
  let year = at.getFullYear();
  let month = at.getMonth() + 1;
  let day = at.getDate();
  let hour = at.getHours();
  let minute = at.getMinutes();
  if (field === "year") year = value;
  else if (field === "month") month = value;
  else if (field === "day") day = value;
  else if (field === "hour") hour = value;
  else minute = value;
  day = Math.min(day, daysInMonth(year, month));
  const next = new Date(year, month - 1, day, hour, minute, 0, 0);
  // Years below 100 are read as 19xx by Date; keep them as typed.
  if (year < 100) next.setFullYear(year);
  return next;
}

const RANGE: Record<DateField, readonly [number, number]> = {
  year: [1970, 9999],
  month: [1, 12],
  day: [1, 31],
  hour: [0, 23],
  minute: [0, 59],
};

/** One step up or down in a field. The month, day, hour and minute wrap around without carrying into their neighbour. */
export function stepField(at: Date, field: DateField, delta: 1 | -1): Date {
  const value = fieldValue(at, field);
  const [min, requestedMax] = RANGE[field];
  const max = field === "day" ? daysInMonth(at.getFullYear(), at.getMonth() + 1) : requestedMax;
  const next = field === "year" ? Math.min(max, Math.max(min, value + delta)) : value + delta > max ? min : value + delta < min ? max : value + delta;
  return withField(at, field, next);
}

/** The field after (or before) this one, staying on the end field rather than wrapping. */
export function moveField(field: DateField, delta: 1 | -1): DateField {
  const index = DATE_FIELDS.indexOf(field) + delta;
  return DATE_FIELDS[Math.min(DATE_FIELDS.length - 1, Math.max(0, index))]!;
}

export interface TypedDigit {
  readonly at: Date;
  /** Digits typed into the field so far; empty once the field is complete. */
  readonly typed: string;
  /** Whether the field is finished and the cursor moves on. */
  readonly advance: boolean;
}

/**
 * A digit typed into a field. Digits build up until the field is full, or no
 * further digit could still fit (a 4 in the month's tens place can only be
 * `04`), then the cursor moves on. A value out of range is held to the
 * nearest one that is in range. The year only changes once all four digits
 * are in, so it never passes through a nonsense year on the way.
 */
export function typeDigit(at: Date, field: DateField, typed: string, digit: string): TypedDigit {
  if (!/^[0-9]$/u.test(digit)) return { at, typed, advance: false };
  const width = FIELD_WIDTH[field];
  const buffer = typed.length >= width ? digit : typed + digit;
  const [min, max] = RANGE[field];
  const limit = field === "day" ? daysInMonth(at.getFullYear(), at.getMonth() + 1) : max;
  const full = buffer.length >= width;
  const settled = full || Number(buffer) * 10 > limit;
  if (field === "year" && !full) return { at, typed: buffer, advance: false };
  const value = Math.min(limit, Math.max(min, Number(buffer)));
  return { at: withField(at, field, value), typed: settled ? "" : buffer, advance: settled };
}

/** The soonest a message can be scheduled for: far enough ahead that it is a decision, not an immediate send. */
export const MIN_SCHEDULE_LEAD_MS = 5 * 60_000;

/** The earliest moment the picker allows from `now`: the lead time, rounded up to the next whole minute. */
export function earliestSchedule(now: Date): Date {
  const earliest = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS);
  if (earliest.getSeconds() !== 0 || earliest.getMilliseconds() !== 0) earliest.setMinutes(earliest.getMinutes() + 1, 0, 0);
  return earliest;
}

/** `at`, or `earliest` when `at` is before it. */
export function atLeast(at: Date, earliest: Date): Date {
  return at.getTime() < earliest.getTime() ? earliest : at;
}
