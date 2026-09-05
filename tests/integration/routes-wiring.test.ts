/**
 * The composition root — the one thing in `src/app` that, wired wrongly, sells
 * a one-of-a-kind painting twice.
 *
 * `artworks/deps.ts` states the stakes: the impression source "can safely
 * default, where `InventoryDemandSource` cannot, because being wrong about it
 * under-reports a number on a dashboard. Being wrong about demand sells a
 * one-of-a-kind painting twice." `assertDemandSourceIsWired` turns the
 * placeholder into a loud failure once a `reservations` table exists — which it
 * now does — so these tests drive that assertion against the deps the
 * application actually builds.
 *
 * The negative control matters as much as the positive one. Without it, a test
 * that "the real deps are wired" passes just as happily against an assertion
 * that never fires.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertDemandSourceIsWired,
  availabilityFor,
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  publishArtwork,
  toArtwork,
  ARTWORK_COLUMNS,
  type ArtworkInput,
  type ArtworkRow,
} from "@/modules/artworks";
import { beginCheckout } from "@/modules/orders";
import { isAppError } from "@/shared/errors";
import { artworksDeps, ordersDeps } from "@/app/_lib/deps";
import { artworksDeps as studioDeps } from "@/app/studio/deps";
import { useTestDatabase, type TestDatabase } from "../harness";

const CANVAS: ArtworkInput = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים.",
  priceAgorot: 125_000,
  heightCm: 100,
  widthCm: 70,
  weightGrams: 1850,
  materials: "אקריליק על בד פשתן",
  leadTimeDays: 5,
  medium: "textile_clothing",
  styles: ["minimalist"],
  moods: ["calm"],
  affirmsOriginality: true,
  aiAssisted: false,
  inventoryType: "unique",
};

async function seedArtist(database: TestDatabase): Promise<string> {
  const db = database.db;
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  return id;
}

async function seedBuyer(database: TestDatabase): Promise<string> {
  const id = randomUUID();
  await database.db.query("insert into profiles (user_id, display_name) values ($1, 'דנה כהן')", [id]);
  await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

describe("the composition root", () => {
  const database = useTestDatabase();

  it("wires a real demand source, so nothing reads as available while it is held", async () => {
    await expect(
      assertDemandSourceIsWired(database.db, artworksDeps(database.db).demand),
    ).resolves.toBeUndefined();
  });

  it("would have failed loudly on the placeholder, so the check above is not vacuous", async () => {
    const error = await assertDemandSourceIsWired(
      database.db,
      depsWithoutOrdersOrMatchmaker(database.db).demand,
    ).catch((caught: unknown) => caught);

    // `reservations` exists now, so the placeholder is no longer the honest
    // answer — it is the silent failure this assertion was written for.
    expect(isAppError(error) && error.code).toBe("artworks.demand_source_not_wired");
  });

  it("gives the artist's studio the same wiring as every other surface", async () => {
    await expect(
      assertDemandSourceIsWired(database.db, studioDeps(database.db).demand),
    ).resolves.toBeUndefined();
  });

  it("reports a reserved unit as unavailable rather than as still for sale", async () => {
    const artist = await seedArtist(database);
    const buyer = await seedBuyer(database);
    const deps = artworksDeps(database.db);

    const draft = await createDraft(deps, artist, CANVAS);
    const artworkId = (await publishArtwork(deps, artist, draft.id)).id;

    await beginCheckout(ordersDeps(database.db), {
      buyerId: buyer,
      lines: [{ artworkId }],
      delivery: {
        fullName: "דנה כהן",
        phone: "050-1234567",
        line1: "הרצל 12",
        city: "תל אביב",
        countryCode: "IL",
      },
    });

    // Read back the way every buyer-facing surface reads it.
    const row = await database.db.one<ArtworkRow>(
      `select ${ARTWORK_COLUMNS} from artworks a where a.id = $1`,
      [artworkId],
    );
    const artwork = toArtwork(row);

    const real = availabilityFor(artwork, await deps.demand.demandFor(database.db, artworkId));
    const placeholder = availabilityFor(
      artwork,
      await depsWithoutOrdersOrMatchmaker(database.db).demand.demandFor(database.db, artworkId),
    );

    // The unique piece is held by an in-progress checkout, so it is not
    // purchasable. The placeholder says it still is — which is the double sale,
    // in one assertion.
    expect(real.availableUnits).toBe(0);
    expect(real.purchasable).toBe(false);
    expect(placeholder.availableUnits).toBe(1);
  });
});
