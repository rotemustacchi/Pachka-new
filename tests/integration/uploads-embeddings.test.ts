/**
 * The embedding: once per primary image, never at query time.
 *
 * TWO THINGS ARE EXPENSIVE TO GET WRONG HERE
 * ------------------------------------------
 * "Recomputed only when the primary image changes." The obvious way to test
 * that is to count calls on the fake embedder, which ARCHITECTURE.md forbids
 * and which would prove nothing about what is STORED. So the embedder here
 * returns a DIFFERENT vector every time it is called: a stored vector that has
 * not moved is proof no recompute happened, and one that has moved is proof one
 * did. Both are assertions about a row.
 *
 * "Browsable but excluded from matchmaker results." Two different answers to
 * "is this artwork visible", so the tests assert both at once -- present in
 * `artworks.listPublishedArtworks`, absent from `matchmakerExclusion().rankable`
 * -- because an implementation that got either half right on its own would be
 * wrong in a way a single assertion would miss.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  listPublishedArtworks,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import {
  embeddingFor,
  embeddingText,
  embeddingVectorFor,
  eventsFor,
  matchmakerExclusion,
  processUpload,
  publishArtwork,
  EMBEDDING_DIMENSIONS,
  type Bucket,
  type Embedder,
  type ObjectStore,
  type StoredObject,
  type UploadsDeps,
  type VisionAnalyst,
} from "@/modules/uploads";
import type { Database } from "@/shared/db";
import { useTestDatabase } from "../harness";

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
      dominantColours: [{ hex: "#8899aa", name: "כחול אפור" }],
      description: "ציור אקריליק בגוונים כחולים, שכבות דקות וקו אופק ברור.",
    };
  },
};

/**
 * A different vector on every call, so "was it recomputed" is answerable from
 * the stored row rather than from a call count.
 *
 * The first component counts calls; the rest are a fixed ramp, so two vectors
 * differ in exactly one place and a diff is readable when a test fails.
 */
function countingEmbedder(): Embedder {
  let calls = 0;
  return {
    async embed() {
      calls += 1;
      const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 10_000);
      vector[0] = calls;
      return { vector, model: "test-embed-v1" };
    },
  };
}

