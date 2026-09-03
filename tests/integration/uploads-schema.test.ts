/**
 * The invariants that hold across the whole module, rather than inside one
 * function.
 *
 * Three kinds live here:
 *
 *   SCHEMA. The closed event set is stated in `events.ts` and again as a check
 *   constraint; the vector width is stated in `embeddings.ts` and again in the
 *   column type. Drift between a pair fails the suite instead of shipping.
 *
 *   ACCESS. SECURITY.md's RLS matrix gives `upload_events` "anon: none,
 *   authenticated: own artworks only" and `artwork_embeddings` "none / none /
 *   server only" with the note "Contains the AI description". Those are checked
 *   through the data-API role, not the server's, because a superuser or a
 *   BYPASSRLS role cannot tell a working policy from a missing one.
 *
 *   SOURCE. Two rules that a future edit can break silently and that no runtime
 *   assertion reaches: `.withMetadata()` must never appear in this module
 *   (SECURITY.md S1-9 names it as the trap), and no compositing step may be
 *   added to the derivative encoder (upload-pipeline forbids a watermark). A
 *   grep over the module's own source is a blunt instrument and is the right
 *   one: it catches the change at the moment it is made, in the file where it
 *   was made.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import { noFlaggedUploads, type FlaggedUploadSource } from "@/modules/moderation";
import {
  assertPipelineProduced,
  flaggedUploadSource,
  isPipelineProduced,
  processUpload,
  UPLOAD_EVENTS,
  type Bucket,
  type Embedder,
  type ObjectStore,
  type StoredObject,
  type UploadsDeps,
  type VisionAnalyst,
} from "@/modules/uploads";
import type { Database } from "@/shared/db";
import { asAnon, asUser, useTestDatabase } from "../harness";

const MODULE_DIR = path.join(process.cwd(), "src", "modules", "uploads");

function moduleSources(): { readonly name: string; readonly source: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((name) => ({ name, source: readFileSync(path.join(MODULE_DIR, name), "utf8") }));
}

/** Strip comments, so this file's own prose about `.withMetadata()` is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

// ---------------------------------------------------------------------------

function noisyImage(width: number, height: number, seed: number): Sharp {
  const data = Buffer.alloc(width * height * 3);
  let state = seed >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i] = (state >>> 24) & 0xff;
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

function photograph(seed = 5): Promise<Buffer> {
  return noisyImage(1400, 1400, seed).jpeg({ quality: 92 }).toBuffer();
}

function memoryStore(): ObjectStore {
  const contents = new Map<string, StoredObject>();
  return {
    async put(bucket: Bucket, key: string, object: StoredObject) {
      contents.set(`${bucket}/${key}`, object);
    },
    async get(bucket: Bucket, key: string) {
      return contents.get(`${bucket}/${key}`) ?? null;
    },
    async remove(bucket: Bucket, key: string) {
      contents.delete(`${bucket}/${key}`);
    },
  };
}

const approvingAnalyst: VisionAnalyst = {
  async analyse() {
    return {
      safety: { verdict: "safe", confidence: 0.01, categories: [] },
      medium: "painting_illustration",
      styles: ["minimalist"],
      moods: ["calm"],
      targetSpaces: ["living_room"],
      dominantColours: [],
      description: "ציור אקריליק בגוונים כחולים.",
    };
  },
};

const constantEmbedder: Embedder = {
  async embed() {
    return { vector: Array.from({ length: 1024 }, () => 0.03), model: "test-embed" };
  },
};

async function seedArtist(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  return id;
}

const DRAFT: ArtworkInput = {
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

function artworksDeps(db: Database): ArtworksDeps {
  return depsWithoutOrdersOrMatchmaker(db);
}

function uploadsDeps(db: Database): UploadsDeps {
  return {
    db,
    store: memoryStore(),
    vision: approvingAnalyst,
    embedder: constantEmbedder,
    artworks: artworksDeps(db),
    retry: { attempts: 3, backoffMs: [0, 0] },
  };
}

// ---------------------------------------------------------------------------

describe("the closed event set", () => {
  const database = useTestDatabase();

  it("is the same in the migration's check constraint as in events.ts", async () => {
    const row = await database.db.one<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'upload_events'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%event%'`,
    );

    for (const event of UPLOAD_EVENTS) {
      expect(row.definition, `${event} is missing from the check constraint`).toContain(
        `'${event}'`,
      );
    }
    // And nothing in the constraint that the application does not know about:
    // count the quoted literals rather than trusting the loop above.
    const quoted = row.definition.match(/'[a-z_]+'/g) ?? [];
    expect(new Set(quoted.map((value) => value.slice(1, -1)))).toEqual(new Set(UPLOAD_EVENTS));
  });

  it("refuses an event the constraint does not know", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);

    await expect(
      database.db.query(
        "insert into upload_events (artwork_id, artist_id, event) values ($1, $2, 'made_up')",
        [draft.id, artistId],
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });
});

describe("the module's tables are reachable exactly as the RLS matrix says", () => {
  const database = useTestDatabase();

  async function seedUpload(db: Database) {
    const artistId = await seedArtist(db);
    const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
    const result = await processUpload(uploadsDeps(db), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });
    return { artistId, artworkId: draft.id, imageId: result.image.id };
  }

  it("shows an anonymous visitor no upload events at all", async () => {
    await seedUpload(database.db);

    await expect(
      asAnon(database.dataApi, (sql) => sql.query("select id from upload_events")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("shows an artist their own artwork's events", async () => {
    const { artistId } = await seedUpload(database.db);

    const { rows } = await asUser(database.dataApi, artistId, (sql) =>
      sql.query<{ event: string }>("select event from upload_events"),
    );

    expect(rows.map((row) => row.event)).toContain("screening_passed");
  });

  it("shows one artist nothing of another's", async () => {
    await seedUpload(database.db);
    const stranger = await seedArtist(database.db);

    const { rows } = await asUser(database.dataApi, stranger, (sql) =>
      sql.query("select event from upload_events"),
    );

    expect(rows).toEqual([]);
  });

  it("lets nobody but the server near an embedding, because it holds the AI description", async () => {
    // SECURITY.md's RLS matrix: `artwork_embeddings` is none / none / server
    // only. Not a narrow grant -- no grant.
    const { artistId } = await seedUpload(database.db);

    await expect(
      asAnon(database.dataApi, (sql) => sql.query("select artwork_id from artwork_embeddings")),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(database.dataApi, artistId, (sql) =>
        sql.query("select artwork_id from artwork_embeddings"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a browser write to the event log, so the gate cannot be forged", async () => {
    // An INSERT policy here would let an artist append their own
    // `screening_passed` row and publish an unscreened image.
    const { artistId, artworkId } = await seedUpload(database.db);

    await expect(
      asUser(database.dataApi, artistId, (sql) =>
        sql.query(
          "insert into upload_events (artwork_id, artist_id, event) values ($1, $2, 'screening_passed')",
          [artworkId, artistId],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("is append-only even for the server: no update and no delete policy exists", async () => {
    const { artworkId } = await seedUpload(database.db);

    await expect(
      database.db.query("update upload_events set event = 'screening_passed' where artwork_id = $1", [
        artworkId,
      ]),
    ).rejects.toThrow(/permission denied|row-level security/i);

    await expect(
      database.db.query("delete from upload_events where artwork_id = $1", [artworkId]),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

describe("the pipeline is the only way an image gets attached", () => {
  const database = useTestDatabase();

  it("recognises a path it produced", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const result = await processUpload(uploadsDeps(database.db), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(await isPipelineProduced(database.db, draft.id, result.image.originalPath)).toBe(true);
    await expect(
      assertPipelineProduced(database.db, draft.id, [
        result.image.originalPath,
        result.image.displayPath as string,
      ]),
    ).resolves.toBeUndefined();
  });

  it("refuses a path a client chose, even one under the artwork's own prefix", async () => {
    // SECURITY.md S1-15: the prefix check in `artworks.attachImage` stops
    // cross-artist writes; it does not stop an artist naming an object of their
    // own that the pipeline never produced -- which is the whole bypass, since
    // the quality gate, the screening and the EXIF strip all ran on some other
    // file or on none.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    await processUpload(uploadsDeps(database.db), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    const forged = `${draft.id}/${randomUUID()}.jpg`;
    expect(await isPipelineProduced(database.db, draft.id, forged)).toBe(false);
    await expect(
      assertPipelineProduced(database.db, draft.id, [forged]),
    ).rejects.toMatchObject({ kind: "forbidden", code: "uploads.path_not_produced_by_pipeline" });
  });

  it("leaves a derivatives_stored event behind every artwork_images row", async () => {
    // SECURITY.md S1-15's last test: "assert that for every row in
    // `artwork_images`, a corresponding `upload_events` row exists recording a
    // completed quality check. Make this a schema-level invariant test over
    // seeded data produced only through public code paths."
    const deps = uploadsDeps(database.db);
    for (const seed of [5, 9, 21]) {
      const artistId = await seedArtist(database.db);
      const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
      await processUpload(deps, { artistId, artworkId: draft.id, bytes: await photograph(seed) });
    }

    const { rows } = await database.db.query<{ original_path: string }>(
      `select i.original_path
         from artwork_images i
        where not exists (
          select 1 from upload_events e
           where e.artwork_id = i.artwork_id
             and e.event = 'derivatives_stored'
             and e.detail ->> 'originalPath' = i.original_path
        )`,
    );

    expect(rows.map((row) => row.original_path)).toEqual([]);
  });
});

describe("what other modules are handed", () => {
  const database = useTestDatabase();

  it("satisfies moderation's FlaggedUploadSource port", async () => {
    // The compile-time half: if either shape moves, this stops compiling. The
    // duplication in `contracts.ts` is what keeps the dependency arrow pointing
    // moderation -> uploads rather than back.
    const source: FlaggedUploadSource = flaggedUploadSource();

    // And the runtime half: it answers the same question the stand-in answers,
    // on a database with nothing flagged in it.
    expect(await source.flaggedForReview(database.db, 10)).toEqual(
      await noFlaggedUploads.flaggedForReview(database.db, 10),
    );
  });
});

describe("the two rules a future edit could break silently", () => {
  it("never re-attaches metadata anywhere in the module", () => {
    // SECURITY.md S1-9: `.withMetadata()` is "the standard fix people reach for
    // when images come out rotated, and it re-attaches everything, GPS
    // included". The correct fix is `.rotate()`.
    const offenders = moduleSources()
      .filter(({ source }) =>
        /\.(withMetadata|keepMetadata|keepExif|keepXmp|keepIccProfile)\s*\(/.test(
          stripComments(source),
        ),
      )
      .map(({ name }) => name);

    expect(
      offenders,
      `these re-attach metadata to a derivative, GPS included (SECURITY.md S1-9): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("never composites anything onto a derivative", () => {
    // upload-pipeline: "Displayed images SHALL NOT carry a watermark." A
    // deliberate product decision, and the thing somebody adds later without
    // thinking of it as a spec change.
    const offenders = moduleSources()
      .filter(({ source }) => /\.composite\s*\(/.test(stripComments(source)))
      .map(({ name }) => name);

    expect(
      offenders,
      `a composited overlay is a watermark, which upload-pipeline forbids: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("covers the file it is meant to cover", () => {
    // Guards against the two assertions above passing because the directory
    // read returned nothing.
    const names = moduleSources().map(({ name }) => name);

    expect(names).toContain("derivatives.ts");
    expect(names).toContain("pipeline.ts");
    expect(names.length).toBeGreaterThanOrEqual(10);
  });
});
