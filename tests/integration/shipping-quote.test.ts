/**
 * Quoting at checkout, against the real rate table.
 *
 * The arithmetic here is money. The scenario that matters most is "Multiple
 * artworks from one artist": the spec says shipping is charged **per
 * fulfilment using the largest applicable size tier, not the sum**. Two
 * artworks from one artist travel in one parcel, so summing their tiers
 * overcharges the buyer for a box that was posted once -- on every multi-item
 * order, quietly, forever. It is asserted below against explicit agorot rather
 * than against a recomputed expression, so a change in the rule fails the test
 * instead of moving with it.
 */
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import { classifyPackage, quoteShipping, setRate, upsertTier, upsertZone } from "@/modules/shipping";

async function seedAccount(db: Database, name: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  return rows[0]!.user_id;
}

/**
 * A rate table this test owns entirely.
 *
 * The tiers and zones the migration seeds are switched off first, not deleted.
 * `classifyPackage` considers every ACTIVE tier, and a test about "larger than
 * every tier" has to know what every tier is -- but deactivating is what the
 * module actually offers, and there is no DELETE policy on the rate table for
 * any role. That is deliberate: `shipping_rates` references zones and tiers by
 * id, and a past quote is only reconstructible while the rows it named still
 * exist, so retirement is the `active` flag rather than a deletion. The
 * upserts below re-activate the two tiers and two zones this file wants and
 * leave the rest switched off, which is exactly the state the old delete was
 * reaching for.
 */
async function seedRateTable(db: Database): Promise<void> {
  await db.query("update shipping_tiers set active = false where active");
  await db.query("update shipping_zones set active = false where active");

  await upsertTier(db, {
    code: "small",
    displayName: "קטן",
    ordinal: 10,
    maxLengthMm: 400,
    maxWidthMm: 300,
    maxHeightMm: 100,
    maxWeightGrams: 3000,
  });
  await upsertTier(db, {
    code: "large",
    displayName: "גדול",
    ordinal: 30,
    maxLengthMm: 1400,
    maxWidthMm: 1000,
    maxHeightMm: 600,
    maxWeightGrams: 25_000,
  });

  await upsertZone(db, {
    code: "near",
    displayName: "קרוב",
    cities: ["nearby city", "עיר קרובה"],
    postalPrefixes: ["61"],
  });
  await upsertZone(db, {
    code: "far",
    displayName: "רחוק",
    cities: ["far city"],
    postalPrefixes: ["88"],
  });

  await setRate(db, { zoneCode: "near", tierCode: "small", amountAgorot: 2900 });
  await setRate(db, { zoneCode: "near", tierCode: "large", amountAgorot: 8900 });
  await setRate(db, { zoneCode: "far", tierCode: "small", amountAgorot: 3900 });
  await setRate(db, { zoneCode: "far", tierCode: "large", amountAgorot: 11_900 });
}

describe("quoting shipping at checkout", () => {
  const database = useTestDatabase();

  it("prices from the artwork's tier and the address's zone", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    const quote = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Far City" },
      lines: [{ artworkId: "art-1", artistId, sizeTierCode: "small" }],
    });

    expect(quote.zoneCode).toBe("far");
    expect(quote.totalAgorot).toBe(3900);
    expect(quote.fulfilments).toEqual([{ artistId, tierCode: "small", amountAgorot: 3900 }]);
  });

  it("resolves the zone from a postal code when the city is spelled differently", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    const quote = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Neerbye Citty", postalCode: "6100000" },
      lines: [{ artworkId: "art-1", artistId, sizeTierCode: "small" }],
    });

    expect(quote.zoneCode).toBe("near");
    expect(quote.totalAgorot).toBe(2900);
  });

  it("charges one artist's two artworks at the LARGEST tier, not the sum of the tiers", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    const quote = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Nearby City" },
      lines: [
        { artworkId: "art-1", artistId, sizeTierCode: "small" },
        { artworkId: "art-2", artistId, sizeTierCode: "large" },
      ],
    });

    // The large rate alone. Not 2900 + 8900 = 11800, which is what a naive
    // per-line sum charges and what this assertion exists to catch.
    expect(quote.totalAgorot).toBe(8900);
    expect(quote.fulfilments).toHaveLength(1);
    expect(quote.fulfilments[0]?.tierCode).toBe("large");
  });

  it("does not depend on the order the lines arrive in", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    const largeFirst = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Nearby City" },
      lines: [
        { artworkId: "art-2", artistId, sizeTierCode: "large" },
        { artworkId: "art-1", artistId, sizeTierCode: "small" },
      ],
    });

    expect(largeFirst.totalAgorot).toBe(8900);
  });

  it("charges three artworks from one artist once, still at the largest tier", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    const quote = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Nearby City" },
      lines: [
        { artworkId: "art-1", artistId, sizeTierCode: "small" },
        { artworkId: "art-2", artistId, sizeTierCode: "small" },
        { artworkId: "art-3", artistId, sizeTierCode: "large" },
      ],
    });

    expect(quote.totalAgorot).toBe(8900);
  });

  it("charges two artists separately, because two artists post two parcels", async () => {
    await seedRateTable(database.db);
    const artistA = await seedAccount(database.db, "Noa B.");
    const artistB = await seedAccount(database.db, "Ori K.");

    const quote = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Nearby City" },
      lines: [
        { artworkId: "art-1", artistId: artistA, sizeTierCode: "small" },
        { artworkId: "art-2", artistId: artistB, sizeTierCode: "large" },
      ],
    });

    expect(quote.fulfilments).toHaveLength(2);
    expect(quote.totalAgorot).toBe(2900 + 8900);
  });

  it("keeps a total that is a whole number of agorot", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");
    await setRate(database.db, { zoneCode: "near", tierCode: "small", amountAgorot: 3333 });

    const quote = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Nearby City" },
      lines: [{ artworkId: "art-1", artistId, sizeTierCode: "small" }],
    });

    expect(Number.isInteger(quote.totalAgorot)).toBe(true);
    expect(quote.totalAgorot).toBe(3333);
  });
});

