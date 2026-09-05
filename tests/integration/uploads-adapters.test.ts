/**
 * The three production adapters, driven through the real pipeline.
 *
 * `ports.ts` names the module's complete list of external boundaries -- the
 * object store, the vision model, the embedding model -- and until now all
 * three were exercised only through hand-written fakes. The adapters that talk
 * to Supabase Storage, to Anthropic and to Voyage were the one part of this
 * module with nothing behind them. This file is what stands behind them.
 *
 * HOW A NETWORK ADAPTER IS TESTED WITHOUT A NETWORK
 * -------------------------------------------------
 * ARCHITECTURE.md's test policy forbids live network in tests, and permits a
 * deterministic fake for an external boundary. So the boundary faked here is
 * one step lower than usual: not `VisionAnalyst`, but the HTTP transport the
 * real `VisionAnalyst` is built on. Everything above it -- the request the
 * adapter composes, the downscale that bounds the bill, the classification of a
 * 429 versus a 500, the refusal when there is no API key, and the whole
 * pipeline that consumes the result -- is the code that runs in production.
 *
 * NOTHING HERE ASSERTS THAT A FUNCTION WAS CALLED. Requests are appended to a
 * plain array and the assertions are about their CONTENT: which model was
 * named, how large the image was, which bucket the bytes landed in. That is the
 * same technique `uploads-pipeline.test.ts` uses with its recording store, and
 * it is a different thing from a mock expectation -- the array is data the
 * adapter produced, and the assertions would fail for a request with the wrong
 * body just as loudly as for no request at all.
 *
 * THE FOUR SENTENCES THIS FILE EXISTS TO DEFEND
 * ---------------------------------------------
 *   1. SECURITY.md S2-20 item 3 -- a parse deviation from the vision model is a
 *      SCREENING FAILURE, which per S0-7 blocks publication. A malformed
 *      response must never be read as "safe".
 *   2. upload-pipeline -- an image the screening flags is refused outright, with
 *      nothing stored.
 *   3. A DEPLOYMENT WITH NO API KEY MUST REFUSE, NOT PUBLISH. This is the one
 *      that would be easiest to get backwards and worst to get wrong: a
 *      "screening disabled when unconfigured" branch is a hole, not a
 *      convenience.
 *   4. SECURITY.md S1-9 item 2 -- the original lives in a private bucket and is
 *      never served.
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
  createAnthropicVisionAnalyst,
  createSupabaseObjectStore,
  createVoyageEmbedder,
  embeddingFor,
  embeddingVectorFor,
  eventsFor,
  isRetryable,
  primaryImageIsScreened,
  processUpload,
  publishArtwork,
  DISPLAY_BUCKET,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  ORIGINALS_BUCKET,
  VISION_IMAGE_LONG_EDGE_PX,
  VISION_MODEL,
  type Bucket,
  type Embedder,
  type HttpTransport,
  type ObjectStore,
  type StorageBucketApi,
  type StorageClient,
  type StoredObject,
  type UploadsDeps,
  type VisionAnalyst,
} from "@/modules/uploads";
import type { Database } from "@/shared/db";
import { useTestDatabase } from "../harness";

// ---------------------------------------------------------------------------
// Fixtures
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

function photograph(width = 1400, height = 1400, seed = 5): Promise<Buffer> {
  return noisyImage(width, height, seed).jpeg({ quality: 92 }).toBuffer();
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

/** A recorded outbound request. The assertions are about these, not about calls. */
interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

interface RecordingTransport {
  readonly transport: HttpTransport;
  readonly requests: Recorded[];
}

/** Replies with each response in turn, repeating the last one forever. */
function transportReturning(
  ...responses: readonly (Response | Error | (() => Response))[]
): RecordingTransport {
  const requests: Recorded[] = [];
  let index = 0;

  return {
    requests,
    transport: async (url, init) => {
      requests.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : (next as Response);
    },
  };
}

function jsonResponse(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status });
}

