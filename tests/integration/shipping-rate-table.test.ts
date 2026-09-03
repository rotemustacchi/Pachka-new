/**
 * The rate table is data, not code.
 *
 * `shipping-and-returns`: "The rate table SHALL be editable by an admin without
 * a code deployment." The test for that is not that a function exists -- it is
 * that changing a row changes the next quote, with nothing rebuilt and nothing
 * restarted.
 *
 * The other half is who may change it. SECURITY.md's policy matrix marks rate
 * manipulation as shipping fraud, and gives `authenticated` read and nothing
 * else on these three tables. That is asserted here through `asAnon`/`asUser`,
 * which is the surface an attacker actually has: the PostgREST data API,
 * reachable with the anon key that ships in the browser bundle.
 */
import { describe, expect, it } from "vitest";
import { asAnon, asUser, useTestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import { quoteShipping, readRateTable, setRate, upsertTier, upsertZone } from "@/modules/shipping";

async function seedAccount(db: Database, name: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  return rows[0]!.user_id;
}

/** A zone and a tier of this test's own, so nothing depends on the seeded table. */
async function seedCell(db: Database, amountAgorot: number): Promise<void> {
  await upsertZone(db, {
    code: "quiet_valley",
    displayName: "עמק שקט",
    cities: ["quiet valley"],
    postalPrefixes: ["4242"],
  });
  await upsertTier(db, {
    code: "flat_print",
    displayName: "הדפס שטוח",
    ordinal: 15,
    maxLengthMm: 700,
    maxWidthMm: 500,
    maxHeightMm: 80,
    maxWeightGrams: 4000,
  });
  await setRate(db, { zoneCode: "quiet_valley", tierCode: "flat_print", amountAgorot });
}

describe("editing the rate table", () => {
  const database = useTestDatabase();

  it("changes what the next checkout is quoted, with no deployment", async () => {
    const artistId = await seedAccount(database.db, "Noa B.");
    await seedCell(database.db, 3900);

    const before = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Quiet Valley" },
      lines: [{ artworkId: "a1", artistId, sizeTierCode: "flat_print" }],
    });
    expect(before.totalAgorot).toBe(3900);

    await setRate(database.db, {
      zoneCode: "quiet_valley",
      tierCode: "flat_print",
      amountAgorot: 5400,
    });

    const after = await quoteShipping(database.db, {
      address: { countryCode: "IL", city: "Quiet Valley" },
      lines: [{ artworkId: "a1", artistId, sizeTierCode: "flat_print" }],
    });
    expect(after.totalAgorot).toBe(5400);
  });

  it("keeps amounts as whole agorot end to end", async () => {
    await seedCell(database.db, 12_345);

    const table = await readRateTable(database.db);
    const cell = table.find((entry) => entry.zoneCode === "quiet_valley");
    expect(cell?.amountAgorot).toBe(12_345);
    expect(Number.isInteger(cell?.amountAgorot)).toBe(true);
  });

  it("refuses a rate for a zone or tier that does not exist", async () => {
    await seedCell(database.db, 3900);

    await expect(
      setRate(database.db, { zoneCode: "atlantis", tierCode: "flat_print", amountAgorot: 100 }),
    ).rejects.toMatchObject({ kind: "not_found", code: "shipping.unknown_rate_cell" });
  });

  it("refuses a negative rate", async () => {
    await seedCell(database.db, 3900);

    await expect(
      setRate(database.db, { zoneCode: "quiet_valley", tierCode: "flat_print", amountAgorot: -1 }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("refuses a zone code that is not a code", async () => {
    await expect(
      upsertZone(database.db, { code: "Quiet Valley!", displayName: "x", cities: [] }),
    ).rejects.toMatchObject({ kind: "validation", code: "shipping.invalid_zone" });
  });
});

describe("the rate table on the public data API", () => {
  const database = useTestDatabase();

  it("is readable by an anonymous visitor, because a buyer is shown shipping before they pay", async () => {
    await seedCell(database.db, 3900);

    const visible = await asAnon(database.dataApi, async (tx) => {
      const { rows } = await tx.query<{ amount_agorot: string }>("select amount_agorot from shipping_rates");
      return rows;
    });

    expect(visible.length).toBeGreaterThan(0);
  });

  it("hides a deactivated zone's rates rather than leaking a price change early", async () => {
    await seedCell(database.db, 3900);
    await upsertZone(database.db, {
      code: "quiet_valley",
      displayName: "עמק שקט",
      cities: ["quiet valley"],
      postalPrefixes: ["4242"],
      active: false,
    });

    const zoneCodes = await asAnon(database.dataApi, async (tx) => {
      const { rows } = await tx.query<{ code: string }>("select code from shipping_zones");
      return rows.map((row) => row.code);
    });

    expect(zoneCodes).not.toContain("quiet_valley");
  });

  it("cannot be written by a signed-in user", async () => {
    const buyerId = await seedAccount(database.db, "Michal R.");
    await seedCell(database.db, 3900);

    await expect(
      asUser(database.dataApi, buyerId, (tx) =>
        tx.query("update shipping_rates set amount_agorot = 1"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("cannot be written by an anonymous visitor", async () => {
    await seedCell(database.db, 3900);

    await expect(
      asAnon(database.dataApi, (tx) =>
        tx.query(
          "insert into shipping_zones (code, display_name) values ('free_delivery', 'x')",
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
