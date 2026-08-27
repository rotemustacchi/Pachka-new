/**
 * The artworks schema, exercised through the surface that actually matters.
 *
 * `database.db` connects as the cluster superuser and is not what an attacker
 * holds. `asAnon` and `asUser` reproduce what PostgREST does -- connect, publish
 * the verified JWT claims into the session, `set local role` -- so a row that
 * comes back through those helpers is a row anyone with the anon key can pull
 * off /rest/v1/artworks. That is the surface SECURITY.md S0-1 is about, and no
 * PACHKA code sits on it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "@/shared/db";
import { MEDIA, MOODS, STYLES, TARGET_SPACES } from "@/modules/artworks";
import { asAnon, asUser, useTestDatabase } from "../harness";

/**
 * One artist, ready to own artworks.
 *
 * Local to this file on purpose. TESTING.md: "Do not add a shared fixture that
 * seeds data for several tests" -- this seeds nothing at module level, takes no
 * state between calls, and every test that wants an artist makes its own.
 */
async function seedArtist(
  db: Database,
  options: { readonly suspended?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [
    id,
  ]);
  if (options.suspended) {
    await db.query("update account_status set suspended_at = now() where user_id = $1", [id]);
  }
  return id;
}

/** A row that satisfies `artworks_published_is_complete`, in whichever status is asked for. */
async function seedArtwork(db: Database, artistId: string, status: string): Promise<string> {
  const complete = status === "published" || status === "sold";
  const row = await db.one<{ id: string }>(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, $2, 'קו החוף', 'ציור בשכבות דקות', 125000,
       1000, 700, 1850, 'אקריליק על פשתן', 5,
       'textile_clothing', array['minimalist']::text[], array['calm']::text[],
       $1, now(), false, $3
     ) returning id`,
    [artistId, status, complete ? new Date() : null],
  );
  return row.id;
}

describe("the closed taxonomy, in the schema", () => {
  const database = useTestDatabase();

  /**
   * Pull the string literals out of a rendered check constraint.
   *
   * `pg_get_constraintdef` renders them as `'minimalist'::text`, so the values
   * come back in the order the constraint declares them.
   */
  async function constraintValues(db: Database, name: string): Promise<string[]> {
    const row = await db.one<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1",
      [name],
    );
    return [...row.def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1] as string);
  }

  /**
   * The set is stated twice -- once in SQL, once in TypeScript -- and this is
   * what stops the two from drifting.
   *
   * Drift here is not cosmetic. If a value is added to `taxonomy.ts` and not to
   * the constraint, publishing an artwork classified with it fails with a raw
   * Postgres error at the last possible moment. If it is added to the
   * constraint and not to `taxonomy.ts`, the application rejects a value the
   * database would happily hold, and the matchmaker never ranks on it.
   */
  it.each([
    ["artworks_medium_check", MEDIA],
    ["artworks_styles_check", STYLES],
    ["artworks_target_spaces_check", TARGET_SPACES],
    ["artworks_moods_check", MOODS],
  ])("%s lists exactly the values the module exports", async (name, expected) => {
    expect(await constraintValues(database.db, name)).toEqual([...expected]);
  });

  it("refuses a taxonomy value outside the set even on a direct insert", async () => {
    const artistId = await seedArtist(database.db);

    await expect(
      database.db.query(
        "insert into artworks (artist_id, styles) values ($1, array['coastal_minimal']::text[])",
        [artistId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a medium outside the set even on a direct insert", async () => {
    const artistId = await seedArtist(database.db);

    await expect(
      database.db.query("insert into artworks (artist_id, medium) values ($1, 'sculpture')", [
        artistId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the artworks table", () => {
  const database = useTestDatabase();

  /**
   * ARCHITECTURE.md: "Availability is derived, never stored... Any counter
   * column for availability is a defect."
   *
   * Written against the catalog rather than against a list of column names, so
   * it starts catching a counter the moment somebody adds one, with no edit
   * here. `stock` is deliberately allowed: it is the artist's DECLARED edition
   * size, which changes only when they edit the listing.
   */
  it("has no availability counter column", async () => {
    const { rows } = await database.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'artworks'`,
    );

    const counters = rows
      .map((row) => row.column_name)
      .filter((name) => /available|remaining|reserved|sold_count|units_left|quantity/.test(name));

    expect(
      counters,
      `availability must be derived, not stored; found ${counters.join(", ")}`,
    ).toEqual([]);
  });

  it("refuses to hold a published artwork that is missing a mandatory field", async () => {
    const artistId = await seedArtist(database.db);

    // Everything except the weight. The application refuses this long before
    // the database sees it; this asserts that no other write path can either.
    await expect(
      database.db.query(
        `insert into artworks (
           artist_id, status, title, description, price_agorot, height_mm, width_mm,
           materials, lead_time_days, medium, styles, moods,
           originality_declared_by, originality_declared_at, ai_assisted, published_at
         ) values ($1, 'published', 'ללא משקל', 'תיאור', 1000, 100, 100,
                   'פשתן', 5, 'textile_clothing', array['minimalist']::text[],
                   array['calm']::text[], $1, now(), false, now())`,
        [artistId],
      ),
    ).rejects.toMatchObject({ constraint: "artworks_published_is_complete" });
  });

  it("refuses a published artwork whose AI question was never answered", async () => {
    const artistId = await seedArtist(database.db);

    await expect(
      database.db.query(
        `insert into artworks (
           artist_id, status, title, description, price_agorot, height_mm, width_mm,
           weight_grams, materials, lead_time_days, medium, styles, moods,
           originality_declared_by, originality_declared_at, published_at
         ) values ($1, 'published', 'ללא הצהרה', 'תיאור', 1000, 100, 100, 900,
                   'פשתן', 5, 'textile_clothing', array['minimalist']::text[],
                   array['calm']::text[], $1, now(), now())`,
        [artistId],
      ),
    ).rejects.toMatchObject({ constraint: "artworks_published_is_complete" });
  });

  it("pins a unique piece to exactly one unit", async () => {
    const artistId = await seedArtist(database.db);

    await expect(
      database.db.query(
        "insert into artworks (artist_id, inventory_type, stock) values ($1, 'unique', 5)",
        [artistId],
      ),
    ).rejects.toMatchObject({ constraint: "artworks_unique_has_stock_one" });
  });

  it("records the originality declaration as who and when together, or neither", async () => {
    const artistId = await seedArtist(database.db);

    await expect(
      database.db.query("insert into artworks (artist_id, originality_declared_by) values ($1, $1)", [
        artistId,
      ]),
    ).rejects.toMatchObject({ constraint: "artworks_originality_is_attributed" });
  });
});

