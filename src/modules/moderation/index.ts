/**
 * `moderation` — reporting, the admin queue, takedown, suspension, and the
 * append-only admin audit.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * Dependencies, per the allowed-dependency table: `artworks`, `accounts`,
 * `uploads`. `accounts` is imported directly. `artworks` and `uploads` have not
 * shipped, so what this module needs from them is written down as a port in
 * ./ports rather than guessed at or -- worse -- built here as a table this
 * module would not own.
 */

export { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, readAuditTrail, recordAdminAction, verifyAuditChain } from "./audit";
export type {
  AdminActionRecord,
  AuditAction,
  AuditEntry,
  AuditTargetType,
  AuditTrailFilter,
  ChainVerification,
  ChainVerificationOptions,
} from "./audit";

export { isAdmin, requireAdmin, withAdminAction, type AdminActor } from "./admin";

export {
  isAccountSuspended,
  reinstateAccount,
  suspendAccount,
  type ReinstateAccountInput,
  type ReinstatementResult,
  type SuspendAccountInput,
  type SuspensionResult,
} from "./suspension";

export { payoutLedgerUnavailable } from "./ports";
export type {
  ArtworkModerationPort,
  Mailer,
  OutboundMessage,
  OutstandingPayouts,
  PayoutLedgerPort,
  RemovedArtwork,
} from "./ports";

export type { ModerationDeps } from "./deps";
export { txAsDatabase } from "./tx-database";
