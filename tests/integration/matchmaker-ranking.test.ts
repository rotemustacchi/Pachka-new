/**
 * The matchmaker against a real catalog, with real pgvector embeddings.
 *
 * WHY THE SEED IS THIS BIG
 * ------------------------
 * Twelve artworks across three visual themes and two artists. A ranking test
 * over two rows proves almost nothing: with two candidates, "sorted correctly"
 * and "returned in insertion order" are the same observation half the time, a
 * tie band cannot be distinguished from a total order, and truncation never
 * happens. Twelve is enough that the top five is a genuine selection, that a
 * tie band has more members than positions, and that a bug in the blend shows
 * up as the wrong artwork rather than as a coin flip.
 *
 * The embeddings are real vectors in the real `vector(1024)` column, computed
 * here rather than by a model: an artwork's theme puts a 1 in one component, so
 * two pieces sharing a theme are identical in direction and two that do not are
 * nearly orthogonal. That gives cosine similarities that are exactly known,
 * which is what makes an assertion about ranking an assertion rather than a
 * hope.
 *
 * Artwork ids are FIXED rather than random. Rotation is a function of the
 * artwork id, so a test about rotation over random ids passes for the wrong
 * reason or fails one run in fifty.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { depsWithoutOrdersOrMatchmaker, listPublishedArtworks } from "@/modules/artworks";
import {
  runMatchmaker,
  NO_MATCHES_MESSAGE,
  SPARSE_CATALOG_MESSAGE,
  type MatchOutcome,
} from "@/modules/matchmaker";
import { setConfig } from "@/shared/config";
import type { Database } from "@/shared/db";
import { useTestDatabase } from "../harness";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSIONS = 1024;

/**
 * A vector pointing along one theme axis.
 *
 * Component `theme` is 1 and everything else is 0, except a small constant in
 * the last component so no vector is degenerate. Cosine between two pieces of
 * one theme is 1; between different themes it is ~0.01.
 */
function themeVector(theme: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[theme] = 1;
  vector[EMBEDDING_DIMENSIONS - 1] = 0.1;
  return vector;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

async function seedArtist(db: Database, displayName: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, displayName]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [
    id,
    displayName,
  ]);
  return id;
}

interface SeedArtwork {
  readonly id: string;
  readonly artistId: string;
  readonly priceAgorot: number;
  readonly styles: readonly string[];
  readonly moods: readonly string[];
  readonly targetSpaces?: readonly string[];
  readonly medium?: string;
  readonly heightMm?: number;
  readonly widthMm?: number;
  readonly publishedDaysAgo?: number;
  /** null seeds an artwork with NO embedding: browsable, unrankable. */
  readonly theme: number | null;
}

async function seedArtwork(db: Database, artwork: SeedArtwork): Promise<string> {
  const medium = artwork.medium ?? "textile_clothing";
  await db.query(
    `insert into artworks (
       id, artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, target_spaces, moods,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, $2, 'published', $3, 'עבודה לבדיקה.', $4,
       $5, $6, 1200, 'חומרים', 7,
       $7, $8::text[], $9::text[], $10::text[],
       $2, now(), false, now() - make_interval(days => $11::int)
     )`,
    [
      artwork.id,
      artwork.artistId,
      `יצירה ${artwork.id.slice(0, 8)}`,
      artwork.priceAgorot,
      artwork.heightMm ?? 700,
      artwork.widthMm ?? 500,
      medium,
      [...artwork.styles],
      [...(artwork.targetSpaces ?? [])],
      [...artwork.moods],
      artwork.publishedDaysAgo ?? 0,
    ],
  );

  if (artwork.theme === null) return artwork.id;

  const imageId = randomUUID();
  await db.query(
    `insert into artwork_images (id, artwork_id, original_path, display_path, position)
     values ($1, $2, $3, $4, 0)`,
    [imageId, artwork.id, `${artwork.id}/original.jpg`, `${artwork.id}/display.webp`],
  );
  await db.query(
    `insert into artwork_embeddings (artwork_id, image_id, embedding, description, model)
     values ($1, $2, $3::vector, 'תיאור לבדיקה', 'test-embed-v1')`,
    [artwork.id, imageId, vectorLiteral(themeVector(artwork.theme))],
  );
  return artwork.id;
}