describe("the PostgREST data API, holding only the anon key", () => {
  const database = useTestDatabase();

  /**
   * SECURITY.md S0-1's "artwork status test", verbatim: seed one draft, one
   * unlisted and one removed artwork, then look with the anon key and assert
   * none of the three comes back.
   *
   * Without the `status = 'published'` predicate on the policy, admin takedown
   * is nominal: a removed artwork stays readable at /rest/v1/artworks for
   * anyone who can open a browser console.
   */
  it("cannot see draft, unlisted or removed artworks", async () => {
    const artistId = await seedArtist(database.db);
    const hidden = await Promise.all([
      seedArtwork(database.db, artistId, "draft"),
      seedArtwork(database.db, artistId, "unlisted"),
      seedArtwork(database.db, artistId, "removed"),
    ]);

    const visible = await asAnon(database.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    expect(visible).toEqual([]);
    for (const id of hidden) expect(visible).not.toContain(id);
  });

  it("can see a published artwork, so the test above is not vacuous", async () => {
    const artistId = await seedArtist(database.db);
    const published = await seedArtwork(database.db, artistId, "published");

    const visible = await asAnon(database.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    expect(visible).toEqual([published]);
  });

  /**
   * SECURITY.md S1-13 item 3: suspension withdraws an artist's published
   * artworks as a DERIVED condition, never by bulk-updating rows -- because
   * lifting the suspension must restore exactly the previously published ones
   * "excluding any individually removed", and a bulk update destroys the
   * information needed to tell those apart.
   */
  it("cannot see a published artwork belonging to a suspended artist", async () => {
    const artistId = await seedArtist(database.db, { suspended: true });
    await seedArtwork(database.db, artistId, "published");

    const visible = await asAnon(database.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    expect(visible).toEqual([]);
  });

  it("sees the artwork again once the suspension is lifted, without touching the row", async () => {
    const artistId = await seedArtist(database.db, { suspended: true });
    const published = await seedArtwork(database.db, artistId, "published");

    await database.db.query("update account_status set suspended_at = null where user_id = $1", [
      artistId,
    ]);

    const visible = await asAnon(database.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    // The artwork row was never updated -- only the account's suspension was.
    expect(visible).toEqual([published]);
  });

  it("cannot write to artworks at all", async () => {
    const artistId = await seedArtist(database.db);

    await expect(
      asAnon(database.db, (tx) =>
        tx.query("insert into artworks (artist_id) values ($1)", [artistId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot see images belonging to an unpublished artwork", async () => {
    const artistId = await seedArtist(database.db);
    const draftId = await seedArtwork(database.db, artistId, "draft");
    await database.db.query(
      "insert into artwork_images (artwork_id, original_path) values ($1, $2)",
      [draftId, `${draftId}/original.jpg`],
    );

    const visible = await asAnon(database.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artwork_images");
      return rows;
    });

    expect(visible).toEqual([]);
  });
});

describe("a signed-in buyer who is not the artist", () => {
  const database = useTestDatabase();

  /**
   * SECURITY.md S0-1 asks for the artwork status test to be repeated "as an
   * authenticated buyer who is not the artist". A policy that reads
   * `to anon, authenticated using (status = 'published')` is easy to get right;
   * a SECOND policy added for signed-in users is where the leak usually
   * arrives, because policies are OR-ed together.
   */
  it("cannot see another artist's draft, unlisted or removed artworks", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = randomUUID();
    await database.db.query("insert into profiles (user_id, display_name) values ($1, 'קונה')", [
      buyerId,
    ]);
    await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
      buyerId,
    ]);

    await seedArtwork(database.db, artistId, "draft");
    await seedArtwork(database.db, artistId, "unlisted");
    await seedArtwork(database.db, artistId, "removed");
    const published = await seedArtwork(database.db, artistId, "published");

    const visible = await asUser(database.db, buyerId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    expect(visible).toEqual([published]);
  });

  it("cannot update someone else's artwork", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = randomUUID();
    await database.db.query("insert into profiles (user_id, display_name) values ($1, 'קונה')", [
      buyerId,
    ]);
    const artworkId = await seedArtwork(database.db, artistId, "published");

    await expect(
      asUser(database.db, buyerId, (tx) =>
        tx.query("update artworks set price_agorot = 1 where id = $1", [artworkId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("an artist looking at their own listings", () => {
  const database = useTestDatabase();

  it("sees every one of their own artworks, in every state", async () => {
    const artistId = await seedArtist(database.db);
    const expected = new Set(
      await Promise.all([
        seedArtwork(database.db, artistId, "draft"),
        seedArtwork(database.db, artistId, "published"),
        seedArtwork(database.db, artistId, "unlisted"),
        seedArtwork(database.db, artistId, "removed"),
      ]),
    );

    const visible = await asUser(database.db, artistId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows.map((row) => row.id);
    });

    expect(new Set(visible)).toEqual(expected);
  });

  /**
   * artwork-listings: an unlisted artwork "disappears from the catalog and
   * matchmaker results but remains visible in the artist's dashboard". This is
   * that sentence, split across the two readers.
   */
  it("still sees an unlisted artwork that no anonymous visitor can", async () => {
    const artistId = await seedArtist(database.db);
    const unlisted = await seedArtwork(database.db, artistId, "unlisted");

    const artistSees = await asUser(database.db, artistId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks where id = $1", [
        unlisted,
      ]);
      return rows.map((row) => row.id);
    });
    const anonSees = await asAnon(database.db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks where id = $1", [
        unlisted,
      ]);
      return rows.map((row) => row.id);
    });

    expect(artistSees).toEqual([unlisted]);
    expect(anonSees).toEqual([]);
  });

  it("cannot publish by writing to the data API, bypassing every publish rule", async () => {
    const artistId = await seedArtist(database.db);
    const draftId = await seedArtwork(database.db, artistId, "draft");

    // The whole reason there is no UPDATE policy: this PATCH would be a route
    // to `published` that runs no completeness check, no taxonomy cap, and no
    // lifecycle edge.
    await expect(
      asUser(database.db, artistId, (tx) =>
        tx.query("update artworks set status = 'published' where id = $1", [draftId]),
      ),
    ).rejects.toMatchObject({ code: "42501" });

    const after = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [draftId],
    );
    expect(after.status).toBe("draft");
  });
});
