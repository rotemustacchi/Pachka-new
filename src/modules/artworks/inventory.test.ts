/**
 * The availability derivation.
 *
 * `stock - active_reservations - sold`, as arithmetic. The database-backed half
 * -- the row lock, the demand source, the reconciliation -- is exercised
 * against a real PostgreSQL in `tests/integration/artworks-inventory.test.ts`;
 * what is worth testing here is the formula itself and its edges.
 */
import { describe, expect, it } from "vitest";
import { ZERO_DEMAND, availabilityFor, availableUnits, oversoldBy } from "./inventory";
import type { Artwork } from "./types";

const demand = (reservedUnits: number, soldUnits: number) => ({ reservedUnits, soldUnits });

function artwork(overrides: Partial<Artwork> = {}): Artwork {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    artistId: "22222222-2222-4222-8222-222222222222",
    status: "published",
    title: "קו החוף",
    description: "תיאור",
    priceAgorot: 125_000 as Artwork["priceAgorot"],
    heightMm: 1000,
    widthMm: 700,
    depthMm: null,
    weightGrams: 1850,
    materials: "אקריליק על פשתן",
    isFramed: null,
    leadTimeDays: 5,
    yearCreated: null,
    medium: "textile_clothing",
    styles: ["minimalist"],
    targetSpaces: [],
    moods: ["calm"],
    inventoryType: "unique",
    stock: 1,
    madeToOrder: false,
    productionLeadTimeDays: null,
    originality: { declaredBy: "22222222-2222-4222-8222-222222222222", declaredAt: "2026-08-27T00:00:00.000Z" },
    aiAssisted: false,
    publishedAt: "2026-08-27T00:00:00.000Z",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("availableUnits", () => {
  it("is stock minus reservations minus sales", () => {
    expect(availableUnits(10, demand(2, 3))).toBe(5);
  });

  it("is the full stock when nothing is spoken for", () => {
    expect(availableUnits(10, ZERO_DEMAND)).toBe(10);
  });

  it("counts an in-progress reservation against availability, not just a completed sale", () => {
    // This is the whole reason reservation exists: two buyers must not both see
    // the last unit as free while one of them is in checkout.
    expect(availableUnits(1, demand(1, 0))).toBe(0);
  });

  /**
   * Clamped rather than negative. A negative figure would render as
   * "-1 remaining" on a public page and would turn every `available > 0` check
   * into a subtly different question. The overshoot is reported separately so
   * the bug is still findable.
   */
  it("clamps at zero rather than reporting a negative", () => {
    expect(availableUnits(2, demand(0, 5))).toBe(0);
    expect(oversoldBy(2, demand(0, 5))).toBe(3);
  });

  it("reports no overshoot in a healthy system", () => {
    expect(oversoldBy(10, demand(2, 3))).toBe(0);
    expect(oversoldBy(1, demand(1, 0))).toBe(0);
  });
});

describe("availabilityFor", () => {
  it("makes a published artwork with stock free purchasable", () => {
    const availability = availabilityFor(artwork(), ZERO_DEMAND);

    expect(availability.availableUnits).toBe(1);
    expect(availability.purchasable).toBe(true);
    expect(availability.soldOut).toBe(false);
  });

  /** artwork-listings: a unique piece, once sold, is never purchasable again. */
  it("makes a sold unique piece unpurchasable", () => {
    const availability = availabilityFor(artwork({ status: "sold" }), demand(0, 1));

    expect(availability.availableUnits).toBe(0);
    expect(availability.soldOut).toBe(true);
    expect(availability.purchasable).toBe(false);
  });

  /**
   * Purchasability is availability AND lifecycle together. An unlisted artwork
   * with stock free is not for sale, and neither is a draft -- otherwise
   * "unlist" would remove a listing from the catalog while leaving it buyable
   * by anyone holding the URL.
   */
  it.each(["draft", "unlisted", "removed", "sold"] as const)(
    "refuses to make a %s artwork purchasable even with stock free",
    (status) => {
      const availability = availabilityFor(artwork({ status, stock: 5 }), ZERO_DEMAND);

      expect(availability.availableUnits).toBe(5);
      expect(availability.purchasable).toBe(false);
    },
  );

  it("keeps an edition purchasable while units remain", () => {
    const availability = availabilityFor(
      artwork({ inventoryType: "edition", stock: 10 }),
      demand(0, 1),
    );

    expect(availability.availableUnits).toBe(9);
    expect(availability.purchasable).toBe(true);
    expect(availability.soldOut).toBe(false);
  });

  it("carries the declared stock through untouched", () => {
    // Nothing decrements `stock`. It is what the artist declared, and the
    // remaining count is derived from it.
    const availability = availabilityFor(
      artwork({ inventoryType: "edition", stock: 10 }),
      demand(1, 4),
    );

    expect(availability.stock).toBe(10);
    expect(availability.availableUnits).toBe(5);
  });
});