/** The Messages API shape: the answer arrives as the arguments of a forced tool call. */
function visionReply(input: unknown, name = "record_artwork_analysis"): () => Response {
  return jsonResponse({
    id: "msg_test",
    model: VISION_MODEL,
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_test", name, input }],
  });
}

function safeAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function voyageReply(dimensions = EMBEDDING_DIMENSIONS, model = EMBEDDING_MODEL): () => Response {
  return jsonResponse({
    object: "list",
    model,
    data: [
      {
        object: "embedding",
        index: 0,
        embedding: Array.from({ length: dimensions }, (_, i) => (i % 100) / 1000),
      },
    ],
    usage: { total_tokens: 42 },
  });
}

/** Rejects the way `AbortSignal.timeout` does. */
function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

async function seedArtist(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [
    id,
  ]);
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

const constantEmbedder: Embedder = {
  async embed() {
    return {
      vector: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01),
      model: "test-embed",
    };
  },
};

function uploadsDeps(
  db: Database,
  store: ObjectStore,
  vision: VisionAnalyst,
  embedder: Embedder = constantEmbedder,
): UploadsDeps {
  return {
    db,
    store,
    vision,
    embedder,
    artworks: artworksDeps(db),
    // Zero backoff: ARCHITECTURE.md forbids a sleeping test.
    retry: { attempts: 3, backoffMs: [0, 0] },
  };
}

/** The real adapter, wired to a transport that never touches a network. */
function visionAnalyst(transport: HttpTransport, apiKey = "sk-ant-test"): VisionAnalyst {
  return createAnthropicVisionAnalyst({ apiKey, transport, timeoutMs: 1_000 });
}

// ---------------------------------------------------------------------------
// The request the vision adapter composes
// ---------------------------------------------------------------------------

describe("the vision adapter's request", () => {
  it("names the pinned model and forces the single structured tool call", async () => {
    const recording = transportReturning(visionReply(safeAnalysis()));
    const analyst = visionAnalyst(recording.transport);

    await analyst.analyse({ bytes: await photograph(), contentType: "image/jpeg" });

    const request = recording.requests[0];
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(request?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request?.body["model"]).toBe(VISION_MODEL);
    // Forced, so a chatty reply cannot cost the artist their publishability.
    expect(request?.body["tool_choice"]).toEqual({
      type: "tool",
      name: "record_artwork_analysis",
    });
  });

  it("sends ONE image per upload, and never more than one", async () => {
    // The cost model in one assertion. design.md: "One Claude Haiku 4.5 vision
    // call per accepted image". A second image block in the same request, or a
    // second request, is the same defect in two shapes.
    const recording = transportReturning(visionReply(safeAnalysis()));
    const analyst = visionAnalyst(recording.transport);

    await analyst.analyse({ bytes: await photograph(), contentType: "image/jpeg" });

    expect(recording.requests).toHaveLength(1);
    const messages = recording.requests[0]?.body["messages"] as { content: { type: string }[] }[];
    expect(messages).toHaveLength(1);
    const images = messages[0]?.content.filter((block) => block.type === "image") ?? [];
    expect(images).toHaveLength(1);
  });

  it("downscales the original, so the bill does not depend on the artist's camera", async () => {
    // Anthropic bills roughly `width * height / 750` input tokens. The pipeline
    // hands this adapter the ORIGINAL -- screening has to happen before storage
    // -- so without this downscale a 24-megapixel HEIC would cost ~30x what the
    // answer needs. This asserts the cap holds on the bytes actually sent.
    const recording = transportReturning(visionReply(safeAnalysis()));
    const analyst = visionAnalyst(recording.transport);

    await analyst.analyse({
      bytes: await photograph(2400, 1800),
      contentType: "image/jpeg",
    });

    const messages = recording.requests[0]?.body["messages"] as {
      content: { type: string; source?: { media_type: string; data: string } }[];
    }[];
    const image = messages[0]?.content.find((block) => block.type === "image");
    expect(image?.source?.media_type).toBe("image/jpeg");

    const sent = await sharp(Buffer.from(image?.source?.data ?? "", "base64")).metadata();
    expect(Math.max(sent.width ?? 0, sent.height ?? 0)).toBeLessThanOrEqual(
      VISION_IMAGE_LONG_EDGE_PX,
    );
    // And it is genuinely the same picture, not a blank placeholder.
    expect(sent.width).toBe(VISION_IMAGE_LONG_EDGE_PX);
    expect(sent.height).toBe(Math.round((VISION_IMAGE_LONG_EDGE_PX * 1800) / 2400));
  });

  it("re-encodes HEIC to a format the vendor accepts", async () => {
    // `ACCEPTED_FORMATS` includes heif and avif; the Messages API accepts
    // neither. Without the re-encode every iPhone upload would fail screening
    // and land in the admin queue.
    const recording = transportReturning(visionReply(safeAnalysis()));
    const analyst = visionAnalyst(recording.transport);
    const heic = await noisyImage(1200, 1200, 9).heif({ compression: "av1" }).toBuffer();

    await analyst.analyse({ bytes: heic, contentType: "image/heic" });

    const messages = recording.requests[0]?.body["messages"] as {
      content: { type: string; source?: { media_type: string; data: string } }[];
    }[];
    const image = messages[0]?.content.find((block) => block.type === "image");
    expect(image?.source?.media_type).toBe("image/jpeg");
    expect((await sharp(Buffer.from(image?.source?.data ?? "", "base64")).metadata()).format).toBe(
      "jpeg",
    );
  });
});

