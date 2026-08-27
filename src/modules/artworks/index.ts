/**
 * `artworks` — what a listing is, what it must contain before it can be seen,
 * and what state it is in.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * FOR THE MODULES THAT DEPEND ON THIS ONE
 * ---------------------------------------
 * `orders` — availability is DERIVED, never stored. There is no counter column
 * to decrement and adding one is a defect (ARCHITECTURE.md). Take
 * `lockArtworkForUpdate` first, derive with `availableUnits`, insert your
 * reservation, then call `reconcileAvailability` inside the same transaction.
 * Implement `InventoryDemandSource` and inject it: this module cannot import
 * yours, and `noDemand` reports zero for everything until you do.
 *
 * `matchmaker` — implement `ImpressionSource` and inject it, same reason.
 * Rank on the closed taxonomy exported here; it is closed so that overlap
 * between a buyer's answers and an artwork's classification means something.
 *
 * `uploads` — `artwork_images` belongs to this module, so attach through
 * `attachImage` rather than inserting. `setPrimaryImage` is the signal to
 * recompute an embedding.
 *
 * `catalog` — use `listPublishedArtworks` and `findPublicArtwork`, or at least
 * the visibility predicate they share. An artwork is public when it is
 * published AND its artist is not suspended, and the second half is derived.
 *
 * `moderation` — `removeArtwork` is one-way, by design. This module does not
 * write your audit row or send the artist's notice; do both alongside it.
 */

// ---- The closed taxonomy. Server-defined; artists cannot introduce values.
export {
  MEDIA,
  STYLES,
  TARGET_SPACES,
  MOODS,
  TAXONOMY_AXES,
  MEDIA_REQUIRING_DEPTH,
  WALL_MOUNTED_MEDIA,
  AXIS_LABELS,
  MEDIUM_LABELS,
  STYLE_LABELS,
  TARGET_SPACE_LABELS,
  MOOD_LABELS,
  isMedium,
  isStyle,
  isTargetSpace,
  isMood,
  mediumRequiresDepth,
  mediumRequiresFraming,
  parseTaxonomyValue,
  parseTaxonomyList,
  type Medium,
  type Style,
  type TargetSpace,
  type Mood,
  type TaxonomyAxis,
} from "./taxonomy";

// ---- The domain type and its states.
export {
  ARTWORK_STATUSES,
  INVENTORY_TYPES,
  toArtwork,
  ARTWORK_COLUMNS,
  type Artwork,
  type ArtworkRow,
  type ArtworkStatus,
  type InventoryType,
  type OriginalityDeclaration,
} from "./types";

// ---- The lifecycle state machine. The only authority on a status change.
export {
  ARTWORK_STATUS_LABELS,
  assertTransition,
  canTransition,
  isBuyerVisible,
  isPubliclyListed,
  permittedTransitions,
  type Actor,
  type TransitionRequest,
  type TransitionVerdict,
} from "./lifecycle";

// ---- Availability: derived, never stored.
export {
  ZERO_DEMAND,
  assertDemandSourceIsWired,
  availabilityFor,
  availableUnits,
  lockArtworkForUpdate,
  noDemand,
  oversoldBy,
  type Availability,
  type InventoryDemand,
  type InventoryDemandSource,
} from "./inventory";

// ---- What must be true before an artwork can be published.
export {
  asPublishCandidate,
  isReadyToPublish,
  missingForPublication,
  remainingRequirementCount,
  toFieldErrors,
  type MissingRequirement,
  type PublishCandidate,
} from "./publish-requirements";

// ---- Dimensions: stored in millimetres, spoken in centimetres.
export {
  centimetresToMillimetres,
  millimetresToCentimetres,
  formatDimensionsCm,
  formatWeightGrams,
} from "./dimensions";

// ---- Writes. The only write path to `artworks`; the data API has none.
export {
  createDraft,
  findOwnArtwork,
  publishArtwork,
  reconcileAvailability,
  removeArtwork,
  returnToDraft,
  unlistArtwork,
  updateArtwork,
  type ArtworkInput,
  type ArtworkWithAvailability,
} from "./listings";

// ---- Images. `artwork_images` is ours; `uploads` writes through here.
export {
  attachImage,
  imagesFor,
  setPrimaryImage,
  toPublicImages,
  type ArtworkImage,
  type AttachImageInput,
} from "./images";

// ---- Buyer-facing reads and shaping.
export { findPublicArtwork, isPubliclyVisible, listPublishedArtworks } from "./queries";

export {
  AI_ASSISTED_LABEL,
  AI_DISCLOSURE_LABEL,
  AI_DISCLOSURE_NO,
  AI_DISCLOSURE_YES,
  framingLabel,
  inventoryLabel,
  leadTimeLabel,
  showsAiAssistedLabel,
  toPublicArtwork,
  type PublicArtwork,
  type PublicArtworkImage,
  type TaxonomyTag,
} from "./serialize";

// ---- The artist's dashboard.
export {
  artistDashboard,
  type ArtistDashboard,
  type DashboardListing,
  type DashboardSummary,
} from "./dashboard";

// ---- Dependencies this module is handed.
export {
  depsWithoutOrdersOrMatchmaker,
  noImpressions,
  type ArtworksDeps,
  type ImpressionSource,
} from "./deps";

export {
  MAX_EDITION_SIZE,
  MAX_IMAGES_PER_ARTWORK,
  MAX_MOODS,
  MAX_STYLES,
  MAX_TARGET_SPACES,
} from "./limits";

// ---- User-facing components. Built on `shared/ui` primitives, so the
// brush-stroke button, the tag chip and the sold overlay are the approved
// treatments rather than second copies of them.
export { AiAssistedLabel, type AiAssistedLabelProps } from "./ui/AiAssistedLabel";
export { ArtworkCard, type ArtworkCardProps } from "./ui/ArtworkCard";
export {
  ArtworkSpecifications,
  specificationRows,
  type ArtworkSpecificationsProps,
} from "./ui/ArtworkSpecifications";
export { DeclarationsStep, type DeclarationsStepProps } from "./ui/DeclarationsStep";
export { TaxonomyPicker, type TaxonomyOption, type TaxonomyPickerProps } from "./ui/TaxonomyPicker";
export { UploadStepper, type UploadStepperProps } from "./ui/UploadStepper";
export {
  SPECIFICATIONS_PROMPT,
  STEP_ORDER,
  STEP_TITLES,
  allMissing,
  canPublish,
  firstIncompleteStep,
  publishButtonCaption,
  remainingCount,
  stepAfter,
  stepBefore,
  stepStatuses,
  type StepId,
  type StepStatus,
  type UploadFormState,
} from "./ui/upload-steps";