const failingEmbedder: Embedder = {
  async embed() {
    throw new Error("embedding provider unavailable");
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

/**
 * Make an image primary.
 *
 * Not `artworks.setPrimaryImage`, which raises on every call: it swaps through
 * `position = -1` and the column's check constraint is `between 0 and 49`. That
 * defect is reported to the lead architect; `artwork_images` belongs to
 * `artworks` and this agent may not write that module. The swap here goes
 * through 49 so these tests can exercise the behaviour the spec asks for.
 */
async function makePrimary(db: Database, artworkId: string, imageId: string): Promise<void> {
  await db.withTransaction(async (tx) => {
    const target = await tx.one<{ position: number }>(
      "select position from artwork_images where id = $1 and artwork_id = $2",
      [imageId, artworkId],
    );
    if (target.position === 0) return;
    await tx.query("update artwork_images set position = 49 where id = $1", [imageId]);
    await tx.query(
      "update artwork_images set position = $2 where artwork_id = $1 and position = 0",
      [artworkId, target.position],
    );
    await tx.query("update artwork_images set position = 0 where id = $1", [imageId]);
  });
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

function uploadsDeps(db: Database, embedder: Embedder): UploadsDeps {
  return {
    db,
    store: memoryStore(),
    vision: approvingAnalyst,
    embedder,
    artworks: artworksDeps(db),
    retry: { attempts: 3, backoffMs: [0, 0] },
  };
}

async function draftWithImage(db: Database, deps: UploadsDeps, seed = 5) {
  const artistId = await seedArtist(db);
  const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
  const upload = await processUpload(deps, {
    artistId,
    artworkId: draft.id,
    bytes: await photograph(seed),
  });
  return { artistId, artworkId: draft.id, image: upload.image };
}

// ---------------------------------------------------------------------------

describe("an embedding is stored on publication", () => {
  const database = useTestDatabase();

  it("exists alongside the artwork record once it is published", async () => {
    const deps = uploadsDeps(database.db, countingEmbedder());
    const { artistId, artworkId, image } = await draftWithImage(database.db, deps);

    const outcome = await publishArtwork(deps, artistId, artworkId);

    expect(outcome.artwork.status).toBe("published");
    expect(outcome.embedding.status).toBe("stored");

    const stored = await embeddingFor(database.db, artworkId);
    expect(stored?.imageId).toBe(image.id);
    expect(stored?.model).toBe("test-embed-v1");

    const vector = await embeddingVectorFor(database.db, artworkId);
    expect(vector?.length).toBe(EMBEDDING_DIMENSIONS);
  });

  it("is computed from the description AND the taxonomy, not the description alone", async () => {
    // design.md: "one embedding call over that description plus the taxonomy
    // values". An embedding built from the description alone would rank
    // plausibly and be wrong in a way no assertion on the vector could catch.
    const text = embeddingText({
      medium: "painting_illustration",
      styles: ["minimalist"],
      moods: ["calm"],
      targetSpaces: ["living_room"],
      description: "ציור אקריליק",
    });

    expect(text).toContain("painting_illustration");
    expect(text).toContain("minimalist");
    expect(text).toContain("living_room");
    expect(text).toContain("ציור אקריליק");
  });

  it("records the fact, so an admin can see which model produced it", async () => {
    const deps = uploadsDeps(database.db, countingEmbedder());
    const { artistId, artworkId } = await draftWithImage(database.db, deps);

    await publishArtwork(deps, artistId, artworkId);

    const events = await eventsFor(database.db, artworkId);
    const stored = events.find((event) => event.event === "embedding_stored");
    expect(stored?.detail).toMatchObject({ model: "test-embed-v1", recomputed: false });
  });
});

describe("the embedding is recomputed only when the primary image changes", () => {
  const database = useTestDatabase();

  it("does not move when the artwork is published again with the same image", async () => {
    const deps = uploadsDeps(database.db, countingEmbedder());
    const { artistId, artworkId } = await draftWithImage(database.db, deps);

    const first = await publishArtwork(deps, artistId, artworkId);
    const firstVector = await embeddingVectorFor(database.db, artworkId);
    const firstStored = await embeddingFor(database.db, artworkId);

    const second = await publishArtwork(deps, artistId, artworkId);
    const secondVector = await embeddingVectorFor(database.db, artworkId);

    expect(first.embedding.status).toBe("stored");
    expect(second.embedding.status).toBe("unchanged");
    // The embedder returns a different vector on every call, so an unchanged
    // stored vector is proof it was not called again.
    expect(secondVector).toEqual(firstVector);
    expect((await embeddingFor(database.db, artworkId))?.updatedAt).toEqual(firstStored?.updatedAt);
  });

  it("moves when a different image becomes primary", async () => {
    const deps = uploadsDeps(database.db, countingEmbedder());
    const { artistId, artworkId } = await draftWithImage(database.db, deps, 5);

    await publishArtwork(deps, artistId, artworkId);
    const before = await embeddingVectorFor(database.db, artworkId);

    const second = await processUpload(deps, {
      artistId,
      artworkId,
      bytes: await photograph(9),
    });
    // A second, non-primary image alone changes nothing.
    await publishArtwork(deps, artistId, artworkId);
    expect(await embeddingVectorFor(database.db, artworkId)).toEqual(before);

    await makePrimary(database.db, artworkId, second.image.id);
    const outcome = await publishArtwork(deps, artistId, artworkId);

    expect(outcome.embedding.status).toBe("stored");
    const after = await embeddingVectorFor(database.db, artworkId);
    expect(after).not.toEqual(before);
    expect((await embeddingFor(database.db, artworkId))?.imageId).toBe(second.image.id);
  });

  it("replaces the row rather than accumulating a second one", async () => {
    const deps = uploadsDeps(database.db, countingEmbedder());
    const { artistId, artworkId } = await draftWithImage(database.db, deps, 5);
    await publishArtwork(deps, artistId, artworkId);

    const second = await processUpload(deps, { artistId, artworkId, bytes: await photograph(9) });
    await makePrimary(database.db, artworkId, second.image.id);
    await publishArtwork(deps, artistId, artworkId);

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from artwork_embeddings where artwork_id = $1",
      [artworkId],
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("an artwork with no embedding", () => {
  const database = useTestDatabase();

  it("is still published and still browsable when embedding generation fails", async () => {
    // upload-pipeline, "Embedding generation fails": "the artwork is still
    // published and remains browsable in the catalog".
    const deps = uploadsDeps(database.db, failingEmbedder);
    const { artistId, artworkId } = await draftWithImage(database.db, deps);

    const outcome = await publishArtwork(deps, artistId, artworkId);

    expect(outcome.artwork.status).toBe("published");
    expect(outcome.embedding.status).toBe("failed");

    const browsable = await listPublishedArtworks(database.db, { limit: 50 });
    expect(browsable.map((artwork) => artwork.id)).toContain(artworkId);
  });

  it("is excluded from matchmaker results until an embedding exists", async () => {
    const failing = uploadsDeps(database.db, failingEmbedder);
    const { artistId, artworkId } = await draftWithImage(database.db, failing);
    await publishArtwork(failing, artistId, artworkId);

    const exclusion = matchmakerExclusion();
    expect([...(await exclusion.rankable(database.db, [artworkId]))]).toEqual([]);

    // "until an embedding exists" -- once one does, it is rankable, with no
    // flag to clear and nothing to keep in sync.
    const working = uploadsDeps(database.db, countingEmbedder());
    await publishArtwork(working, artistId, artworkId);

    expect([...(await exclusion.rankable(database.db, [artworkId]))]).toEqual([artworkId]);
  });

  it("is separated from the ones that do have embeddings in a single query", async () => {
    // The matchmaker ranks a SET. A query per candidate per questionnaire is
    // the traffic-scaled cost the whole design exists to avoid.
    const ranked = uploadsDeps(database.db, countingEmbedder());
    const unranked = uploadsDeps(database.db, failingEmbedder);

    const withEmbedding = await draftWithImage(database.db, ranked, 5);
    await publishArtwork(ranked, withEmbedding.artistId, withEmbedding.artworkId);

    const withoutEmbedding = await draftWithImage(database.db, unranked, 21);
    await publishArtwork(unranked, withoutEmbedding.artistId, withoutEmbedding.artworkId);

    const rankable = await matchmakerExclusion().rankable(database.db, [
      withEmbedding.artworkId,
      withoutEmbedding.artworkId,
    ]);

    expect([...rankable]).toEqual([withEmbedding.artworkId]);

    // Both are browsable. That is the half a single assertion would miss.
    const browsable = (await listPublishedArtworks(database.db, { limit: 50 })).map((a) => a.id);
    expect(browsable).toContain(withEmbedding.artworkId);
    expect(browsable).toContain(withoutEmbedding.artworkId);
  });

  it("records the failure so it is visible rather than silent", async () => {
    const deps = uploadsDeps(database.db, failingEmbedder);
    const { artistId, artworkId } = await draftWithImage(database.db, deps);
    await publishArtwork(deps, artistId, artworkId);

    const events = await eventsFor(database.db, artworkId);
    expect(events.map((event) => event.event)).toContain("embedding_failed");
  });
});

describe("the description the vector is computed from", () => {
  const database = useTestDatabase();

  it("carries no contact details into artwork_embeddings", async () => {
    // SECURITY.md S2-19, verbatim: "Feed a vision-client fake that returns a
    // description containing `call me on 0501234567`. Assert the stored
    // `artwork_embeddings` description ... contain neither the digits nor a
    // normalised form of them."
    //
    // The model will faithfully transcribe a phone number painted onto the
    // canvas, and the description is a channel around the contact scanner if it
    // is allowed to skip it.
    const leaking: VisionAnalyst = {
      async analyse() {
        return {
          safety: { verdict: "safe", confidence: 0.01, categories: [] },
          medium: "painting_illustration",
          styles: ["minimalist"],
          moods: ["calm"],
          targetSpaces: ["living_room"],
          dominantColours: [],
          description: "ציור נוף. call me on 0501234567 for a better price.",
        };
      },
    };

    const deps: UploadsDeps = { ...uploadsDeps(database.db, countingEmbedder()), vision: leaking };
    const { artistId, artworkId } = await draftWithImage(database.db, deps);
    await publishArtwork(deps, artistId, artworkId);

    const stored = await embeddingFor(database.db, artworkId);
    expect(stored?.description ?? "").not.toContain("0501234567");
    expect(stored?.description ?? "").not.toMatch(/\d{7,}/);
  });

  it("POSITIVE CONTROL: a clean description does reach the stored embedding", async () => {
    // Otherwise the assertion above could pass because no description ever
    // makes it into the row.
    const deps = uploadsDeps(database.db, countingEmbedder());
    const { artistId, artworkId } = await draftWithImage(database.db, deps);
    await publishArtwork(deps, artistId, artworkId);

    expect(await embeddingFor(database.db, artworkId)).toMatchObject({
      description: "ציור אקריליק בגוונים כחולים, שכבות דקות וקו אופק ברור.",
    });
  });
});

describe("the vector column and the code agree about its width", () => {
  const database = useTestDatabase();

  it("holds exactly EMBEDDING_DIMENSIONS components", async () => {
    // The width is baked into the column type, so a constant that drifted from
    // it would fail at the first insert in production and nowhere earlier.
    const row = await database.db.one<{ declared: string }>(
      `select format_type(atttypid, atttypmod) as declared
         from pg_attribute
        where attrelid = 'artwork_embeddings'::regclass and attname = 'embedding'`,
    );

    expect(row.declared).toBe(`vector(${EMBEDDING_DIMENSIONS})`);
  });

  it("refuses a vector of the wrong width rather than storing a truncated one", async () => {
    const deps: UploadsDeps = {
      ...uploadsDeps(database.db, countingEmbedder()),
      embedder: {
        async embed() {
          return { vector: [0.1, 0.2, 0.3], model: "wrong-width" };
        },
      },
    };
    const { artistId, artworkId } = await draftWithImage(database.db, deps);

    const outcome = await publishArtwork(deps, artistId, artworkId);

    expect(outcome.artwork.status).toBe("published");
    expect(outcome.embedding.status).toBe("failed");
    expect(await embeddingFor(database.db, artworkId)).toBeNull();
  });
});
