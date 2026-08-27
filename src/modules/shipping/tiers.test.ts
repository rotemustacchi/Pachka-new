/**
 * Tier fitting, which is where a shipping subsidy would hide.
 *
 * A parcel wrongly placed in a smaller tier is priced below what it costs to
 * post, on every sale of that artwork, forever, and nothing in the system ever
 * notices. The boundary cases below are the ones that decide it.
 */
import { describe, expect, it } from "vitest";
import { fitsTier, millimetresFromCentimetres } from "./tiers";
import type { ShippingTier } from "./types";

const tier = (overrides: Partial<ShippingTier> = {}): ShippingTier => ({
  id: "00000000-0000-0000-0000-000000000001",
  code: "medium",
  displayName: "בינוני",
  ordinal: 20,
  maxLengthMm: 800,
  maxWidthMm: 600,
  maxHeightMm: 300,
  maxWeightGrams: 10_000,
  ...overrides,
});

describe("fitsTier()", () => {
  it("accepts a parcel exactly on every boundary", () => {
    // Inclusive bounds. A tier described as "up to 800 mm" that rejects 800 mm
    // prices every artwork on the boundary one tier too high.
    expect(
      fitsTier({ lengthMm: 800, widthMm: 600, heightMm: 300, weightGrams: 10_000 }, tier()),
    ).toBe(true);
  });

  it("rejects a parcel one millimetre over on any single edge", () => {
    expect(fitsTier({ lengthMm: 801, widthMm: 600, heightMm: 300, weightGrams: 1000 }, tier())).toBe(false);
    expect(fitsTier({ lengthMm: 800, widthMm: 601, heightMm: 300, weightGrams: 1000 }, tier())).toBe(false);
    expect(fitsTier({ lengthMm: 800, widthMm: 600, heightMm: 301, weightGrams: 1000 }, tier())).toBe(false);
  });

  it("rejects a parcel one gram over, however small it is", () => {
    // A small dense object -- a ceramic -- is exactly the case weight catches
    // and dimensions do not.
    expect(fitsTier({ lengthMm: 100, widthMm: 100, heightMm: 100, weightGrams: 10_001 }, tier())).toBe(
      false,
    );
  });

  it("does not care which edge the artist called height", () => {
    // 300 x 600 x 800 is the same box as 800 x 600 x 300. Comparing edge to
    // edge in the order given would charge a tier more for a rotation.
    expect(fitsTier({ lengthMm: 300, widthMm: 600, heightMm: 800, weightGrams: 5000 }, tier())).toBe(true);
    expect(fitsTier({ lengthMm: 600, widthMm: 300, heightMm: 800, weightGrams: 5000 }, tier())).toBe(true);
  });

  it("still rejects a box that no rotation makes fit", () => {
    // Two edges over the tier's two largest: no orientation saves it.
    expect(fitsTier({ lengthMm: 700, widthMm: 700, heightMm: 700, weightGrams: 5000 }, tier())).toBe(false);
  });

  it("refuses a zero or fractional dimension rather than guessing", () => {
    expect(() => fitsTier({ lengthMm: 0, widthMm: 10, heightMm: 10, weightGrams: 10 }, tier())).toThrow(
      /whole number greater than zero/i,
    );
    expect(() =>
      fitsTier({ lengthMm: 10.5, widthMm: 10, heightMm: 10, weightGrams: 10 }, tier()),
    ).toThrow(/whole number greater than zero/i);
  });
});

describe("millimetresFromCentimetres()", () => {
  it("converts a whole number of centimetres exactly", () => {
    expect(millimetresFromCentimetres(24)).toBe(240);
  });

  it("rounds up, so rounding can only ever make a parcel dearer, never cheaper", () => {
    expect(millimetresFromCentimetres(24.01)).toBe(241);
    expect(millimetresFromCentimetres(79.99)).toBe(800);
  });

  it("does not gain a millimetre to floating-point noise", () => {
    // 24.1 * 10 is 240.99999999999997 in binary floating point. Without the
    // correction, every tenth-of-a-centimetre measurement would grow by 1 mm
    // and artworks would drift into the next tier for nothing.
    expect(millimetresFromCentimetres(24.1)).toBe(241);
    expect(millimetresFromCentimetres(60)).toBe(600);
    expect(millimetresFromCentimetres(0.3)).toBe(3);
  });

  it("refuses a negative or non-finite measurement", () => {
    expect(() => millimetresFromCentimetres(-1)).toThrow(/non-negative/i);
    expect(() => millimetresFromCentimetres(Number.NaN)).toThrow(/non-negative/i);
  });
});