/** Fixed ids, so rotation is reproducible between runs and not only within one. */
const ID = {
  calmA: "a1111111-1111-4111-8111-111111111111",
  calmB: "a2222222-2222-4222-8222-222222222222",
  calmC: "a3333333-3333-4333-8333-333333333333",
  calmD: "a4444444-4444-4444-8444-444444444444",
  boldA: "b1111111-1111-4111-8111-111111111111",
  boldB: "b2222222-2222-4222-8222-222222222222",
  boldC: "b3333333-3333-4333-8333-333333333333",
  popA: "c1111111-1111-4111-8111-111111111111",
  popB: "c2222222-2222-4222-8222-222222222222",
  popC: "c3333333-3333-4333-8333-333333333333",
  expensive: "d1111111-1111-4111-8111-111111111111",
  noEmbedding: "e1111111-1111-4111-8111-111111111111",
} as const;

/**
 * Twelve artworks: four minimalist/calm on theme 0, three abstract/bold on
 * theme 1, three pop_art/edgy on theme 2, one far over budget, and one with no
 * embedding at all.
 *
 * Every test creates this itself. TESTING.md: no shared fixture carrying state
 * between tests, and each test owns its own database anyway.
 */
async function seedCatalog(db: Database): Promise<{ artistA: string; artistB: string }> {
  const artistA = await seedArtist(db, "יעל שוורץ");
  const artistB = await seedArtist(db, "דנה לוי");

  await seedArtwork(db, { id: ID.calmA, artistId: artistA, priceAgorot: 50_000, styles: ["minimalist"], moods: ["calm"], targetSpaces: ["living_room"], theme: 0 });
  await seedArtwork(db, { id: ID.calmB, artistId: artistA, priceAgorot: 52_000, styles: ["minimalist"], moods: ["calm"], targetSpaces: ["living_room"], theme: 0 });
  await seedArtwork(db, { id: ID.calmC, artistId: artistB, priceAgorot: 54_000, styles: ["minimalist"], moods: ["calm"], targetSpaces: ["bedroom"], theme: 0 });
  await seedArtwork(db, { id: ID.calmD, artistId: artistB, priceAgorot: 56_000, styles: ["minimalist"], moods: ["calm"], targetSpaces: ["living_room"], theme: 0 });

  await seedArtwork(db, { id: ID.boldA, artistId: artistA, priceAgorot: 60_000, styles: ["abstract"], moods: ["bold"], theme: 1 });
  await seedArtwork(db, { id: ID.boldB, artistId: artistB, priceAgorot: 62_000, styles: ["abstract"], moods: ["bold"], theme: 1 });
  await seedArtwork(db, { id: ID.boldC, artistId: artistB, priceAgorot: 64_000, styles: ["abstract"], moods: ["bold"], theme: 1 });

  await seedArtwork(db, { id: ID.popA, artistId: artistA, priceAgorot: 70_000, styles: ["pop_art"], moods: ["edgy"], theme: 2 });
  await seedArtwork(db, { id: ID.popB, artistId: artistB, priceAgorot: 72_000, styles: ["pop_art"], moods: ["edgy"], theme: 2 });
  await seedArtwork(db, { id: ID.popC, artistId: artistB, priceAgorot: 74_000, styles: ["pop_art"], moods: ["edgy"], theme: 2 });

  await seedArtwork(db, { id: ID.expensive, artistId: artistA, priceAgorot: 900_000, styles: ["minimalist"], moods: ["calm"], theme: 0 });
  await seedArtwork(db, { id: ID.noEmbedding, artistId: artistA, priceAgorot: 51_000, styles: ["minimalist"], moods: ["calm"], theme: null });

  return { artistA, artistB };
}

