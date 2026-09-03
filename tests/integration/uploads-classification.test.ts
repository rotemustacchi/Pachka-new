/**
 * Suggestions in, the artist's choice out, and who chose what on record.
 *
 * upload-pipeline, "AI tag suggestion with artist override": suggestions are
 * pre-filled and editable, "the artist's final choice SHALL always take
 * precedence, and the system SHALL record whether each stored value was
 * AI-suggested or artist-set".
 *
 * The provenance record is not bookkeeping. SECURITY.md S2-20 item 5 wants it
 * as the audit trail for a steering attempt: an artwork whose every field
 * arrived AI-suggested and unedited, with a taxonomy claim sitting exactly on
 * the cap, looks different from one an artist filled in.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  listingLimits,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import {
  classificationProvenance,
  classificationState,
  dominantColoursFor,
  eventsFor,
  processUpload,
  recordClassification,
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

const SUGGESTED = {
  medium: "painting_illustration",
  styles: ["minimalist"],
  moods: ["calm"],
  targetSpaces: ["living_room"],
  dominantColours: [{ hex: "#8899aa", name: "כחול אפור" }],
  description: "ציור אקריליק בגוונים כחולים, שכבות דקות וקו אופק ברור.",
} as const;

const suggestingAnalyst: VisionAnalyst = {
  async analyse() {
    return { safety: { verdict: "safe", confidence: 0.01, categories: [] }, ...SUGGESTED };
  },
};

const unreachableAnalyst: VisionAnalyst = {
  async analyse() {
    throw AppError.externalFailure("connect ETIMEDOUT vision.example");
  },
};

const constantEmbedder: Embedder = {
  async embed() {
    return { vector: Array.from({ length: 1024 }, () => 0.04), model: "test-embed" };
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

function uploadsDeps(db: Database, vision: VisionAnalyst): UploadsDeps {
  return {
    db,
    store: memoryStore(),
    vision,
    embedder: constantEmbedder,
    artworks: artworksDeps(db),
    retry: { attempts: 3, backoffMs: [0, 0] },
  };
}

async function uploadWith(db: Database, vision: VisionAnalyst) {
  const artistId = await seedArtist(db);
  const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
  const result = await processUpload(uploadsDeps(db, vision), {
    artistId,
    artworkId: draft.id,
    bytes: await photograph(),
  });
  return { artistId, artworkId: draft.id, result };
}

// ---------------------------------------------------------------------------

describe("suggestions pre-fill the form", () => {
  const database = useTestDatabase();

  it("returns the model's medium, styles, moods and colours, pre-selected", async () => {
    const { artworkId, result } = await uploadWith(database.db, suggestingAnalyst);

    expect(result.suggestions).toEqual({
      medium: "painting_illustration",
      styles: ["minimalist"],
      moods: ["calm"],
      targetSpaces: ["living_room"],
      dominantColours: [{ hex: "#8899aa", name: "כחול אפור" }],
      description: SUGGESTED.description,
    });

    // And they survive a page reload, without a second call to the model.
    expect(await suggestionsFor(database.db, artworkId)).toEqual(result.suggestions);
  });

  it("reports no provenance until the artist has actually submitted the form", async () => {
    // Absent is not the same as "everything is AI-suggested": the artist has
    // not looked at it yet, and a default would say they had.
    const { artworkId } = await uploadWith(database.db, suggestingAnalyst);

    expect(await classificationProvenance(database.db, artworkId)).toBeNull();
  });

  it("hands a route the suggestions and the provenance together", async () => {
    const { artworkId } = await uploadWith(database.db, suggestingAnalyst);

    const state = await classificationState(database.db, artworkId);

    expect(state.suggestions.medium).toBe("painting_illustration");
    expect(state.provenance).toBeNull();
  });
});

describe("the artist's choice wins", () => {
  const database = useTestDatabase();

  it("records an untouched field as AI-suggested", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);

    const recorded = await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED },
    });

    expect(recorded.provenance).toEqual({
      medium: "ai_suggested",
      styles: "ai_suggested",
      moods: "ai_suggested",
      targetSpaces: "ai_suggested",
      dominantColours: "ai_suggested",
      description: "ai_suggested",
    });
  });

  it("stores the artist's style and records it as artist-set", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);

    const recorded = await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED, styles: ["abstract"] },
    });

    expect(recorded.chosen.styles).toEqual(["abstract"]);
    expect(recorded.provenance.styles).toBe("artist_set");
    // Only the field they changed. Marking everything artist-set would destroy
    // the signal S2-20 item 5 wants out of this record.
    expect(recorded.provenance.medium).toBe("ai_suggested");
    expect(recorded.provenance.moods).toBe("ai_suggested");

    expect(await classificationProvenance(database.db, artworkId)).toEqual(recorded.provenance);
  });

  it("treats clearing a suggestion as a decision, not as agreement", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);

    const recorded = await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED, medium: null, moods: [] },
    });

    expect(recorded.provenance.medium).toBe("artist_set");
    expect(recorded.provenance.moods).toBe("artist_set");
  });

  it("is indifferent to the order the artist happened to tick the boxes in", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);
    await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED, styles: ["minimalist", "abstract"] },
    });

    const reordered = await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED, styles: ["abstract", "minimalist"] },
    });

    // Against the SUGGESTION, which was one style, so this is still artist-set.
    expect(reordered.provenance.styles).toBe("artist_set");
    expect(reordered.chosen.styles).toEqual(["abstract", "minimalist"]);
  });

  it("keeps the palette, which has no column on the artworks table", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);

    await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED, dominantColours: [{ hex: "#112233", name: "כחול כהה" }] },
    });

    expect(await dominantColoursFor(database.db, artworkId)).toEqual([
      { hex: "#112233", name: "כחול כהה" },
    ]);
  });

  it("refuses a taxonomy value outside the closed set, naming it", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);

    await expect(
      recordClassification(database.db, {
        artworkId,
        artistId,
        submitted: { ...SUGGESTED, styles: ["minimalist", "coastal_minimal"] },
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.taxonomy_value_outside_set" });

    // And nothing was recorded: a provenance row for a value that was never
    // stored is worse than no row.
    expect(await classificationProvenance(database.db, artworkId)).toBeNull();
  });

  it("holds the artist to the same caps the model is held to", async () => {
    // An artist claiming every style ranks into every result set just as
    // effectively as a steered model does (SECURITY.md S2-20 item 2).
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);
    const limits = await listingLimits(database.db);

    await expect(
      recordClassification(database.db, {
        artworkId,
        artistId,
        submitted: {
          ...SUGGESTED,
          styles: ["minimalist", "abstract", "boho_coastal", "modern_industrial", "pop_art"],
        },
      }),
    ).rejects.toMatchObject({ code: "uploads.taxonomy_cap_exceeded" });

    expect(limits.maxStyles).toBeLessThan(5);
  });

  it("refuses a submission with a field nobody asked for", async () => {
    const { artistId, artworkId } = await uploadWith(database.db, suggestingAnalyst);

    await expect(
      recordClassification(database.db, {
        artworkId,
        artistId,
        submitted: { ...SUGGESTED, aiSuggested: false },
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.invalid_classification" });
  });
});

describe("when analysis produced nothing", () => {
  const database = useTestDatabase();

  it("presents an empty form and lets the artist fill it in themselves", async () => {
    // upload-pipeline, "Analysis fails": an empty classification form for
    // manual completion, and the upload is not blocked.
    const { artistId, artworkId, result } = await uploadWith(database.db, unreachableAnalyst);

    expect(result.image.isPrimary).toBe(true);
    expect(await suggestionsFor(database.db, artworkId)).toEqual({
      medium: null,
      styles: [],
      moods: [],
      targetSpaces: [],
      dominantColours: [],
      description: "",
    });

    const recorded = await recordClassification(database.db, {
      artworkId,
      artistId,
      submitted: { ...SUGGESTED },
    });

    // Every field is artist-set, because nothing was suggested.
    expect(new Set(Object.values(recorded.provenance))).toEqual(new Set(["artist_set"]));
    const events = await eventsFor(database.db, artworkId);
    expect(events.map((event) => event.event)).toContain("classification_recorded");
  });
});
