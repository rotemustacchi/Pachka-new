/**
 * What the uploads module needs handed to it.
 *
 * The database is real in every test (ARCHITECTURE.md's test policy: the
 * database is never mocked, and neither is PACHKA's own code), so `db` is not a
 * seam -- it is just a dependency. The three that ARE seams are the ones in
 * `ports.ts`: the object store, the vision model and the embedding model, which
 * is the complete list of external boundaries this module touches.
 *
 * `artworks` is not a port. It has shipped, ARCHITECTURE.md's dependency table
 * allows uploads -> artworks, so this module imports it directly and writes
 * `artwork_images` through `attachImage` rather than inserting.
 */
import type { ArtworksDeps } from "@/modules/artworks";
import type { Database } from "@/shared/db";
import type { Embedder, ObjectStore, VisionAnalyst } from "./ports";
import { DEFAULT_RETRY, type RetryPolicy } from "./screening";

export interface UploadsDeps {
  readonly db: Database;
  /** Supabase Storage in production. See `supabase-object-store.ts`. */
  readonly store: ObjectStore;
  /** The Claude Haiku vision call. One per uploaded image, at upload. */
  readonly vision: VisionAnalyst;
  /** Turns the description plus taxonomy into the matchmaker's ranking vector. */
  readonly embedder: Embedder;
  /**
   * The artworks module's own dependencies, for `attachImage` and
   * `setPrimaryImage`. Once `orders` ships, the demand source in here must be
   * the real one rather than the zero-reporting stand-in.
   */
  readonly artworks: ArtworksDeps;
  /**
   * How hard to retry a rate-limited screening call before declaring it
   * unavailable. SECURITY.md S0-7 item 2. Overridden in tests so the retry can
   * be proven without a sleeping test.
   */
  readonly retry?: RetryPolicy;
}

export function retryPolicy(deps: UploadsDeps): RetryPolicy {
  return deps.retry ?? DEFAULT_RETRY;
}