describe("an address outside every configured zone", () => {
  const database = useTestDatabase();

  it("blocks checkout and says the platform does not deliver there", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Somewhere Unlisted", postalCode: "1234567" },
        lines: [{ artworkId: "art-1", artistId, sizeTierCode: "small" }],
      }),
    ).rejects.toMatchObject({
      kind: "validation",
      code: "shipping.address_outside_zones",
      message: /does not currently deliver/i,
    });
  });

  it("blocks an address in another country even when the city name matches a zone", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    // The MVP trades in Israel only. A "Nearby City" in another country must
    // not inherit an Israeli zone just because the string matches.
    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "CY", city: "Nearby City" },
        lines: [{ artworkId: "art-1", artistId, sizeTierCode: "small" }],
      }),
    ).rejects.toMatchObject({ code: "shipping.address_outside_zones" });
  });

  it("blocks it even when a deactivated zone would have covered it", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");
    await upsertZone(database.db, {
      code: "far",
      displayName: "רחוק",
      cities: ["far city"],
      postalPrefixes: ["88"],
      active: false,
    });

    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Far City" },
        lines: [{ artworkId: "art-1", artistId, sizeTierCode: "small" }],
      }),
    ).rejects.toMatchObject({ code: "shipping.address_outside_zones" });
  });
});

describe("an artwork larger than every configured tier", () => {
  const database = useTestDatabase();

  it("is marked as requiring a shipping quote at listing time", async () => {
    await seedRateTable(database.db);

    const classification = await classifyPackage(database.db, {
      lengthMm: 2000,
      widthMm: 1500,
      heightMm: 800,
      weightGrams: 40_000,
    });

    expect(classification).toEqual({ tierCode: null, requiresShippingQuote: true });
  });

  it("is placed in the smallest tier it actually fits when it does fit one", async () => {
    await seedRateTable(database.db);

    const classification = await classifyPackage(database.db, {
      lengthMm: 350,
      widthMm: 250,
      heightMm: 90,
      weightGrams: 2500,
    });

    expect(classification).toEqual({ tierCode: "small", requiresShippingQuote: false });
  });

  it("is over-tier on weight alone, however small the box", async () => {
    await seedRateTable(database.db);

    const classification = await classifyPackage(database.db, {
      lengthMm: 200,
      widthMm: 200,
      heightMm: 90,
      weightGrams: 30_000,
    });

    expect(classification.requiresShippingQuote).toBe(true);
  });

  it("blocks standard checkout rather than quoting something plausible", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Nearby City" },
        lines: [
          { artworkId: "art-huge", artistId, sizeTierCode: null, requiresShippingQuote: true },
        ],
      }),
    ).rejects.toMatchObject({
      kind: "validation",
      code: "shipping.requires_quote",
      details: { artworkIds: ["art-huge"] },
    });
  });

  it("blocks the whole order, not just its own line", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Nearby City" },
        lines: [
          { artworkId: "art-1", artistId, sizeTierCode: "small" },
          { artworkId: "art-huge", artistId, sizeTierCode: null, requiresShippingQuote: true },
        ],
      }),
    ).rejects.toMatchObject({ code: "shipping.requires_quote" });
  });
});

describe("a zone and tier combination nobody priced", () => {
  const database = useTestDatabase();

  it("refuses to quote rather than quoting zero", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    // A tier an admin added and forgot to price -- which is the situation this
    // test names, and now the situation it actually creates. `seedRateTable`
    // prices every combination it defines, so the unpriced one has to be a new
    // tier rather than a rate removed from an existing one.
    await upsertTier(database.db, {
      code: "oversized",
      displayName: "ענק",
      ordinal: 40,
      maxLengthMm: 2200,
      maxWidthMm: 1800,
      maxHeightMm: 900,
      maxWeightGrams: 60_000,
    });

    // Falling back to zero would ship a large artwork across the country free of
    // charge every time an admin added a tier and forgot a row.
    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Nearby City" },
        lines: [{ artworkId: "art-2", artistId, sizeTierCode: "oversized" }],
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "shipping.rate_not_configured" });
  });

  it("refuses a tier code that is not in the table at all", async () => {
    await seedRateTable(database.db);
    const artistId = await seedAccount(database.db, "Noa B.");

    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Nearby City" },
        lines: [{ artworkId: "art-1", artistId, sizeTierCode: "enormous" }],
      }),
    ).rejects.toMatchObject({ kind: "not_found", code: "shipping.unknown_tier" });
  });

  it("refuses an empty cart", async () => {
    await seedRateTable(database.db);

    await expect(
      quoteShipping(database.db, {
        address: { countryCode: "IL", city: "Nearby City" },
        lines: [],
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "shipping.empty_quote" });
  });
});
