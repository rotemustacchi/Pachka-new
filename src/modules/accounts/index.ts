/**
 * `accounts` — who can use PACHKA, what each role can do, and the public artist
 * profile.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * `accounts` has no outgoing dependencies. It is the only module in the table
 * with none, and that is deliberate: everything else can depend on identity, so
 * identity can depend on nothing without creating a cycle. Where accounts needs
 * a fact owned by another module -- "does this buyer have a delivered order
 * from this artist" -- it takes a port and the caller supplies it. See
 * `OrderEligibility` in ./reviews.
 */

// The scanner. Shared, single implementation: every module that accepts free
// text destined for a public surface calls this one (SECURITY.md S2-19 item 1).
export {
  SCANNER_VERSION,
  containsContactDetails,
  explainFindings,
  normaliseForScanning,
  scanForContactDetails,
  type ContactFinding,
  type ContactFindingKind,
} from "./contact-scanner";

// The one serializer allowed to shape artist data for a buyer. Second line of
// defence, never the only one -- the first is the table split (SECURITY.md S0-1).
export {
  PUBLIC_ARTIST_COLUMNS,
  toPublicArtist,
  type ArtistProfileRow,
  type PublicArtist,
} from "./serialize";

export type { AccountsDeps, RequestOrigin } from "./deps";
export type { AuthGateway, AuthUser, CreateUserOutcome } from "./auth-gateway";

export { normaliseEmail, register, type RegisterInput, type RegistrationResult } from "./registration";

export {
  isSuspended,
  reinstateAccount,
  requestPasswordReset,
  rolesFor,
  signIn,
  signOut,
  suspendAccount,
  type PasswordResetResult,
  type SignInInput,
  type SignedInAccount,
} from "./session";

// The gate `artworks` and `orders` call before publishing or placing an order.
export {
  assertEmailVerified,
  isEmailVerified,
  resendVerificationEmail,
  syncEmailVerification,
  type GatedAction,
} from "./verification";

export {
  findOwnArtistProfile,
  findPublicArtist,
  hasRole,
  saveArtistContactDetails,
  upgradeToArtist,
  type ArtistContactInput,
  type ArtistUpgradeInput,
} from "./artist";

export {
  denyAllOrders,
  editReview,
  getArtistReviews,
  restoreReviewsForOrder,
  sqlOrderEligibility,
  submitReview,
  summarise,
  withdrawReviewsForReturnedOrder,
  type ArtistReviews,
  type OrderEligibility,
  type Review,
  type ReviewEligibilityQuery,
  type ReviewSummary,
  type SubmitReviewInput,
} from "./reviews";

export { consumeRateLimit, hashSubject, pruneRateLimitEvents, type RateLimitBucket } from "./rate-limit";
