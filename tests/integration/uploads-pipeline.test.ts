/**
 * The pipeline's order of operations, and the bytes it produces.
 *
 * Two things are proven here that would be expensive to get wrong:
 *
 * COST. `upload-pipeline`'s technical gate and the change proposal's hard
 * constraint -- AI spend scales with the number of artworks, never with traffic
 * -- only hold if a rejected image never reaches the vision model. The tests
 * below prove that WITHOUT asserting that a fake was not called, which
 * ARCHITECTURE.md forbids: the injected analyst returns an UNSAFE verdict, so
 * an image that reached it would be refused with `uploads.screening_blocked`
 * and would leave a `screening_blocked` row. Getting `uploads.quality_blur` and
 * an event log holding nothing but `quality_rejected` is therefore an
 * observable outcome that is only possible if no call was made. The last test
 * in that block is the positive control: the same analyst, a good image, and
 * the block does happen -- so the earlier assertions cannot be passing because
 * the analyst was never wired in.
 *
 * METADATA. SECURITY.md S1-9: a phone photograph carries GPS to within metres
 * of the artist's home, plus `Artist` and `Copyright` fields that routinely
 * hold a full legal name. The derivative is checked by parsing its actual bytes
 * back, not by trusting that `.withMetadata()` was avoided.
 *
 * Nothing is mocked but the three external boundaries `ports.ts` declares.
 * The database is real, the migrations are real, `sharp` is real, and the code
 * under test is the code that runs in production.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  imagesFor,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import {
  eventsFor,
  processUpload,
  uploadThresholds,
  DISPLAY_BUCKET,
  MAX_UPLOAD_BYTES,
  OBJECT_KEY_PATTERN,
  ORIGINALS_BUCKET,
  type Bucket,
  type Embedder,
  type ObjectStore,
  type StoredObject,
  type UploadsDeps,
  type VisionAnalyst,
} from "@/modules/uploads";
import { setConfig } from "@/shared/config";
import type { AppError } from "@/shared/errors";
import type { Database } from "@/shared/db";
import { useTestDatabase } from "../harness";

// ---------------------------------------------------------------------------
// Fixtures. Pure functions, not shared state: TESTING.md forbids a fixture that
// seeds data for several tests, and every one of these is called fresh.
// ---------------------------------------------------------------------------

/**
 * Deterministic pseudo-random pixels.
 *
 * Noise rather than a photograph because it is reproducible byte for byte, is
 * genuinely high-frequency (so it passes a focus measure honestly rather than
 * because the threshold was tuned to let it through), and compresses to a file
 * comfortably over the 100 KB minimum without shipping a binary into the repo.
 */
function noisyImage(width: number, height: number, seed: number): Sharp {
  const data = Buffer.alloc(width * height * 3);
  let state = seed >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i] = (state >>> 24) & 0xff;
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

/** A photograph that passes every technical check. */
function sharpPhotograph(seed = 3): Promise<Buffer> {
  return noisyImage(1400, 1400, seed).jpeg({ quality: 92 }).toBuffer();
}

/**
 * Out of focus, and large enough that the SIZE check cannot be what rejects it.
 *
 * `compressionLevel: 0` keeps the blurred image well over the minimum file
 * size, so the blur check is unambiguously the one that fires. A blurred image
 * saved normally compresses to almost nothing and would be rejected for being
 * too small, which would make the test pass while proving the wrong thing.
 */
function blurryPhotograph(): Promise<Buffer> {
  return noisyImage(1400, 1400, 7).blur(24).png({ compressionLevel: 0 }).toBuffer();
}

/** Under the 1200px minimum on both edges. */
function undersizedPhotograph(): Promise<Buffer> {
  return noisyImage(800, 800, 11).jpeg({ quality: 92 }).toBuffer();
}

/**
 * A photograph carrying what a phone writes: GPS, and a name in `Artist`.
 *
 * The GPS block is `IFD3` because that is what libvips (and therefore `sharp`)
 * calls the GPS IFD. The marker string is embedded in an ASCII EXIF field so
 * that its absence from the derivative can be checked against the raw bytes and
 * not only against a metadata parser -- a parser that silently failed would
 * report "no EXIF" for a file full of it.
 */
const GPS_MARKER = "0501112222";

