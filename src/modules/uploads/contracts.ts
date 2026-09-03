/**
 * What other modules read out of this one, declared here rather than imported.
 *
 * ARCHITECTURE.md's allowed-dependency table lets `uploads` call `artworks` and
 * nothing else. `moderation` points AT uploads: it declares
 * `FlaggedUploadSource` and takes an implementation, exactly as `artworks`
 * takes `InventoryDemandSource` from `orders`. So the arrow runs
 * moderation -> uploads, and this module must not import from moderation to
 * satisfy it -- that would invert the edge while hiding the inversion in an
 * import graph nobody reads.
 *
 * The types below are therefore structural twins of the ones on the other side,
 * stated once here, with an integration test that assigns
 * `uploads.flaggedUploadSource()` to moderation's `FlaggedUploadSource` and
 * would stop compiling if either shape moved. That test is the coupling; the
 * duplication is what pays for the direction of the arrow.
 *
 * `matchmaker` will read `MatchmakerExclusion` the same way when it ships.
 */
import type { Sql } from "@/shared/db";

/** One upload awaiting a human decision. Structural twin of moderation's. */
export interface FlaggedUpload {
  readonly artworkId: string;
  readonly flaggedAt: Date;
  /** Why the pipeline could not clear it. Written by us, not by the model. */
  readonly note: string;
}

/** Structural twin of moderation's `FlaggedUploadSource`. */
export interface FlaggedUploadSource {
  flaggedForReview(sql: Sql, limit: number): Promise<readonly FlaggedUpload[]>;
}

/**
 * What `matchmaker` must ask before ranking.
 *
 * upload-pipeline, "Embedding generation fails": an artwork with no embedding
 * "is still published and remains browsable in the catalog, but is excluded
 * from matchmaker results until an embedding exists". Two different answers to
 * "is this artwork visible", so they are two different questions and the second
 * one belongs to whoever owns the embeddings -- this module.
 *
 * Stated as a source rather than as a boolean helper because the matchmaker
 * ranks a set: asking once per candidate would be a query per artwork per
 * questionnaire, which is the traffic-scaled cost the whole design exists to
 * avoid.
 */
export interface MatchmakerExclusion {
  /**
   * Of the given artworks, the ones that have an embedding and may be ranked.
   * Everything absent from the returned set is browsable but unrankable.
   */
  rankable(sql: Sql, artworkIds: readonly string[]): Promise<ReadonlySet<string>>;
}
