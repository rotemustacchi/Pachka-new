/**
 * `uploads` — the automated gate every image passes through, and the embedding
 * the matchmaker later ranks against.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * THE ONE THING TO KNOW BEFORE READING ANY OF IT
 * ----------------------------------------------
 * AI cost scales with the number of ARTWORKS, never with traffic. That single
 * constraint decides the shape of everything here: the local technical gate
 * runs before any paid call so a rejected image costs nothing; there is exactly
 * ONE vision call per uploaded image, carrying taxonomy, colours, the safety
 * verdict and the description together; and the embedding computed from that
 * description is stored once and recomputed only when the primary image
 * changes, so no matchmaker query ever reaches an AI provider.
 *
 * FOR THE MODULES THAT DEPEND ON THIS ONE
 * ---------------------------------------
 * `moderation` — `flaggedUploadSource()` satisfies your `FlaggedUploadSource`
 * port. This module deliberately does not import yours: your dependency table
 * entry points moderation -> uploads, and importing back would invert it.
 * `clearScreening` is the pipeline's half of an admin clearing a blocked
 * upload; call it on your own transaction so it commits with your audit row.
 *
 * `matchmaker` — `matchmakerExclusion()` answers "which of these may I rank".
 * An artwork with no embedding is browsable and unrankable, and that is the
 * ABSENCE of a row rather than a flag, so there is nothing to keep in sync.
 * `embeddingVectorFor` gives you the stored vector; do not compute one.
 *
 * `app/` routes — `processUpload` is the only way bytes become an artwork
 * image, and `publishArtwork` here is the only publication path that consults
 * screening. Do not call `artworks.publishArtwork` directly from a route: see
 * the header of `publish.ts` for what that would skip and for the change to
 * `artworks` that would make it impossible rather than merely wrong.
 */

// ---- The pipeline. The only way bytes become an artwork image.
export {
  processUpload,
  type UploadRequest,
  type UploadResult,
} from "./pipeline";

// ---- Publication, gated on screening, and the classification form's state.
export {
  classificationState,
  publishArtwork,
  type PublishOutcome,
} from "./publish";

// ---- The local technical gate. Free, and therefore first.
export {
  assessQuality,
  judge,
  laplacianVariance,
  orientedSize,
  qualityRejection,
  readImageFacts,
  BLUR_SAMPLE_EDGE_PX,
  type DecodeFailure,
  type ImageFacts,
  type QualityFailure,
  type QualityVerdict,
} from "./quality";

// ---- What a file is allowed to be, and how big.
export {
  assertWithinUploadSizeLimit,
  contentTypeFor,
  extensionFor,
  isAcceptedFormat,
  ACCEPTED_FORMATS,
  DERIVATIVE_CONTENT_TYPE,
  DERIVATIVE_EXTENSION,
  DERIVATIVE_FORMAT,
  MAX_UPLOAD_BYTES,
  type AcceptedFormat,
} from "./formats";

// ---- Derivatives: re-encoded, metadata-free, unwatermarked.
export { buildDerivatives, type Derivative, type Derivatives } from "./derivatives";

// ---- Server-generated object keys. Nothing here takes a filename.
export { generateObjectKeys, OBJECT_KEY_PATTERN, type ObjectKeys } from "./keys";

// ---- The one vision call, and the parser that refuses to trust it.
export {
  analyse,
  noRejections,
  nothingRejected,
  parseAnalysis,
  MAX_DOMINANT_COLOURS,
  type DominantColour,
  type ParsedAnalysis,
  type RejectedValues,
  type SafetyVerdict,
  type Suggestions,
} from "./analysis";

// ---- Screening, and the publication gate derived from it.
export {
  assertPublishable,
  clearScreening,
  primaryImageIsScreened,
  screen,
  screeningVerdictFor,
  DEFAULT_RETRY,
  type RetryPolicy,
  type ScreeningOutcome,
} from "./screening";

// ---- Suggestions in, artist's choice out, provenance recorded per field.
export {
  classificationProvenance,
  dominantColoursFor,
  emptySuggestions,
  provenanceOf,
  recordClassification,
  suggestionsFor,
  CLASSIFIED_FIELDS,
  type ArtistClassification,
  type ClassificationProvenance,
  type ClassifiedField,
  type Provenance,
  type RecordedClassification,
} from "./classification";

// ---- The embedding. Once per primary image, never at query time.
export {
  embeddingFor,
  embeddingText,
  embeddingVectorFor,
  ensureEmbedding,
  rankableArtworkIds,
  toVectorLiteral,
  EMBEDDING_DIMENSIONS,
  type EmbeddingOutcome,
  type EmbeddingSource,
  type StoredEmbedding,
} from "./embeddings";

// ---- The append-only event log the gate and the admin queue are derived from.
export {
  eventsFor,
  flaggedUploads,
  latestEventForImage,
  recordEvent,
  FLAGGED_EVENTS,
  UPLOAD_EVENTS,
  type RecordEventInput,
  type UploadEvent,
  type UploadEventRow,
} from "./events";

// ---- "This object came from the pipeline", checkable.
export { assertPipelineProduced, isPipelineProduced } from "./provenance";

// ---- Thresholds, all of them from `app_config`.
export {
  thumbnailDimension,
  uploadThresholds,
  THUMBNAIL_FRACTION,
  type UploadThresholds,
} from "./config";

// ---- The external boundaries, and the production adapters for all three.
export {
  isRetryable,
  DISPLAY_BUCKET,
  ORIGINALS_BUCKET,
  type Bucket,
  type Embedder,
  type EmbeddingResult,
  type ObjectStore,
  type StoredObject,
  type VisionAnalyst,
  type VisionRequest,
} from "./ports";
export {
  createSupabaseObjectStore,
  type StorageBucketApi,
  type StorageClient,
  type StorageClientFactory,
  type StorageObjectBody,
} from "./supabase-object-store";
export {
  createAnthropicVisionAnalyst,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  VISION_IMAGE_LONG_EDGE_PX,
  VISION_MODEL,
  VISION_TIMEOUT_MS,
  type AnthropicVisionOptions,
  type HttpTransport,
} from "./anthropic-vision";
export {
  createVoyageEmbedder,
  EMBEDDING_MODEL,
  EMBEDDING_TIMEOUT_MS,
  VOYAGE_EMBEDDINGS_URL,
  type VoyageEmbedderOptions,
} from "./voyage-embedder";

// ---- What other modules read out of this one.
export type { FlaggedUpload, FlaggedUploadSource, MatchmakerExclusion } from "./contracts";
export { flaggedUploadSource, matchmakerExclusion } from "./sources";

// ---- Dependencies this module is handed.
export { retryPolicy, type UploadsDeps } from "./deps";
