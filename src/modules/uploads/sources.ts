/**
 * The implementations other modules inject, packaged as the ports they declare.
 *
 * Two one-line objects, and they earn their file by being the seam. A module
 * that depends on `uploads` composes it here rather than importing
 * `flaggedUploads` or `rankableArtworkIds` and matching the signature by hand;
 * if either shape moves, this file stops compiling and the change is visible in
 * one place instead of at every call site.
 */
import type { FlaggedUploadSource, MatchmakerExclusion } from "./contracts";
import { flaggedUploads } from "./events";
import { rankableArtworkIds } from "./embeddings";

/** For `moderation`'s admin queue. */
export function flaggedUploadSource(): FlaggedUploadSource {
  return { flaggedForReview: flaggedUploads };
}

/**
 * For `matchmaker`. An artwork absent from the returned set is browsable in the
 * catalog and excluded from ranking, which is upload-pipeline's "Embedding
 * generation fails" scenario stated as a query rather than as a flag.
 */
export function matchmakerExclusion(): MatchmakerExclusion {
  return { rankable: rankableArtworkIds };
}
