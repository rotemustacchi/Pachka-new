/**
 * The working week these deadlines are counted in.
 *
 * Both numbers that feed a dispatch deadline are business days -- the artwork's
 * stated lead time (`artwork-listings`) and
 * `app_config."shipping.unshipped_grace_days"` -- and the deadline decides
 * whether an artist is chased and an admin is interrupted. A weekend counted
 * wrong is a false accusation.
 */
import { describe, expect, it } from "vitest";
import { addBusinessDays, addCalendarDays, isIsraeliWeekend } from "./business-days";

const at = (iso: string): Date => new Date(iso);

describe("the Israeli working week", () => {
  it("treats Friday and Saturday as the weekend, and Sunday as a working day", () => {
    expect(isIsraeliWeekend(at("2026-03-05T09:00:00Z"))).toBe(false); // Thursday
    expect(isIsraeliWeekend(at("2026-03-06T09:00:00Z"))).toBe(true); // Friday
    expect(isIsraeliWeekend(at("2026-03-07T09:00:00Z"))).toBe(true); // Saturday
    expect(isIsraeliWeekend(at("2026-03-08T09:00:00Z"))).toBe(false); // Sunday
  });

  it("reads the weekday in Israel, not in UTC", () => {
    // 22:30 UTC on Thursday is already 00:30 on Friday in Tel Aviv. A UTC-based
    // rule would call this a working day for every artist in the country.
    expect(isIsraeliWeekend(at("2026-03-12T21:30:00Z"))).toBe(false);
    expect(isIsraeliWeekend(at("2026-03-12T22:30:00Z"))).toBe(true);
  });
});

describe("addBusinessDays()", () => {
  it("skips the weekend rather than counting through it", () => {
    // Thursday + 1 business day is Sunday, not Friday.
    expect(addBusinessDays(at("2026-03-05T09:00:00Z"), 1).toISOString()).toBe(
      "2026-03-08T09:00:00.000Z",
    );
  });

  it("skips a whole weekend when the span crosses one", () => {
    // Wednesday + 3 business days: Thu, Sun, Mon.
    expect(addBusinessDays(at("2026-03-04T09:00:00Z"), 3).toISOString()).toBe(
      "2026-03-09T09:00:00.000Z",
    );
  });

  it("returns the instant unchanged for zero days, weekend or not", () => {
    // "Due immediately" is a real configuration. Rounding it forward to the next
    // working day would silently grant time nobody configured.
    expect(addBusinessDays(at("2026-03-06T09:00:00Z"), 0).toISOString()).toBe(
      "2026-03-06T09:00:00.000Z",
    );
  });

  it("lands on a working day however many days it is given", () => {
    for (let days = 1; days <= 30; days += 1) {
      expect(isIsraeliWeekend(addBusinessDays(at("2026-03-04T09:00:00Z"), days))).toBe(false);
    }
  });

  it("refuses a fraction or a negative rather than interpreting it", () => {
    expect(() => addBusinessDays(at("2026-03-04T09:00:00Z"), 1.5)).toThrow(/whole number/i);
    expect(() => addBusinessDays(at("2026-03-04T09:00:00Z"), -1)).toThrow(/whole number/i);
  });
});

describe("addCalendarDays()", () => {
  it("counts through the weekend, because the statutory return window does", () => {
    // Thursday + 3 calendar days is Sunday: a buyer's fourteen days do not pause
    // for a weekend, and using business days here would extend every return.
    expect(addCalendarDays(at("2026-03-05T09:00:00Z"), 3).toISOString()).toBe(
      "2026-03-08T09:00:00.000Z",
    );
  });

  it("counts fourteen days as fourteen days", () => {
    expect(addCalendarDays(at("2026-03-01T09:00:00Z"), 14).toISOString()).toBe(
      "2026-03-15T09:00:00.000Z",
    );
  });
});
