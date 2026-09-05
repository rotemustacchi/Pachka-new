/**
 * PACHKA's mail transport, and the one contract every module speaks to it.
 *
 * ONE INTERFACE, TWO ADAPTERS, SIX AGREEING CALLERS
 * ------------------------------------------------
 * `MailTransport` is the whole delivery surface. `createResendMailer` is the
 * production adapter and reaches the network with `fetch`; `createLoggingMailer`
 * is what a deployment with no `RESEND_API_KEY` gets, and it records rather than
 * sends. `createMailer()` picks between them from the environment and never
 * throws.
 *
 * The six modules that produce notifications used to disagree about who writes
 * the words. They no longer do. Every one of `orders`, `payouts`, `shipping`,
 * `certificates`, `matchmaker` and `moderation` returns `NotificationRequest`
 * descriptors and sends nothing; `dispatchNotifications` resolves the address,
 * composes the words, and delivers. `contract.ts` is that descriptor and imports
 * nothing, so depending on it costs a module no transport.
 *
 * `deliverQuietly` is the rule that matters most: delivery never breaks the
 * operation that triggered it.
 */
export { hebrewHtmlBody, escapeHtml, textBody } from "./body";
export { createLoggingMailer, redactAddress, type LoggingMailer, type RecordedMail } from "./logging";
export { createResendMailer, RESEND_ENDPOINT, type FetchLike } from "./resend";
export {
  appMailer,
  createMailer,
  deliverQuietly,
  mailHealth,
  resetMailerCache,
  type CreateMailerOptions,
  type MailEnvironment,
} from "./transport";
export type {
  AddressBook,
  AddressLookup,
  NotificationAudience,
  NotificationRequest,
} from "./contract";
export {
  composeNotification,
  dispatchNotifications,
  type NotificationContext,
  type NotificationOutcome,
} from "./notifications";
export type {
  DeliveryOutcome,
  MailMessage,
  Mailer,
  MailTransport,
  MailTransportKind,
  MailTransportState,
} from "./types";
