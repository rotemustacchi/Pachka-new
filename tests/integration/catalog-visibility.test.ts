/**
 * One visibility rule, stated four times, proved to agree.
 *
 * "An artwork is public when its status is `published` AND its artist is not
 * suspended" is written down in four places, for four different reasons:
 *
 *   1. the RLS policy on `artworks`, which is what stops an anonymous caller
 *      reading a draft straight off the PostgREST data API (SECURITY.md S0-1);
 *   2. `artworks.is_publicly_visible(uuid)`, the SQL helper the
 *      `artwork_images` policy asks;
 *   3. `NOT_SUSPENDED` inside `artworks/queries.ts`, which the module's own
 *      reads use;
 *   4. `VISIBLE` inside `catalog/query.ts`, which is written out separately
 *      because the other three are unusable from a filtered, sorted, paginated
 *      query — the policy does not apply to the server connection, the SQL
 *      helper costs a lookup per candidate row before `limit` can apply, and
 *      the fragment is module-private.
 *
 * Four statements of one rule is three opportunities for drift, and the drift
 * that matters is silent: a suspended artist's work staying on the busiest page
 * in the product, or a removed artwork remaining reachable after a takedown.
 * The catalog owning a fourth copy is only defensible if a test fails the
 * moment it stops matching the other three, so this file is the price of that
 * copy. `artworks-taxonomy.test.ts` guards the closed taxonomy the same way and
 * for the same reason.
 *
 * If this file is ever the thing standing in the way, the right fix is for
 * `artworks` to export its predicate fragment and for `catalog` to use it —
 * reported upstream. Deleting these tests is not the fix.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  isPubliclyVisible,
  listPublishedArtworks,
  publishArtwork,
  removeArtwork,
  unlistArtwork,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import { browseCatalog, countPublishedArtworks } from "@/modules/catalog";
import { asAnon, grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";

const COMPLETE: ArtworkInput = {
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
};

async function seedArtist(database: TestDatabase, name: string): Promise<string> {
  const db = database.db;
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedAdmin(database: TestDatabase): Promise<string> {
  const id = randomUUID();
  await database.db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
    id,
  ]);
  await grantAdminRole(database, id);
  return id;
}

async function publish(deps: ArtworksDeps, artistId: string, title: string): Promise<string> {
  const draft = await createDraft(deps, artistId, { ...COMPLETE, title });
  await publishArtwork(deps, artistId, draft.id);
  return draft.id;
}

/**
 * One artwork in every state that exists, plus a suspended artist's published
 * one. Whatever "public" means, it has to give the same answer about all six.
 */
async function seedEveryState(database: TestDatabase, deps: ArtworksDeps) {
  const artist = await seedArtist(database, "אמנית פעילה");
  const suspendedArtist = await seedArtist(database, "אמנית מושעית");
  const admin = await seedAdmin(database);

  const published = await publish(deps, artist, "מפורסמת");
  const draft = (await createDraft(deps, artist, { ...COMPLETE, title: "טיוטה" })).id;

  const unlisted = await publish(deps, artist, "לא מוצגת");
  await unlistArtwork(deps, artist, unlisted);

  const removed = await publish(deps, artist, "הוסרה");
  await removeArtwork(deps, admin, removed);

  const suspendedsPublished = await publish(deps, suspendedArtist, "של אמנית מושעית");
  await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
    suspendedArtist,
  ]);

  return {
    visible: [published],
    hidden: [draft, unlisted, removed, suspendedsPublished],
    all: [published, draft, unlisted, removed, suspendedsPublished],
  };
}

describe("catalog's visibility predicate agrees with the artworks module's", () => {
  const database = useTestDatabase();

  it("returns exactly the artworks `isPubliclyVisible` says are visible", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { all } = await seedEveryState(database, deps);

    const inCatalog = new Set(
      (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id),
    );

    // Asked one artwork at a time, through the OTHER module's implementation.
    for (const artworkId of all) {
      const artworksSaysVisible = await isPubliclyVisible(database.db, artworkId);
      expect(inCatalog.has(artworkId)).toBe(artworksSaysVisible);
    }
  });

  it("returns the same set as `listPublishedArtworks`, which shares the artworks fragment", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    await seedEveryState(database, deps);

    const fromArtworks = (await listPublishedArtworks(database.db)).map((artwork) => artwork.id);
    const fromCatalog = (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id);

    expect([...fromCatalog].sort()).toEqual([...fromArtworks].sort());
  });

  it("counts the same artworks it lists", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { visible } = await seedEveryState(database, deps);

    expect(await countPublishedArtworks(database.db)).toBe(visible.length);
  });
});

describe("catalog's visibility predicate agrees with the row-level security policy", () => {
  const database = useTestDatabase();

  it("shows an anonymous caller nothing the data API would not show them anyway", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    await seedEveryState(database, deps);

    const fromCatalog = (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id);

    // The surface an attacker actually has: the anon key and nothing else.
    const fromDataApi = await asAnon(database.dataApi, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    expect([...fromCatalog].sort()).toEqual([...fromDataApi].sort());
  });

  it("hides a removed artwork from both, so a takedown is not merely cosmetic", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { hidden } = await seedEveryState(database, deps);
    const removedId = hidden[2]!;

    const fromCatalog = (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id);
    const fromDataApi = await asAnon(database.dataApi, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks where id = $1", [
        removedId,
      ]);
      return rows;
    });

    expect(fromCatalog).not.toContain(removedId);
    expect(fromDataApi).toEqual([]);
  });

  it("hides a suspended artist's work from both, without having touched the row", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { hidden } = await seedEveryState(database, deps);
    const suspendedsId = hidden[3]!;

    const fromCatalog = (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id);
    const fromDataApi = await asAnon(database.dataApi, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks where id = $1", [
        suspendedsId,
      ]);
      return rows;
    });

    expect(fromCatalog).not.toContain(suspendedsId);
    expect(fromDataApi).toEqual([]);

    // Derived, never bulk-updated: SECURITY.md S1-13 item 3 requires lifting a
    // suspension to restore the previous state, which a bulk update destroys.
    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [suspendedsId],
    );
    expect(row.status).toBe("published");
  });

  it("brings a suspended artist's work back the moment the suspension lifts", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { hidden } = await seedEveryState(database, deps);
    const suspendedsId = hidden[3]!;

    await database.db.query(
      "update account_status set suspended_at = null where user_id = (select artist_id from artworks where id = $1)",
      [suspendedsId],
    );

    const fromCatalog = (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id);

    expect(fromCatalog).toContain(suspendedsId);
  });

  it("keeps a removed artwork gone even after its artist's suspension lifts", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artist = await seedArtist(database, "אמנית");
    const admin = await seedAdmin(database);
    const removedId = await publish(deps, artist, "הוסרה");
    await removeArtwork(deps, admin, removedId);

    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      artist,
    ]);
    await database.db.query("update account_status set suspended_at = null where user_id = $1", [
      artist,
    ]);

    // `removed` is terminal for every role (ARCHITECTURE.md), so a suspension
    // round trip must not launder a takedown back onto the catalog.
    const fromCatalog = (await browseCatalog(deps)).entries.map((entry) => entry.artwork.id);
    expect(fromCatalog).not.toContain(removedId);
  });
});