// ---------------------------------------------------------------------------
// What the vision adapter does with the answer
// ---------------------------------------------------------------------------

describe("the vision adapter's reading of the response", () => {
  it("returns the tool arguments verbatim, unparsed and untrusted", async () => {
    // `ports.ts` types `analyse` as returning `unknown` deliberately: the image
    // is attacker-controlled, so the reply is attacker-influenced data and
    // `analysis.ts` is the only place allowed to decide what it means. This
    // asserts the adapter adds no interpretation of its own -- including to a
    // payload carrying a key the schema will later reject.
    const raw = { ...safeAnalysis(), unexpectedKey: "steering attempt" };
    const analyst = visionAnalyst(transportReturning(visionReply(raw)).transport);

    expect(await analyst.analyse({ bytes: await photograph(), contentType: "image/jpeg" })).toEqual(
      raw,
    );
  });

  it("refuses a response with no tool call rather than inventing one", async () => {
    const analyst = visionAnalyst(
      transportReturning(
        jsonResponse({
          id: "msg_test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "I'd rather describe it in prose." }],
        }),
      ).transport,
    );

    await expect(
      analyst.analyse({ bytes: await photograph(), contentType: "image/jpeg" }),
    ).rejects.toMatchObject({ kind: "external_failure", code: "uploads.vision_no_tool_call" });
  });

  it("refuses a body that is not JSON", async () => {
    const analyst = visionAnalyst(
      transportReturning(() => new Response("<html>502 Bad Gateway</html>", { status: 200 }))
        .transport,
    );

    await expect(
      analyst.analyse({ bytes: await photograph(), contentType: "image/jpeg" }),
    ).rejects.toMatchObject({ kind: "external_failure" });
  });

  it("classifies a 429 as retryable and a 500 as not", async () => {
    // SECURITY.md S0-7 item 2: "A 429 or a timeout is *retryable*, not
    // *unavailable*", because an attacker who can burn the rate limit would
    // otherwise choose when screening is skipped. `screening.ts` retries
    // exactly the `rate_limited` kind, so this classification IS that control.
    const bytes = await photograph();

    const limited = await visionAnalyst(
      transportReturning(jsonResponse({ error: "rate_limit" }, 429)).transport,
    )
      .analyse({ bytes, contentType: "image/jpeg" })
      .catch((error: unknown) => error);
    expect(isRetryable(limited)).toBe(true);

    const overloaded = await visionAnalyst(
      transportReturning(jsonResponse({ error: "overloaded" }, 529)).transport,
    )
      .analyse({ bytes, contentType: "image/jpeg" })
      .catch((error: unknown) => error);
    expect(isRetryable(overloaded)).toBe(true);

    const broken = await visionAnalyst(
      transportReturning(jsonResponse({ error: "internal" }, 500)).transport,
    )
      .analyse({ bytes, contentType: "image/jpeg" })
      .catch((error: unknown) => error);
    expect(isRetryable(broken)).toBe(false);
    expect(broken).toMatchObject({ kind: "external_failure" });
  });

  it("classifies a timeout as retryable", async () => {
    const analyst = visionAnalyst(transportReturning(timeoutError()).transport);

    const error = await analyst
      .analyse({ bytes: await photograph(), contentType: "image/jpeg" })
      .catch((thrown: unknown) => thrown);

    expect(isRetryable(error)).toBe(true);
    expect(error).toMatchObject({ code: "uploads.vision_timeout" });
  });
});

