/**
 * `shipping` — the public API. Nothing outside this module may import a deeper
 * path (ARCHITECTURE.md, "Module boundary rules").
 *
 * What this module is responsible for:
 *
 *   • the flat-rate zone x size-tier table, admin-editable, and the quote taken
 *     from it at checkout — with no carrier API call anywhere in the module;
 *   • the dispatch obligation on an artist, and the carrier/tracking/packaging
 *     evidence that permits a `shipped` transition;
 *   • the buyer's fourteen-day cancellation right, and the return case from the
 *     PACHKA return address through to the refund.
 *
 * What it is deliberately NOT responsible for:
 *
 *   • **moving an order or a fulfilment.** Every function that implies a state
 *     change returns the transition for `orders.transition()` to perform.
 *     ARCHITECTURE.md gives order state to one function, and this is not it.
 *   • **restoring inventory.** `restoreInventory` is a returned fact; the
 *     artwork row belongs to `artworks`, which `shipping` may not even import.
 *   • **sending mail.** Every path returns `NotificationRequest[]`. The caller
 *     dispatches them once its own transaction has committed, so nobody is told
 *     about something that then rolled back — and this module needs no external
 *     dependency, and therefore no fake in any of its tests.
 *   • **checking that the caller is an admin.** The route verifies the role
 *     against `user_roles` and writes the `admin_audit` row. What this module
 *     guarantees is that its tables grant `authenticated` nothing but SELECT,
 *     so no write can arrive except through these functions.
 */

export type {
  DeliveryAddress,
  FulfilmentQuote,
  NotificationAudience,
  NotificationRequest,
  PackageClassification,
  PackageDimensions,
  QuoteLine,
  ShippingQuote,
  ShippingTier,
  ShippingZone,
} from "./types";

export type { PostalAddress } from "./config";

// The rate table (8.1) — admin-editable, no deployment needed.
export {
  listZones,
  readRateTable,
  rateFor,
  setRate,
  upsertTier,
  upsertZone,
  type RateEntry,
  type RateInput,
  type TierInput,
  type ZoneInput,
} from "./rate-table";

// Tiers (8.3) and zones (8.5).
export { classifyPackage, fitsTier, listTiers, millimetresFromCentimetres, tierByCode } from "./tiers";
export { normaliseCity, resolveZone } from "./zones";

// Quoting at checkout (8.2, 8.4).
export { quoteShipping, type QuoteRequest } from "./quote";

// Fulfilment (8.6, 8.7, 8.8).
export {
  dispatchInstructions,
  flagOverdueDispatches,
  markShipped,
  outboundReturnAddress,
  readDispatch,
  recordDispatchObligation,
  type DispatchObligationInput,
  type DispatchRecord,
  type MarkShippedInput,
  type MarkShippedResult,
  type OverdueSweepResult,
} from "./dispatch";

export {
  packagingObligationFor,
  FRAGILE_BY_MEDIUM,
  type FragileReason,
  type FragilityInput,
  type PackagingObligation,
  type PackagingRequirement,
} from "./packaging";

// Return terms shown before purchase (8.10).
export { returnTerms, type ReturnTerms, type ReturnTermStatement } from "./terms";

// Returns (8.9, 8.11, 8.12).
export {
  escalateSilentArtists,
  flagUnreceivedReturns,
  forwardToArtist,
  isArtworkHeldByOpenReturn,
  readReturn,
  recordArtistResponse,
  recordOperatorReceipt,
  requestReturn,
  resolveReturnByAdmin,
  returnInstructions,
  type AdminResolutionInput,
  type AdminResolutionResult,
  type ArtistResponseInput,
  type ForwardInput,
  type ForwardingLabel,
  type OperatorReceiptInput,
  type OperatorReceiptResult,
  type RequestReturnInput,
  type RequestReturnResult,
  type ReturnCase,
  type ReturnCondition,
  type ReturnInstructions,
  type ReturnStatus,
  type SweepResult,
} from "./returns";