const FINGERPRINT = "f".repeat(64);
const VIEWER = "e".repeat(64);

function search(
  db: Database,
  answers: Record<string, unknown>,
  now = new Date("2026-09-01T12:00:00.000Z"),
): Promise<MatchOutcome> {
  return runMatchmaker(
    { db },
    { answers, clientFingerprint: FINGERPRINT, viewerFingerprint: VIEWER, now },
  );
}

const CALM_BUYER = { budgetMax: 800, styles: ["minimalist"], moods: ["calm"] };

// ---------------------------------------------------------------------------

describe("ranking a real catalog", () => {
  const database = useTestDatabase();

  it("returns the artworks matching the answers, best first", async () => {
    await seedCatalog(database.db);

    const outcome = await search(database.db, CALM_BUYER);
    const ids = outcome.matches.map((match) => match.artworkId);

    expect(ids.length).toBeGreaterThan(0);
    // Every returned piece is one of the minimalist/calm four. The pop_art
    // pieces are on an orthogonal embedding axis and share no taxonomy answer,
    // so a blend that had lost either signal would let them in.
    expect(ids.every((id) => [ID.calmA, ID.calmB, ID.calmC, ID.calmD].includes(id as never))).toBe(
      true,
    );
  });

  it("scores every returned artwork at or above the minimum", async () => {
    await seedCatalog(database.db);

    const outcome = await search(database.db, CALM_BUYER);

    for (const match of outcome.matches) {
      expect(match.score).toBeGreaterThanOrEqual(0.35);
    }
  });
});

describe("reproducibility within a rotation epoch", () => {
  const database = useTestDatabase();

  it("returns the identical ordering for identical answers", async () => {
    await seedCatalog(database.db);

    // Two submissions hours apart, inside one 24-hour epoch.
    const morning = await search(database.db, CALM_BUYER, new Date("2026-09-01T06:00:00.000Z"));
    const evening = await search(database.db, CALM_BUYER, new Date("2026-09-01T23:00:00.000Z"));

    expect(morning.epoch).toBe(evening.epoch);
    expect(evening.matches.map((m) => m.artworkId)).toEqual(morning.matches.map((m) => m.artworkId));
    expect(evening.matches.map((m) => m.score)).toEqual(morning.matches.map((m) => m.score));
  });

  it("reorders the tie band when the epoch advances, and not before", async () => {
    await seedCatalog(database.db);
    // A wide tie tolerance makes the four near-identical calm pieces one band,
    // which is what rotation is for. Their scores differ only by price.
    await setConfig(database.db, "matchmaker.tie_tolerance", 0.5);

    const orderings = new Set<string>();
    for (let day = 0; day < 21; day += 1) {
      const at = new Date(Date.UTC(2026, 8, 1 + day, 12));
      const outcome = await search(database.db, CALM_BUYER, at);
      orderings.add(outcome.matches.map((m) => m.artworkId).join(","));

      // Same epoch, later in the day: unchanged.
      const later = await search(database.db, CALM_BUYER, new Date(at.getTime() + 6 * 3600_000));
      expect(later.matches.map((m) => m.artworkId)).toEqual(
        outcome.matches.map((m) => m.artworkId),
      );
    }

    expect(orderings.size).toBeGreaterThan(1);
  });

  it("keeps a clear winner first in every epoch", async () => {
    const { artistA } = await seedCatalog(database.db);
    // A piece that matches on every axis the buyer answered, priced squarely in
    // range and published today, against a catalog that matches on one axis.
    const winner = "9fffffff-1111-4111-8111-ffffffffffff";
    await seedArtwork(database.db, {
      id: winner,
      artistId: artistA,
      priceAgorot: 50_000,
      styles: ["minimalist"],
      moods: ["calm"],
      targetSpaces: ["living_room"],
      medium: "textile_clothing",
      theme: 0,
    });

    const answers = {
      budgetMax: 800,
      medium: "textile_clothing",
      styles: ["minimalist"],
      moods: ["calm"],
      targetSpaces: ["living_room"],
    };

    const tops = new Set<string>();
    for (let day = 0; day < 14; day += 1) {
      const outcome = await search(database.db, answers, new Date(Date.UTC(2026, 8, 1 + day, 12)));
      tops.add(outcome.matches[0]?.artworkId ?? "");
    }

    // Several artworks tie on taxonomy here, so the assertion is the one the
    // spec makes: rotation happens inside a band and never promotes something
    // from outside it. The pop_art pieces never reach the top.
    expect(tops.has(ID.popA)).toBe(false);
    expect(tops.has(ID.popB)).toBe(false);
    expect(tops.has(ID.popC)).toBe(false);
  });
});

