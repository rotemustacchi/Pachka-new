/**
 * The boundaries `uploads` is not allowed to be sure about.
 *
 * ARCHITECTURE.md's test policy permits a deterministic fake for "AI providers,
 * email, and payment ... *external boundaries only* -- never for PACHKA's own
 * logic". This file is the complete list of what that means here: the object
 * store, the vision model, and the embedding model. Everything else in this
 * module -- the technical gate, the derivative encoder, the response parser,
 * the publication gate, the recompute decision -- is PACHKA's own logic and is
 * tested against the real thing.
 *
 * Each port is deliberately narrow. `VisionAnalyst` returns `unknown` rather
 * than a parsed shape because SECURITY.md S2-20 is emphatic that the model's
 * response is attacker-influenced data: the image is fully attacker-controlled
 * and the model is being asked to describe it. A port typed as
 * `Promise<VisionAnalysis>` would be a lie the type system then defends, so the
 * parsing lives on our side of the boundary, in `analysis.ts`, where a
 * deviation is a screening failure rather than a cast.
 */
import type { AppError } from "@/shared/errors";

// ---------------------------------------------------------------------------
// Object store
// ---------------------------------------------------------------------------

/**
 * The two buckets, and why there are two.
 *
 * SECURITY.md S1-9 item 2: "Originals live in a separate, private bucket with
 * no public read policy and no signed-URL generation from any buyer-facing code
 * path." `upload-pipeline` requires the original to be retained and design.md
 * says it is never served publicly -- which, if the original sat next to the
 * display image in one public bucket under a sibling key, would be a naming
 * convention rather than a control.
 */
export const DISPLAY_BUCKET = "artwork-images";
export const ORIGINALS_BUCKET = "artwork-originals";

export type Bucket = typeof DISPLAY_BUCKET | typeof ORIGINALS_BUCKET;

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * Somewhere to put bytes. Supabase Storage in production.
 *
 * `put` overwrites, because the pipeline generates a fresh random key for every
 * object it writes and a collision would be a UUID collision. `remove` exists
 * for one reason: an image blocked by safety screening must leave no object
 * behind (SECURITY.md S0-7 tests: "no object remains in the artwork bucket").
 */
export interface ObjectStore {
  put(bucket: Bucket, key: string, object: StoredObject): Promise<void>;
  get(bucket: Bucket, key: string): Promise<StoredObject | null>;
  remove(bucket: Bucket, key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

export interface VisionRequest {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * One vision call per uploaded image, at upload, and none at query time.
 *
 * design.md and the change proposal both make the cost argument: AI spend must
 * scale with the number of artworks, never with traffic. That is why this
 * interface has one method and why `analysis.ts` calls it exactly once per
 * accepted image, after the local gate has already rejected everything it can
 * reject for free.
 *
 * The implementation is responsible for its own timeout. It SHOULD reject with
 * an `AppError` of kind `rate_limited` for a 429 and `external_failure` for
 * anything else, because `screening.ts` retries the first class and not the
 * second (SECURITY.md S0-7 item 2: "A 429 or a timeout is *retryable*, not
 * *unavailable*"). A rejection that is not an `AppError` is treated as
 * unavailable, which is the safe reading.
 */
export interface VisionAnalyst {
  /** Returns the model's raw JSON. Parsed and validated by `analysis.ts`. */
  analyse(request: VisionRequest): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  readonly vector: readonly number[];
  /** Identifies the model, so two incomparable vectors never share a table. */
  readonly model: string;
}

/**
 * Turns the description and taxonomy into the vector the matchmaker ranks on.
 *
 * Text, not pixels: design.md's pipeline is "one embedding call over that
 * description plus the taxonomy values". The description already came out of
 * the single vision call, so this does not add a second look at the image.
 */
export interface Embedder {
  embed(text: string): Promise<EmbeddingResult>;
}

/** True when a rejection asks to be retried rather than treated as an outage. */
export function isRetryable(error: unknown): boolean {
  return (error as AppError | undefined)?.kind === "rate_limited";
}
