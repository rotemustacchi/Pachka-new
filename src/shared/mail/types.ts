/**
 * One message, and somewhere to hand it.
 *
 * WHY THIS SHAPE AND NOT ANOTHER
 * ------------------------------
 * Four modules need mail and they do not agree on how to ask for it. Two of
 * them — `matchmaker` and `moderation` — declare their own `Mailer` port whose
 * `send` takes `{ to, subject, body }` and returns `Promise<void>`. The other
 * two — `orders` and `payouts`, joined by `shipping` and `certificates` — declare
 * no mailer at all: they return `NotificationRequest` descriptors and expect the
 * composition root to resolve an address, compose the words, and send.
 *
 * `MailMessage` is therefore deliberately a superset of the first pair's message
 * type with `html` optional, so a `MailTransport` is structurally assignable to
 * both `matchmaker.Mailer` and `moderation.Mailer` with no adapter object in
 * between. `notifications.ts` handles the second pair by turning a descriptor
 * into one of these. Nothing in this directory edits a module to make that work.
 *
 * SECURITY.md S2-21 item 5: platform mail uses a fixed `From`, and "no
 * user-supplied value ever populates any address header". `MailMessage` has no
 * `from`, `replyTo`, `cc` or `bcc` field, so there is nowhere for a caller to
 * put one. The sender comes from `MAIL_FROM` at the transport, once.
 */

/**
 * A composed message. `body` is the canonical plain-text part and is always
 * present; `html` is a rendering of the same words, never extra ones.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Optional HTML part. When absent the transport derives one from `body`. */
  readonly html?: string;
}

/**
 * Somewhere to hand a message.
 *
 * Structurally identical to `matchmaker.Mailer` and `moderation.Mailer` on
 * purpose: a value of this type satisfies both without a wrapper.
 *
 * `send` REJECTS on a delivery failure rather than returning a status. That is
 * the contract both module ports already state, and it is the right one — a
 * caller that must survive a failure has to write the `catch` explicitly, which
 * is a line a reviewer can see. `deliverQuietly` in `transport.ts` is that
 * `catch`, written once.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Which adapter is in place, and whether it can actually deliver anything. */
export type MailTransportKind = "resend" | "logging";

/**
 * What a health check needs to know, and what a developer needs to be told.
 *
 * `configured: false` is not an error and must never crash a checkout, but it
 * is also not a detail to be discovered in production by noticing that nobody
 * ever received anything. So it is a value, it is on the transport, and
 * `mailHealth()` returns it.
 */
export interface MailTransportState {
  readonly kind: MailTransportKind;
  /** True only when a real provider is wired and can be called. */
  readonly configured: boolean;
  /** The fixed platform sender, or null when none is set. */
  readonly from: string | null;
  /** Why mail is not configured. Null when it is. */
  readonly reason: string | null;
}

/** A mailer that can say what it is. */
export interface MailTransport extends Mailer {
  state(): MailTransportState;
}

/** What `deliverQuietly` reports. Mirrors `moderation`'s own notification result. */
export interface DeliveryOutcome {
  readonly sent: boolean;
  /** A short, address-free description of the failure. Null on success. */
  readonly error: string | null;
}