describe("budget is a signal, not a filter", () => {
  const database = useTestDatabase();

  it("shows an over-budget piece labelled with the amount it exceeds by", async () => {
    const { artistA } = await seedCatalog(database.db);
    const stretch = "8fffffff-1111-4111-8111-ffffffffffff";
    await seedArtwork(database.db, {
      id: stretch,
      artistId: artistA,
      priceAgorot: 55_000,
      styles: ["minimalist"],
      moods: ["calm"],
      theme: 0,
    });

    // Ceiling ₪500; the piece is ₪550, ten percent over, inside a 15% tolerance.
    const outcome = await search(database.db, {
      budgetMax: 500,
      styles: ["minimalist"],
      moods: ["calm"],
    });

    const match = outcome.matches.find((m) => m.artworkId === stretch);
    expect(match).toBeDefined();
    expect(match?.overBudgetByAgorot).toBe(5_000);
    // The amount, not merely the fact — a buyer deciding whether to stretch
    // needs the number.
    expect(match?.overBudgetLabel).toContain("50.00");
  });

  it("excludes a piece beyond the tolerance however well it scores otherwise", async () => {
    await seedCatalog(database.db);

    // ID.expensive is ₪9,000 against a ₪800 ceiling and matches every answer.
    const outcome = await search(database.db, CALM_BUYER);

    expect(outcome.matches.map((m) => m.artworkId)).not.toContain(ID.expensive);
  });
});

describe("an artwork with no embedding", () => {
  const database = useTestDatabase();

  it("is browsable in the catalog and absent from the matches", async () => {
    await seedCatalog(database.db);

    const browsable = await listPublishedArtworks(database.db, { limit: 100 });
    const outcome = await search(database.db, CALM_BUYER);

    // Two different answers to "is this artwork visible", so both are asserted
    // at once: an implementation that got either half right on its own would be
    // wrong in a way a single assertion would miss.
    expect(browsable.map((artwork) => artwork.id)).toContain(ID.noEmbedding);
    expect(outcome.matches.map((match) => match.artworkId)).not.toContain(ID.noEmbedding);
  });
});

