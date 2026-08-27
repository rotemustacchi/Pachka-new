/**
 * `moderation` — reporting, the admin queue, takedown, suspension, and the
 * append-only admin audit.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * Dependencies, per the allowed-dependency table: `artworks`, `accounts`,
 * `uploads`. The first two are imported directly. `uploads` has not shipped, so
 * what this module needs from it is stated as a port in ./ports rather than
 * guessed at or built here as a table this module would not own. `payouts` is
 * not on that list at all, which is why suspension takes a port for the ledger
 * and never reads it.
 */

// ---- The append-only audit. The database does the work; this is the wrapper.
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

// ---- Who may act, and the transaction every admin action runs in.
export { isAdmin, requireAdmin, withAdminAction, type AdminActor } from "./admin";

// ---- Public reporting. The only anonymous write surface in this module.
export {
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  fileReport,
  isReportReason,
  openReportCount,
  queueItemUrl,
  type FileReportInput,
  type FileReportResult,
  type ReportReason,
  type ReportSubject,
} from "./reports";

export {
  REPORT_MAX_PER_WINDOW,
  REPORT_WINDOW_MINUTES,
  consumeReportRateLimit,
  hashSubject,
  pruneModerationRateLimitEvents,
  type ModerationRateLimitBucket,
} from "./rate-limit";

// ---- The admin queue: open reports grouped by subject, plus flagged uploads.
export {
  listQueue,
  resolveQueueItem,
  type ListQueueOptions,
  type QueueItem,
  type QueueItemKind,
  type QueueReason,
  type QueueResolution,
  type QueueSubjectType,
  type ResolveQueueItemInput,
  type ResolveQueueItemResult,
} from "./queue";

// ---- Takedown. Writes `artworks` through the artworks module, never directly.
export {
  takeDownArtwork,
  type TakeDownArtworkInput,
  type TakeDownArtworkResult,
} from "./takedown";

// ---- Suspension and reinstatement, through the accounts module.
export {
  isAccountSuspended,
  reinstateAccount,
  suspendAccount,
  type ReinstateAccountInput,
  type ReinstatementResult,
  type SuspendAccountInput,
  type SuspensionResult,
} from "./suspension";

// ---- Ports for modules that have not shipped, and their stand-ins.
export { noFlaggedUploads, payoutLedgerUnavailable } from "./ports";
export type {
  FlaggedUpload,
  FlaggedUploadSource,
  Mailer,
  OutboundMessage,
  OutstandingPayouts,
  PayoutLedgerPort,
} from "./ports";

export { artworksDepsOn, type ModerationDeps } from "./deps";
export { txAsDatabase } from "./tx-database";