function photographWithGps(): Promise<Buffer> {
  return noisyImage(1400, 1400, 13)
    .withExif({
      IFD0: {
        Artist: `Yael Cohen ${GPS_MARKER}`,
        Copyright: "Yael Cohen",
        ImageDescription: `studio-${GPS_MARKER}`,
      },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "32/1 4/1 3/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "34/1 46/1 2/1",
      },
    })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Stored landscape, displayed portrait. The orientation-6 case S1-9 names. */
function rotatedPhotograph(): Promise<Buffer> {
  return noisyImage(1600, 1200, 17).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer();
}

/** The GPS IFD pointer tag, 0x8825, little-endian, in an EXIF block. */
function containsGpsPointer(exif: Buffer): boolean {
  for (let i = 0; i + 1 < exif.length; i += 1) {
    if (exif[i] === 0x25 && exif[i + 1] === 0x88) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The three external boundaries, faked. ARCHITECTURE.md permits these and only
// these.
// ---------------------------------------------------------------------------

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

/**
 * An analyst that would REFUSE every image it is shown.
 *
 * Injected into the cost tests on purpose. If the pipeline ever consults it for
 * an image the local gate should have rejected, the artist gets a
 * content-screening refusal instead of a quality one and a `screening_blocked`
 * row appears -- both observable, neither reachable without the call.
 */
const refusingAnalyst: VisionAnalyst = {
  async analyse() {
    return {
      safety: { verdict: "unsafe", confidence: 1, categories: ["violence"] },
      medium: "painting_illustration",
      styles: [],
      moods: [],
      targetSpaces: [],
      dominantColours: [],
      description: "",
    };
  },
};

const approvingAnalyst: VisionAnalyst = {
  async analyse() {
    return {
      safety: { verdict: "safe", confidence: 0.02, categories: [] },
      medium: "painting_illustration",
      styles: ["minimalist"],
      moods: ["calm"],
      targetSpaces: ["living_room"],
      dominantColours: [{ hex: "#8899aa", name: "כחול אפור" }],
      description: "ציור אקריליק בגוונים כחולים עם שכבות דקות וקו אופק ברור.",
    };
  },
};

const constantEmbedder: Embedder = {
  async embed() {
    return { vector: Array.from({ length: 1024 }, () => 0.01), model: "test-embed" };
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

function uploadsDeps(
  db: Database,
  store: ObjectStore,
  vision: VisionAnalyst,
): UploadsDeps {
  return {
    db,
    store,
    vision,
    embedder: constantEmbedder,
    artworks: artworksDeps(db),
    // Zero backoff: ARCHITECTURE.md forbids a sleeping test, and the retry
    // COUNT is what the behaviour depends on, not the wall-clock delay.
    retry: { attempts: 3, backoffMs: [0, 0] },
  };
}

// ---------------------------------------------------------------------------

describe("the local technical gate runs before any paid call", () => {
  const database = useTestDatabase();

  it("rejects an image below the minimum resolution, naming the minimum", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), refusingAnalyst);

    await expect(
      processUpload(deps, {
        artistId,
        artworkId: draft.id,
        bytes: await undersizedPhotograph(),
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.quality_resolution" });

    // The analyst injected above refuses everything. A `quality_resolution`
    // refusal, and an event log with no screening row in it, is only reachable
    // if the vision model was never consulted.
    const events = await eventsFor(database.db, draft.id);
    expect(events.map((event) => event.event)).toEqual(["quality_rejected"]);
  });

  it("states the minimum resolution and the actual one, so the artist can act on it", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), refusingAnalyst);
    const thresholds = await uploadThresholds(database.db);

    let error: AppError | null = null;
    try {
      await processUpload(deps, {
        artistId,
        artworkId: draft.id,
        bytes: await undersizedPhotograph(),
      });
    } catch (caught) {
      error = caught as AppError;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toContain(String(thresholds.minShorterEdgePx));
    expect(error?.details).toMatchObject({ failure: "resolution", widthPx: 800, heightPx: 800 });
  });

  it("rejects a blurry image and advises retaking the photograph", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), refusingAnalyst);

    await expect(
      processUpload(deps, { artistId, artworkId: draft.id, bytes: await blurryPhotograph() }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.quality_blur" });

    const events = await eventsFor(database.db, draft.id);
    expect(events.map((event) => event.event)).toEqual(["quality_rejected"]);
    expect(events[0]?.detail).toMatchObject({ failure: "blur" });
  });

  it("leaves no object in any bucket when the local gate refuses", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const store = memoryStore();

    await expect(
      processUpload(uploadsDeps(database.db, store, refusingAnalyst), {
        artistId,
        artworkId: draft.id,
        bytes: await blurryPhotograph(),
      }),
    ).rejects.toMatchObject({ kind: "validation" });

    expect([...store.contents.keys()]).toEqual([]);
    expect(await imagesFor(database.db, draft.id)).toEqual([]);
  });

  it("POSITIVE CONTROL: the same analyst does refuse a good image", async () => {
    // Without this, every assertion above could be passing because the analyst
    // was never wired in rather than because it was never reached.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), refusingAnalyst);

    await expect(
      processUpload(deps, { artistId, artworkId: draft.id, bytes: await sharpPhotograph() }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.screening_blocked" });

    const events = await eventsFor(database.db, draft.id);
    expect(events.map((event) => event.event)).toContain("screening_blocked");
  });

  it("accepts an image passing every technical check and proceeds to screening", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), approvingAnalyst);

    const result = await processUpload(deps, {
      artistId,
      artworkId: draft.id,
      bytes: await sharpPhotograph(),
    });

    expect(result.screened).toBe(true);
    expect(result.image.isPrimary).toBe(true);
    const events = await eventsFor(database.db, draft.id);
    expect(events.map((event) => event.event)).toContain("screening_passed");
  });

  it("is driven by app_config, so the bar moves without a deployment", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), approvingAnalyst);
    const bytes = await sharpPhotograph();

    // The same bytes that just passed are refused once the bar is raised above
    // their shorter edge. upload-pipeline: "Thresholds SHALL be configuration
    // values changeable without a code deployment."
    await setConfig(database.db, "upload.min_shorter_edge_px", 2000);

    await expect(
      processUpload(deps, { artistId, artworkId: draft.id, bytes }),
    ).rejects.toMatchObject({ code: "uploads.quality_resolution" });

    await setConfig(database.db, "upload.min_shorter_edge_px", 1200);
    const accepted = await processUpload(deps, { artistId, artworkId: draft.id, bytes });
    expect(accepted.screened).toBe(true);
  });

  it("refuses a file that is not an image at all", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), refusingAnalyst);

    await expect(
      processUpload(deps, {
        artistId,
        artworkId: draft.id,
        bytes: new Uint8Array(Buffer.from("not an image, just some bytes")),
      }),
    ).rejects.toMatchObject({ code: "uploads.quality_unreadable" });
  });

  it("refuses a file above the hard size ceiling before decoding it", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const deps = uploadsDeps(database.db, memoryStore(), refusingAnalyst);

    await expect(
      processUpload(deps, {
        artistId,
        artworkId: draft.id,
        bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.file_too_large" });
  });
});

