import {
  createAnthropicVisionAnalyst,
  createSupabaseObjectStore,
  createVoyageEmbedder,
  type UploadsDeps,
} from "@/modules/uploads";
import { getDatabase, type Database } from "@/shared/db";
import { artworksDeps } from "@/app/_lib/deps";

/**
 * `uploads`, with its three ports bound to the real providers.
 *
 * The adapters were written, tested and then reached by nothing — the module
 * ran only against fakes. This is the composition root that makes the pipeline
 * real, and it is the only place in the product that names a vendor.
 *
 * Both AI calls are UPLOAD-TIME. `ARCHITECTURE.md` is explicit that AI spend
 * scales with the number of artworks and never with traffic, so if either of
 * these ever appears on a request path, that is the bug.
 *
 * Missing keys degrade in opposite directions, deliberately. With no
 * `ANTHROPIC_API_KEY` every screening call fails, which routes to
 * `screening_unavailable` and blocks publication — an unscreened published
 * image is a safety hole. With no `VOYAGE_API_KEY` publication proceeds and the
 * artwork is browsable but unranked, which is only a degraded experience.
 * Neither crashes the app, and there is no "screening off in development"
 * branch, because that is the branch that ends up enabled in production.
 */
export function uploadsDeps(db: Database = getDatabase()): UploadsDeps {
  return {
    db,
    store: createSupabaseObjectStore(),
    vision: createAnthropicVisionAnalyst(),
    embedder: createVoyageEmbedder(),
    artworks: artworksDeps(db),
  };
}