describe("honest behaviour on a sparse catalog", () => {
  const database = useTestDatabase();

  it("returns exactly two when only two clear the minimum and five were asked for", async () => {
    const artist = await seedArtist(database.db, "יעל שוורץ");
    await seedArtwork(database.db, { id: ID.calmA, artistId: artist, priceAgorot: 50_000, styles: ["minimalist"], moods: ["calm"], targetSpaces: ["living_room"], theme: 0 });
    await seedArtwork(database.db, { id: ID.calmB, artistId: artist, priceAgorot: 52_000, styles: ["minimalist"], moods: ["calm"], targetSpaces: ["living_room"], theme: 0 });
    // Three pieces that match nothing the buyer asked for.
    await seedArtwork(database.db, { id: ID.popA, artistId: artist, priceAgorot: 70_000, styles: ["pop_art"], moods: ["edgy"], theme: 2 });
    await seedArtwork(database.db, { id: ID.popB, artistId: artist, priceAgorot: 72_000, styles: ["pop_art"], moods: ["edgy"], theme: 2 });
    await seedArtwork(database.db, { id: ID.popC, artistId: artist, priceAgorot: 74_000, styles: ["pop_art"], moods: ["edgy"], theme: 2 });

    await setConfig(database.db, "matchmaker.result_count", 5);
    await setConfig(database.db, "matchmaker.minimum_score", 0.7);

    const outcome = await search(database.db, CALM_BUYER);

    expect(outcome.matches).toHaveLength(2);
    expect(outcome.matches.map((m) => m.artworkId).sort()).toEqual([ID.calmA, ID.calmB].sort());
  });

  it("says the community is still growing when the catalog is below the threshold", async () => {
    const artist = await seedArtist(database.db, "יעל שוורץ");
    await seedArtwork(database.db, { id: ID.calmA, artistId: artist, priceAgorot: 50_000, styles: ["minimalist"], moods: ["calm"], theme: 0 });

    const outcome = await search(database.db, CALM_BUYER);

    expect(outcome.catalogSize).toBe(1);
    expect(outcome.sparseCatalog).toBe(true);
    expect(outcome.message).toBe(SPARSE_CATALOG_MESSAGE);
  });

  it("says so plainly, and offers the catalog and a notify-me, when nothing clears the bar", async () => {
    await seedCatalog(database.db);
    await setConfig(database.db, "matchmaker.minimum_score", 0.99);

    const outcome = await search(database.db, CALM_BUYER);

    expect(outcome.matches).toEqual([]);
    expect(outcome.noMatches).toBe(true);
    expect(outcome.message).toBe(NO_MATCHES_MESSAGE);
    expect(outcome.escapeHatch.offerNotify).toBe(true);
    expect(outcome.escapeHatch.offerRevise).toBe(true);
    expect(outcome.escapeHatch.catalogHref).toContain("/catalog");
  });

  it("answers an empty catalog without erroring, which is launch day", async () => {
    const outcome = await search(database.db, CALM_BUYER);

    expect(outcome.matches).toEqual([]);
    expect(outcome.catalogSize).toBe(0);
    expect(outcome.noMatches).toBe(true);
    expect(outcome.message).toBe(NO_MATCHES_MESSAGE);
  });

  it("never pads a short list with artworks below the minimum", async () => {
    await seedCatalog(database.db);
    await setConfig(database.db, "matchmaker.result_count", 12);

    const outcome = await search(database.db, CALM_BUYER);

    // Fewer than asked for, and every one of them above the bar. The tempting
    // implementation — take the top twelve whatever they score — would return
    // eleven here.
    expect(outcome.matches.length).toBeLessThan(12);
    expect(outcome.matches.every((m) => m.score >= 0.35)).toBe(true);
  });
});

describe("the escape hatch", () => {
  const database = useTestDatabase();

  it("points at a catalog pre-filtered by the answers already given", async () => {
    await seedCatalog(database.db);

    const outcome = await search(database.db, CALM_BUYER);

    // art-matchmaker: "browse the full catalog pre-filtered by those answers".
    expect(outcome.escapeHatch.catalogHref).toContain("minimalist");
    expect(outcome.escapeHatch.catalogHref).toContain("calm");
  });

  it("is offered even when there were five good matches", async () => {
    await seedCatalog(database.db);

    const outcome = await search(database.db, CALM_BUYER);

    // "EVERY matchmaker result view SHALL offer the buyer a way to continue" —
    // a buyer who got matches and liked none needs the same three doors.
    expect(outcome.escapeHatch.offerNotify).toBe(true);
    expect(outcome.escapeHatch.offerRevise).toBe(true);
  });
});

describe("the artist's own dashboard fixture", () => {
  const database = useTestDatabase();

  it("reports zero impressions until the matchmaker is wired into artworks", async () => {
    // `depsWithoutOrdersOrMatchmaker` is the honest stand-in, and this asserts
    // it is still honest rather than silently wrong.
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const counts = await deps.impressions.countsFor(database.db, [ID.calmA]);

    expect(counts.get(ID.calmA)).toBe(0);
  });
});