describe("every served derivative", () => {
  const database = useTestDatabase();

  async function uploadWith(db: Database, bytes: Buffer) {
    const artistId = await seedArtist(db);
    const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
    const store = memoryStore();
    const result = await processUpload(uploadsDeps(db, store, approvingAnalyst), {
      artistId,
      artworkId: draft.id,
      bytes,
    });
    return { artistId, artworkId: draft.id, store, result };
  }

  it("carries no EXIF or XMP, and no GPS, when the original carried all three", async () => {
    const source = await photographWithGps();

    // The source really does carry what we are about to prove is gone --
    // otherwise the assertions below are vacuous.
    const sourceMetadata = await sharp(source).metadata();
    expect(sourceMetadata.exif).toBeDefined();
    expect(containsGpsPointer(sourceMetadata.exif as Buffer)).toBe(true);
    expect(Buffer.from(source).includes(GPS_MARKER)).toBe(true);

    const { store, result } = await uploadWith(database.db, source);

    for (const path of [result.image.displayPath, result.image.thumbnailPath]) {
      const stored = await store.get(DISPLAY_BUCKET, path as string);
      expect(stored, `no object stored at ${path}`).not.toBeNull();

      const bytes = Buffer.from((stored as StoredObject).bytes);
      const metadata = await sharp(bytes).metadata();

      expect(metadata.exif, `${path} carries EXIF`).toBeUndefined();
      expect(metadata.xmp, `${path} carries XMP`).toBeUndefined();
      // Belt and braces: a metadata parser that quietly failed would report
      // "no EXIF" for a file full of it, so check the bytes themselves.
      expect(bytes.includes(GPS_MARKER), `${path} still contains the marker`).toBe(false);
      expect(bytes.includes("Yael Cohen"), `${path} still names the artist`).toBe(false);
    }
  });

  it("bakes EXIF orientation into the pixels rather than re-attaching the tag", async () => {
    // SECURITY.md S1-9: `.rotate()` is the correct fix for a rotated image and
    // `.withMetadata()` is the trap. A derivative that is rotated correctly AND
    // carries no orientation tag can only have come from the first.
    const source = await rotatedPhotograph();
    expect((await sharp(source).metadata()).orientation).toBe(6);

    const { store, result } = await uploadWith(database.db, source);
    const stored = await store.get(DISPLAY_BUCKET, result.image.displayPath as string);
    const metadata = await sharp(Buffer.from((stored as StoredObject).bytes)).metadata();

    expect(metadata.orientation).toBeUndefined();
    // Stored 1600x1200, displayed 1200x1600: the derivative is portrait.
    expect(metadata.height).toBeGreaterThan(metadata.width as number);
  });

  it("is no larger than the configured maximum display dimension", async () => {
    const thresholds = await uploadThresholds(database.db);
    const { store, result } = await uploadWith(database.db, await sharpPhotograph());

    const display = await store.get(DISPLAY_BUCKET, result.image.displayPath as string);
    const metadata = await sharp(Buffer.from((display as StoredObject).bytes)).metadata();

    expect(Math.max(metadata.width as number, metadata.height as number)).toBeLessThanOrEqual(
      thresholds.maxDisplayDimensionPx,
    );
  });

  it("carries no watermark: its pixels are the source's pixels, resized", async () => {
    // upload-pipeline: "Displayed images SHALL NOT carry a watermark." A
    // composited overlay would change the mean of at least one channel in the
    // region it covers, so comparing per-channel means against an independent
    // resize of the same source is a check on the pixels rather than on the
    // absence of a line of code.
    const source = await sharpPhotograph(23);
    const thresholds = await uploadThresholds(database.db);
    const { store, result } = await uploadWith(database.db, source);

    const display = await store.get(DISPLAY_BUCKET, result.image.displayPath as string);
    const produced = await sharp(Buffer.from((display as StoredObject).bytes)).stats();
    const expected = await sharp(source)
      .rotate()
      .resize({
        width: thresholds.maxDisplayDimensionPx,
        height: thresholds.maxDisplayDimensionPx,
        fit: "inside",
        withoutEnlargement: true,
      })
      .stats();

    for (const [index, channel] of produced.channels.entries()) {
      // Tolerance is for WebP quantisation, which moves a channel mean by a
      // fraction of a level. A watermark moves it far further.
      expect(channel.mean).toBeCloseTo(expected.channels[index]?.mean as number, 0);
    }
  });

  it("retains the original, unserved, in the private bucket", async () => {
    const source = await photographWithGps();
    const { store, result } = await uploadWith(database.db, source);

    const original = await store.get(ORIGINALS_BUCKET, result.image.originalPath);
    expect(original).not.toBeNull();
    expect(Buffer.from((original as StoredObject).bytes).equals(Buffer.from(source))).toBe(true);

    // And it is NOT in the bucket the public read policy covers.
    expect(await store.get(DISPLAY_BUCKET, result.image.originalPath)).toBeNull();
  });

  it("addresses the original by a key that the display key does not reveal", async () => {
    // SECURITY.md S1-9 item 3: the original's key carries an independent random
    // component, so knowing the public key does not address the private object.
    const { result } = await uploadWith(database.db, await sharpPhotograph());

    const originalId = result.image.originalPath.split("/")[1]?.split(".")[0];
    const displayId = (result.image.displayPath as string).split("/")[1]?.split(".")[0];
    expect(originalId).not.toBe(displayId);
  });

  it("uses a server-generated key under the artwork's own prefix, never a filename", async () => {
    const { artworkId, result } = await uploadWith(database.db, await sharpPhotograph());

    for (const path of [
      result.image.originalPath,
      result.image.displayPath as string,
      result.image.thumbnailPath as string,
    ]) {
      expect(path).toMatch(OBJECT_KEY_PATTERN);
      expect(path.startsWith(`${artworkId}/`)).toBe(true);
    }
  });
});