// ---------------------------------------------------------------------------
// The adapter inside the pipeline
// ---------------------------------------------------------------------------

describe("the real vision adapter, driving the real pipeline", () => {
  const database = useTestDatabase();

  async function draftFor(db: Database) {
    const artistId = await seedArtist(db);
    const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
    return { artistId, artworkId: draft.id };
  }

  it("routes a malformed response to screening_unavailable, and blocks publication", async () => {
    // SECURITY.md S2-20 item 3. The response below is well-formed JSON from a
    // well-formed tool call -- it just has a `verdict` outside the closed set,
    // which is what a steered model produces. The only safe reading of "not the
    // thing we asked for" is a screening failure.
    const { artistId, artworkId } = await draftFor(database.db);
    const store = memoryStore();
    const analyst = visionAnalyst(
      transportReturning(
        visionReply(safeAnalysis({ safety: { verdict: "definitely fine", confidence: 0.99 } })),
      ).transport,
    );
    const deps = uploadsDeps(database.db, store, analyst);

    const result = await processUpload(deps, {
      artistId,
      artworkId,
      bytes: await photograph(),
    });

    // The upload SUCCEEDS -- the artist does not lose their work...
    expect(result.screened).toBe(false);
    expect(result.flaggedForReview).toBe(true);
    // ...the suggestions are empty, because the same call carried them...
    expect(result.suggestions.medium).toBeNull();
    // ...and the artwork is unpublishable.
    expect(await primaryImageIsScreened(database.db, artworkId)).toBe(false);
    await expect(publishArtwork(deps, artistId, artworkId)).rejects.toMatchObject({
      kind: "conflict",
      code: "uploads.screening_incomplete",
    });

    const events = (await eventsFor(database.db, artworkId)).map((event) => event.event);
    expect(events).toContain("screening_unavailable");
    expect(events).not.toContain("screening_passed");
  });

  it("refuses an upload the model calls unsafe, leaving no object behind", async () => {
    const { artistId, artworkId } = await draftFor(database.db);
    const store = memoryStore();
    const analyst = visionAnalyst(
      transportReturning(
        visionReply(
          safeAnalysis({ safety: { verdict: "unsafe", confidence: 0.97, categories: ["adult"] } }),
        ),
      ).transport,
    );

    await expect(
      processUpload(uploadsDeps(database.db, store, analyst), {
        artistId,
        artworkId,
        bytes: await photograph(),
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "uploads.screening_blocked" });

    // SECURITY.md S0-7: "no `artwork_images` row exists, no object remains in
    // the artwork bucket".
    expect(await imagesFor(database.db, artworkId)).toHaveLength(0);
    expect(store.contents.size).toBe(0);
  });

  it("keeps the original in the private bucket and out of every public one", async () => {
    // SECURITY.md S1-9 item 2. The original is retained and never served, so
    // the assertion is about bytes rather than about a naming convention: no
    // object in the public bucket may BE the original, whatever it is called.
    const { artistId, artworkId } = await draftFor(database.db);
    const store = memoryStore();
    const original = await photograph(1600, 1200, 11);
    const analyst = visionAnalyst(transportReturning(visionReply(safeAnalysis())).transport);

    await processUpload(uploadsDeps(database.db, store, analyst), {
      artistId,
      artworkId,
      bytes: original,
    });

    const inOriginals = [...store.contents.entries()].filter(([key]) =>
      key.startsWith(`${ORIGINALS_BUCKET}/`),
    );
    const inDisplay = [...store.contents.entries()].filter(([key]) =>
      key.startsWith(`${DISPLAY_BUCKET}/`),
    );

    expect(inOriginals).toHaveLength(1);
    expect(Buffer.from(inOriginals[0]?.[1].bytes ?? new Uint8Array())).toEqual(original);

    // Display and thumbnail. Neither is the original, and both are re-encoded.
    expect(inDisplay).toHaveLength(2);
    for (const [, object] of inDisplay) {
      expect(object.contentType).toBe("image/webp");
      expect(Buffer.from(object.bytes).equals(original)).toBe(false);
    }
  });

  it("absorbs a 429 by retrying, rather than treating it as an outage", async () => {
    const { artistId, artworkId } = await draftFor(database.db);
    const analyst = visionAnalyst(
      transportReturning(
        jsonResponse({ error: "rate_limit" }, 429),
        jsonResponse({ error: "rate_limit" }, 429),
        visionReply(safeAnalysis()),
      ).transport,
    );

    const result = await processUpload(uploadsDeps(database.db, memoryStore(), analyst), {
      artistId,
      artworkId,
      bytes: await photograph(),
    });

    expect(result.screened).toBe(true);
    expect(await primaryImageIsScreened(database.db, artworkId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No API key
// ---------------------------------------------------------------------------

describe("a deployment with no ANTHROPIC_API_KEY", () => {
  const database = useTestDatabase();

  it("refuses to screen, and therefore refuses to publish", async () => {
    // The one that must not be backwards. There is no "screening disabled in
    // development" branch anywhere in the adapter: with no key every call
    // rejects, `screening.ts` reads that as unavailable, and publication is
    // blocked. An unconfigured deployment accepts uploads and publishes none of
    // them -- loud, safe, and recoverable by setting the key.
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(artworksDeps(database.db), artistId, DRAFT);
    const unconfigured = createAnthropicVisionAnalyst({
      apiKey: "",
      // A transport that would answer perfectly. It is never reached, and the
      // proof is that the upload is unscreened anyway.
      transport: transportReturning(visionReply(safeAnalysis())).transport,
    });
    const deps = uploadsDeps(database.db, memoryStore(), unconfigured);

    const result = await processUpload(deps, {
      artistId,
      artworkId: draft.id,
      bytes: await photograph(),
    });

    expect(result.screened).toBe(false);
    expect(result.flaggedForReview).toBe(true);
    await expect(publishArtwork(deps, artistId, draft.id)).rejects.toMatchObject({
      kind: "conflict",
      code: "uploads.screening_incomplete",
    });

    // The operator has to be able to find out WHY from the event log alone.
    const events = await eventsFor(database.db, draft.id);
    const unavailable = events.find((event) => event.event === "screening_unavailable");
    expect(String((unavailable?.detail as { reason?: unknown })?.reason)).toContain(
      "ANTHROPIC_API_KEY",
    );
  });

  it("reads the key from the environment, and an unset one is an absent one", async () => {
    // The test above passes `apiKey: ""` explicitly; this one proves the
    // environment path reaches the same branch, so the refusal is not an
    // artifact of how the test constructs the adapter.
    const previous = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const analyst = createAnthropicVisionAnalyst({
        transport: transportReturning(visionReply(safeAnalysis())).transport,
      });

      await expect(
        analyst.analyse({ bytes: await photograph(), contentType: "image/jpeg" }),
      ).rejects.toMatchObject({
        kind: "external_failure",
        code: "uploads.vision_not_configured",
      });
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// The embedding adapter
// ---------------------------------------------------------------------------

describe("the embedding adapter", () => {
  const database = useTestDatabase();

  function embedder(transport: HttpTransport, apiKey = "pa-test"): Embedder {
    return createVoyageEmbedder({ apiKey, transport, timeoutMs: 1_000 });
  }

  async function uploadAndPublish(db: Database, deps: UploadsDeps) {
    const artistId = await seedArtist(db);
    const draft = await createDraft(artworksDeps(db), artistId, DRAFT);
    await processUpload(deps, { artistId, artworkId: draft.id, bytes: await photograph() });
    return { artistId, artworkId: draft.id };
  }

  it("produces a vector of exactly the width the column stores", async () => {
    // `artwork_embeddings.embedding` is `vector(1024)` and
    // `EMBEDDING_DIMENSIONS` is asserted against `information_schema`
    // elsewhere. This closes the loop at the other end: the provider's answer
    // reaches the column intact, at that width.
    const recording = transportReturning(voyageReply());
    const analyst = visionAnalyst(transportReturning(visionReply(safeAnalysis())).transport);
    const deps = uploadsDeps(database.db, memoryStore(), analyst, embedder(recording.transport));
    const { artistId, artworkId } = await uploadAndPublish(database.db, deps);

    const published = await publishArtwork(deps, artistId, artworkId);
    expect(published.embedding.status).toBe("stored");

    const stored = await embeddingVectorFor(database.db, artworkId);
    expect(stored).toHaveLength(EMBEDDING_DIMENSIONS);
    expect((await embeddingFor(database.db, artworkId))?.model).toBe(EMBEDDING_MODEL);

    // Every vector in this system is a document vector, including the ones the
    // matchmaker later uses as queries -- it builds those by combining STORED
    // vectors, never by calling a provider. A query-typed vector here would sit
    // in a different sub-space and rank against nothing.
    expect(recording.requests[0]?.body["input_type"]).toBe("document");
    expect(recording.requests[0]?.body["model"]).toBe(EMBEDDING_MODEL);
  });

  it("refuses a vector of the wrong width instead of padding it", async () => {
    // A 512-dimension answer zero-padded to 1024 would look like a working
    // matchmaker and rank on noise forever. Refusing costs the artwork its
    // ranking until someone reads the event log, which is recoverable.
    const analyst = visionAnalyst(transportReturning(visionReply(safeAnalysis())).transport);
    const deps = uploadsDeps(
      database.db,
      memoryStore(),
      analyst,
      embedder(transportReturning(voyageReply(512)).transport),
    );
    const { artistId, artworkId } = await uploadAndPublish(database.db, deps);

    const published = await publishArtwork(deps, artistId, artworkId);

    // upload-pipeline: the artwork is published and browsable, and excluded
    // from matchmaker results until an embedding exists.
    expect(published.artwork.status).toBe("published");
    expect(published.embedding.status).toBe("failed");
    expect(await embeddingFor(database.db, artworkId)).toBeNull();

    const events = (await eventsFor(database.db, artworkId)).map((event) => event.event);
    expect(events).toContain("embedding_failed");
  });

  it("publishes without a VOYAGE_API_KEY, browsable and unrankable", async () => {
    // Unlike the vision key, a missing embedding key is not a safety problem:
    // an unranked artwork is a degraded experience. So this one must NOT block
    // publication -- and it must not silently store a zero vector either.
    const analyst = visionAnalyst(transportReturning(visionReply(safeAnalysis())).transport);
    const deps = uploadsDeps(
      database.db,
      memoryStore(),
      analyst,
      createVoyageEmbedder({
        apiKey: "",
        transport: transportReturning(voyageReply()).transport,
      }),
    );
    const { artistId, artworkId } = await uploadAndPublish(database.db, deps);

    const published = await publishArtwork(deps, artistId, artworkId);

    expect(published.artwork.status).toBe("published");
    expect(published.embedding.status).toBe("failed");
    expect(await embeddingVectorFor(database.db, artworkId)).toBeNull();

    const failure = (await eventsFor(database.db, artworkId)).find(
      (event) => event.event === "embedding_failed",
    );
    expect(String((failure?.detail as { reason?: unknown })?.reason)).toContain("VOYAGE_API_KEY");
  });

  it("refuses a response carrying no vector", async () => {
    const failing = createVoyageEmbedder({
      apiKey: "pa-test",
      transport: transportReturning(jsonResponse({ object: "list", data: [] })).transport,
    });

    await expect(failing.embed("ציור מינימליסטי")).rejects.toMatchObject({
      kind: "external_failure",
      code: "uploads.embedding_malformed_response",
    });
  });
});

// ---------------------------------------------------------------------------
// The Supabase Storage adapter
// ---------------------------------------------------------------------------

describe("the Supabase Storage adapter", () => {
  /** Supabase Storage, reduced to the three calls the adapter makes. */
  function fakeStorage(failures: Partial<Record<"upload" | "download" | "remove", string>> = {}) {
    const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

    const client: StorageClient = {
      storage: {
        from(bucket: string): StorageBucketApi {
          return {
            async upload(key, body, options) {
              if (failures.upload) return { error: { message: failures.upload } };
              objects.set(`${bucket}/${key}`, {
                bytes: body,
                contentType: options.contentType,
              });
              return { error: null };
            },
            async download(key) {
              if (failures.download) return { data: null, error: { message: failures.download } };
              const found = objects.get(`${bucket}/${key}`);
              if (!found) return { data: null, error: { message: "Object not found" } };
              return {
                data: {
                  type: found.contentType,
                  arrayBuffer: async () =>
                    found.bytes.buffer.slice(
                      found.bytes.byteOffset,
                      found.bytes.byteOffset + found.bytes.byteLength,
                    ) as ArrayBuffer,
                },
                error: null,
              };
            },
            async remove(keys) {
              if (failures.remove) return { error: { message: failures.remove } };
              for (const key of keys) objects.delete(`${bucket}/${key}`);
              return { error: null };
            },
          };
        },
      },
    };

    return { client, objects };
  }

  it("satisfies the port, keeping each bucket's objects to itself", async () => {
    // The two buckets are a security boundary, not a folder convention
    // (SECURITY.md S1-9 item 2), so the same key in each must be two objects.
    const { client, objects } = fakeStorage();
    const store = createSupabaseObjectStore(() => client);
    const key = `${randomUUID()}/${randomUUID()}.jpg`;

    await store.put(ORIGINALS_BUCKET, key, {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    });
    await store.put(DISPLAY_BUCKET, key, {
      bytes: new Uint8Array([9, 9]),
      contentType: "image/webp",
    });

    expect(objects.has(`${ORIGINALS_BUCKET}/${key}`)).toBe(true);
    expect(objects.has(`${DISPLAY_BUCKET}/${key}`)).toBe(true);

    expect(await store.get(ORIGINALS_BUCKET, key)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    });

    // `remove` exists so a blocked image leaves no object behind, and it must
    // remove from the bucket it was given and no other.
    await store.remove(ORIGINALS_BUCKET, key);
    expect(await store.get(ORIGINALS_BUCKET, key)).toBeNull();
    expect(await store.get(DISPLAY_BUCKET, key)).not.toBeNull();
  });

  it("raises a typed external failure when a write is rejected", async () => {
    const { client } = fakeStorage({ upload: "new row violates row-level security policy" });
    const store = createSupabaseObjectStore(() => client);

    await expect(
      store.put(DISPLAY_BUCKET, "a/b.webp", {
        bytes: new Uint8Array([0]),
        contentType: "image/webp",
      }),
    ).rejects.toMatchObject({ kind: "external_failure", code: "uploads.storage_write_failed" });
  });

  it("reports a missing object as absent, and a failed removal as an error", async () => {
    // Asymmetric on purpose: a `get` that cannot find an object is an ordinary
    // answer, while a `remove` that fails means an image blocked by screening
    // may still be sitting in a bucket, which the caller must hear about.
    const missing = createSupabaseObjectStore(() => fakeStorage().client);
    expect(await missing.get(DISPLAY_BUCKET, "a/b.webp")).toBeNull();

    const { client } = fakeStorage({ remove: "permission denied" });
    await expect(
      createSupabaseObjectStore(() => client).remove(ORIGINALS_BUCKET, "a/b.jpg"),
    ).rejects.toMatchObject({ kind: "external_failure", code: "uploads.storage_remove_failed" });
  });
});
