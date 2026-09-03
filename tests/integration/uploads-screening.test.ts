/**
 * Safety screening, the publication gate, and the model's response as an
 * attack surface.
 *
 * THE ONE THAT MATTERS MOST
 * -------------------------
 * "No image SHALL reach a public surface without a successful screening
 * verdict: a screening failure blocks publication, never merely warns"
 * (upload-pipeline). SECURITY.md SPEC-C explains why the weaker reading is not
 * available: an attacker who can burn the vision API's rate limit chooses when
 * screening is "unavailable", so a design where unavailable means "publish with
 * a warning" hands them the decision. The tests below therefore assert the
 * artwork is UNPUBLISHABLE and stays that way across retries, not that a flag
 * was set somewhere.
 *
 * A note on the fakes. Only the three boundaries in `ports.ts` are faked, and
 * every assertion is about a row, a returned value or a raised error -- never
 * about whether a fake was called. Where the natural question IS "was the call
 * made", it is answered by an outcome only reachable one way; see
 * `uploads-pipeline.test.ts` for the same technique applied to the local gate.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  findPublicArtwork,
  imagesFor,
  listingLimits,
  publishArtwork as publishThroughArtworks,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import {
  clearScreening,
  eventsFor,
  flaggedUploadSource,
  parseAnalysis,
  primaryImageIsScreened,
  processUpload,
  publishArtwork,
  suggestionsFor,
  type Bucket,
  type Embedder,
  type ObjectStore,
  type StoredObject,
  type UploadsDeps,
  type VisionAnalyst,
} from "@/modules/uploads";
import { AppError } from "@/shared/errors";
import type { Database } from "@/shared/db";
import { useTestDatabase } from "../harness";

// ---------------------------------------------------------------------------

function noisyImage(width: number, height: number, seed: number): sharp.Sharp {
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

interface MemoryStore extends ObjectStore {
  readonly contents: Map<string, StoredObject>;
}

function memoryStore(): MemoryStore {
  const contents = new Map<string, StoredObject>();
  return {
    contents,
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

/** A response that passes screening and suggests a full, valid classification. */
function safeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    safety: { verdict: "safe", confidence: 0.01, categories: [] },
    medium: "painting_illustration",
    styles: ["minimalist"],
    moods: ["calm"],
    targetSpaces: ["living_room"],
    dominantColours: [{ hex: "#8899aa", name: "כחול אפור" }],
    description: "ציור אקריליק בגוונים כחולים, שכבות דקות וקו אופק ברור.",
    ...overrides,
  };
}

