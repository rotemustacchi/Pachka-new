/**
 * PACHKA's mail transport.
 *
 * ONE INTERFACE, TWO ADAPTERS, FOUR DISAGREEING CALLERS
 * -----------------------------------------------------
 * `MailTransport` is the whole surface. `createResendMailer` is the production
 * adapter and reaches the network with `fetch`; `createLoggingMailer` is what a
 * deployment with no `RESEND_API_KEY` gets, and it records rather than sends.
 * `createMailer()` picks between them from the environment and never throws.
 *
 * The four modules that need mail do not ask for it the same way, and this
 * directory adapts to them rather than the other way round:
 *
 *   `matchmaker` and `moderation` declare a `Mailer` port taking a composed
 *     `{ to, subject, body }`. A `MailTransport` satisfies both as-is.
 *   `orders`, `payouts` (and `shipping`, `certificates`) return
 *     `NotificationRequest` descriptors instead. `dispatchNotifications`
 *     resolves the address, composes the Hebrew, and sends.
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
export {
  composeNotification,
  dispatchNotifications,
  type AddressBook,
  type NotificationContext,
  type NotificationOutcome,
  type NotificationRequest,
} from "./notifications";
export type {
  DeliveryOutcome,
  MailMessage,
  Mailer,
  MailTransport,
  MailTransportKind,
  MailTransportState,
} from "./types";