function analystReturning(...responses: unknown[]): VisionAnalyst {
  let index = 0;
  return {
    async analyse() {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

/** Rejects the way an unreachable vendor does. */
const unreachableAnalyst: VisionAnalyst = {
  async analyse() {
    throw AppError.externalFailure("connect ETIMEDOUT vision.example");
  },
};

const constantEmbedder: Embedder = {
  async embed() {
    return { vector: Array.from({ length: 1024 }, () => 0.02), model: "test-embed" };
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
 * This calls SQL rather than `artworks.setPrimaryImage`, and that is not a
 * shortcut -- it is a defect in `artworks` that this suite is the first caller
 * to hit. `setPrimaryImage` swaps two rows through a temporary `position = -1`,
 * and the `artwork_images_position_check` constraint added by the same
 * migration is `position between 0 and 49`, so every call raises. The function
 * has no test anywhere in the repository, which is why it has been shipping
 * broken.
 *
 * Reported to the lead architect rather than fixed here: `artwork_images`
 * belongs to `artworks` and this agent may not write that module. The swap
 * below goes through 49 -- inside the constraint, and outside any real slot --
 * so that these tests exercise the behaviour the spec asks for while the fix
 * lands where it belongs.
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

function uploadsDeps(db: Database, store: ObjectStore, vision: VisionAnalyst): UploadsDeps {
  return {
    db,
    store,
    vision,
    embedder: constantEmbedder,
    artworks: artworksDeps(db),
    retry: { attempts: 3, backoffMs: [0, 0] },
  };
}

// ---------------------------------------------------------------------------

describe("an image the screening flags", () => {
  const database = useTestDatabase();

  it("is blocked, with nothing stored and nothing attached", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const store = memoryStore();
    const analyst = analystReturning(
      safeResponse({ safety: { verdict: "unsafe", confidence: 0.94, categories: ["adult"] } }),
    );

    await expect(
      processUpload(uploadsDeps(database.db, store, analyst), {
        artistId,
        artworkId: draft.id,
        bytes: await photograph(),
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.screening_blocked" });

    // SECURITY.md S0-7: no `artwork_images` row, no object in any bucket.
    expect(await imagesFor(database.db, draft.id)).toEqual([]);
    expect([...store.contents.keys()]).toEqual([]);
  });

  it("is recorded for admin review, with the categories that caused it", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const analyst = analystReturning(
      safeResponse({ safety: { verdict: "unsafe", confidence: 0.94, categories: ["adult"] } }),
    );

    await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    }).catch(() => undefined);

    const events = await eventsFor(database.db, draft.id);
    expect(events.map((event) => event.event)).toContain("screening_blocked");
    expect(events[0]?.detail).toMatchObject({ categories: ["adult"], confidence: 0.94 });

    const queue = await flaggedUploadSource().flaggedForReview(database.db, 20);
    expect(queue.map((item) => item.artworkId)).toContain(draft.id);
  });

  it("is not blocked when its confidence sits below the configured threshold", async () => {
    // The threshold is what decides, not the verdict word. `upload-pipeline`:
    // block "any image the screening flags ABOVE the configured confidence
    // threshold", which is 0.70 by default.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const analyst = analystReturning(
      safeResponse({ safety: { verdict: "unsafe", confidence: 0.4, categories: ["violence"] } }),
    );

    const result = await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.screened).toBe(true);
  });
});

describe("a screening outage", () => {
  const database = useTestDatabase();

  async function uploadIntoOutage(db: Database) {
    const artistId = await seedArtist(db);
    const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
    const deps = uploadsDeps(db, memoryStore(), unreachableAnalyst);
    const result = await processUpload(deps, {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });
    return { artistId, artworkId: draft.id, deps, result };
  }

  it("still lets the upload land in the artist's draft", async () => {
    // The spec is careful about this: the artist must not lose their work
    // because a vendor is down.
    const { artworkId, result } = await uploadIntoOutage(database.db);

    expect(result.screened).toBe(false);
    expect(result.image.isPrimary).toBe(true);
    expect((await imagesFor(database.db, artworkId)).length).toBe(1);
  });

  it("blocks publication, and the artwork never becomes publicly visible", async () => {
    const { artistId, artworkId, deps } = await uploadIntoOutage(database.db);

    await expect(publishArtwork(deps, artistId, artworkId)).rejects.toMatchObject({
      kind: "conflict",
      code: "uploads.screening_incomplete",
    });

    // Not published, and not reachable by a buyer through the artworks read path.
    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(row.status).toBe("draft");
    // A buyer asking for it directly is told it does not exist, which is the
    // "no unscreened image reaches any public surface" half of the requirement.
    await expect(
      findPublicArtwork(artworksDeps(database.db), artworkId),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("stays blocked however many times the artist retries", async () => {
    // SECURITY.md S0-7 / upload-pipeline, "Screening failure is not a
    // publication bypass": an artist who repeatedly triggers failures and
    // attempts to publish gets nothing published.
    const { artistId, artworkId, deps } = await uploadIntoOutage(database.db);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(publishArtwork(deps, artistId, artworkId)).rejects.toMatchObject({
        code: "uploads.screening_incomplete",
      });
    }

    expect(await primaryImageIsScreened(database.db, artworkId)).toBe(false);
    await expect(
      findPublicArtwork(artworksDeps(database.db), artworkId),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("records the failure and puts the artwork in the admin queue", async () => {
    const { artworkId } = await uploadIntoOutage(database.db);

    const events = await eventsFor(database.db, artworkId);
    expect(events.map((event) => event.event)).toContain("screening_unavailable");

    const queue = await flaggedUploadSource().flaggedForReview(database.db, 20);
    const item = queue.find((entry) => entry.artworkId === artworkId);
    expect(item).toBeDefined();
    expect(item?.note).toContain("סינון");
  });

  it("presents an empty classification form rather than blocking the upload", async () => {
    // upload-pipeline, "Analysis fails": an empty form for manual completion,
    // and the upload is not blocked. The single-call design means an outage
    // costs both halves at once, so this is the same event.
    const { artworkId, result } = await uploadIntoOutage(database.db);

    expect(result.suggestions).toEqual({
      medium: null,
      styles: [],
      moods: [],
      targetSpaces: [],
      dominantColours: [],
      description: "",
    });
    expect(await suggestionsFor(database.db, artworkId)).toEqual(result.suggestions);
  });

  it("is lifted once an admin clears the image, and only then", async () => {
    const { artistId, artworkId, deps } = await uploadIntoOutage(database.db);
    const [image] = await imagesFor(database.db, artworkId);

    expect(await primaryImageIsScreened(database.db, artworkId)).toBe(false);

    await clearScreening(database.db, {
      artworkId,
      artistId,
      imageId: (image as { id: string }).id,
      adminId: randomUUID(),
      reason: "reviewed by hand; the photograph is a landscape painting",
    });

    expect(await primaryImageIsScreened(database.db, artworkId)).toBe(true);
    const published = await publishArtwork(deps, artistId, artworkId);
    expect(published.artwork.status).toBe("published");

    // The clearance is appended, not substituted: the outage is still on record.
    const events = await eventsFor(database.db, artworkId);
    expect(events.map((event) => event.event)).toContain("screening_unavailable");
    expect(events.map((event) => event.event)).toContain("screening_cleared_by_admin");
  });

  it("absorbs transient rate limiting instead of escalating it", async () => {
    // SECURITY.md S0-7 item 2: "A 429 or a timeout is *retryable*, not
    // *unavailable*... An attacker inducing 429s gets a delay, not a bypass."
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const analyst = analystReturning(
      AppError.rateLimited("429 Too Many Requests"),
      AppError.rateLimited("429 Too Many Requests"),
      safeResponse(),
    );

    const result = await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.screened).toBe(true);
    expect(result.flaggedForReview).toBe(false);

    // No admin queue item: transient rate limiting is absorbed, not escalated.
    const queue = await flaggedUploadSource().flaggedForReview(database.db, 20);
    expect(queue.map((item) => item.artworkId)).not.toContain(draft.id);
  });

  it("gives up once the retry budget is exhausted rather than retrying forever", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const analyst = analystReturning(
      AppError.rateLimited("429"),
      AppError.rateLimited("429"),
      AppError.rateLimited("429"),
      safeResponse(),
    );

    // Three attempts, three 429s: the fourth response is never reached and the
    // upload lands unscreened.
    const result = await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.screened).toBe(false);
    expect(result.flaggedForReview).toBe(true);
  });

  it("treats a response that does not match the schema as a screening failure", async () => {
    // SECURITY.md S2-20 item 3, the one-call fallback: "any parse deviation is
    // treated as a screening failure (which, per S0-7, blocks publication
    // rather than allowing it)". Emphatically not "assume safe".
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(
      database.db,
      memoryStore(),
      analystReturning({ verdict: "safe", tags: ["minimalist"] }),
    );

    const result = await processUpload(deps, {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.screened).toBe(false);
    await expect(publishArtwork(deps, artistId, draft.id)).rejects.toMatchObject({
      code: "uploads.screening_incomplete",
    });
  });
});

describe("replacing the primary image", () => {
  const database = useTestDatabase();

  it("re-arms the publication gate when the new image was never screened", async () => {
    // The gate reads the row at position 0, so an unscreened image becoming
    // primary blocks publication again without the artworks module
    // having to know this module exists.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const screened = uploadsDeps(database.db, memoryStore(), analystReturning(safeResponse()));

    const first = await processUpload(screened, {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(1),
    });
    expect(await primaryImageIsScreened(database.db, draft.id)).toBe(true);

    // A second image arrives while screening is down. It is not primary yet, so
    // the gate is still open.
    const outage = uploadsDeps(database.db, memoryStore(), unreachableAnalyst);
    const second = await processUpload(outage, {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(2),
    });
    expect(second.image.isPrimary).toBe(false);
    expect(await primaryImageIsScreened(database.db, draft.id)).toBe(true);

    await makePrimary(database.db, draft.id, second.image.id);

    expect(await primaryImageIsScreened(database.db, draft.id)).toBe(false);
    await expect(publishArtwork(outage, artistId, draft.id)).rejects.toMatchObject({
      code: "uploads.screening_incomplete",
    });

    // And swapping the screened one back restores it.
    await makePrimary(database.db, draft.id, first.image.id);
    expect(await primaryImageIsScreened(database.db, draft.id)).toBe(true);
  });

  it("blocks publication for an artwork that has no image at all", async () => {
    // The gate's default is no. An artwork with nothing at position 0 has no
    // screened primary image, which is the honest answer rather than a special
    // case somebody has to remember.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), analystReturning(safeResponse()));

    expect(await primaryImageIsScreened(database.db, draft.id)).toBe(false);
    await expect(publishArtwork(deps, artistId, draft.id)).rejects.toMatchObject({
      code: "uploads.screening_incomplete",
    });
  });

  it("PROVES THE GATE IS THE ONLY THING BLOCKING: artworks alone would publish it", async () => {
    // Without this, "publication is blocked" could be passing because the
    // artwork was incomplete for some unrelated reason. The same draft, the
    // same outage, published through `artworks` directly: it succeeds. That is
    // both the proof the gate is load-bearing and the reason the report to the
    // lead architect asks for a `ScreeningGate` port on `ArtworksDeps`.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const outage = uploadsDeps(database.db, memoryStore(), unreachableAnalyst);
    await processUpload(outage, { artistId, artworkId: draft.id, bytes: await photograph() });

    await expect(publishArtwork(outage, artistId, draft.id)).rejects.toMatchObject({
      code: "uploads.screening_incomplete",
    });

    const bypassed = await publishThroughArtworks(artworksDeps(database.db), artistId, draft.id);
    expect(bypassed.status).toBe("published");
  });
});

describe("text painted into the artwork cannot steer the classification", () => {
  const database = useTestDatabase();

  it("drops taxonomy values outside the closed set and records the drop", async () => {
    // SECURITY.md S2-20 item 1: "Every returned taxonomy value is checked
    // against the closed server-defined set... A value outside the set is
    // dropped, and the drop is recorded -- not coerced, not inserted."
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const analyst = analystReturning(
      safeResponse({
        styles: ["minimalist", "not-a-style", "<script>alert(1)</script>"],
        medium: "sculpture",
      }),
    );

    const result = await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.suggestions.styles).toEqual(["minimalist"]);
    expect(result.suggestions.medium).toBeNull();

    const events = await eventsFor(database.db, draft.id);
    const rejected = events.find((event) => event.event === "suggestions_rejected");
    expect(rejected?.detail).toMatchObject({
      medium: ["sculpture"],
      styles: ["not-a-style", "<script>alert(1)</script>"],
    });
  });

  it("caps the shape, so claiming everything ranks into nothing extra", async () => {
    // S2-20 item 2. Claiming every style and every space maximises taxonomy
    // overlap in the matchmaker's scoring and ranks the artwork into every
    // result set; the cap defuses it however the model was steered.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const limits = await listingLimits(database.db);
    const analyst = analystReturning(
      safeResponse({
        styles: ["minimalist", "abstract", "boho_coastal", "modern_industrial", "pop_art"],
        targetSpaces: ["living_room", "bedroom", "office_clinic", "childrens_room", "kitchen"],
        moods: ["calm", "bold", "romantic", "edgy"],
      }),
    );

    const result = await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.suggestions.styles.length).toBe(limits.maxStyles);
    expect(result.suggestions.targetSpaces.length).toBe(limits.maxTargetSpaces);
    expect(result.suggestions.moods.length).toBe(limits.maxMoods);
  });

  it("truncates a description to the configured maximum", async () => {
    const limits = await listingLimits(database.db);
    const parsed = parseAnalysis(safeResponse({ description: "א".repeat(50_000) }), limits);

    expect(parsed?.suggestions.description.length).toBe(limits.maxDescriptionLength);
    expect(parsed?.rejected.descriptionTruncated).toBe(true);
  });

  it("discards a description carrying contact details rather than storing it", async () => {
    // S2-19 and S2-20 item 4: the model will faithfully transcribe a phone
    // number painted onto a canvas, and the description is a channel around
    // the contact scanner if it is allowed to skip it.
    const limits = await listingLimits(database.db);
    const parsed = parseAnalysis(
      safeResponse({ description: "ציור יפה. אפשר להתקשר אליי 050-111-2222 לפרטים." }),
      limits,
    );

    expect(parsed?.suggestions.description).toBe("");
    expect(parsed?.rejected.descriptionRedacted).toBe(true);
  });

  it("refuses a response with an unexpected top-level key outright", async () => {
    // `strict()`: a response that is not the thing we asked for is a parse
    // deviation, and a parse deviation is a screening failure.
    const limits = await listingLimits(database.db);

    expect(parseAnalysis(safeResponse({ overrideSafety: true }), limits)).toBeNull();
  });

  it("refuses a colour that is not a colour", async () => {
    // A swatch is rendered into a style attribute. "Any string the model felt
    // like" in a style attribute is a CSS injection.
    const limits = await listingLimits(database.db);

    expect(
      parseAnalysis(
        safeResponse({ dominantColours: [{ hex: "red; background:url(x)", name: "אדום" }] }),
        limits,
      ),
    ).toBeNull();
  });
});
