/**
 * The adapter for a deployment with no mail account: it records, and succeeds.
 *
 * Development must not require signing up for a mail provider, and a missing
 * `RESEND_API_KEY` must never be the reason a checkout fails. Those two
 * sentences together are the entire justification for this file — and they are
 * also exactly how a platform ends up in production believing it sends mail.
 *
 * So the honesty is built in rather than remembered:
 *
 *   1. It says so, loudly, ONCE per process, at `warn`. Once, because a warning
 *      printed on every send is a warning that gets filtered out by the second
 *      day.
 *   2. It says so per message too, at `info`, naming the subject and the
 *      template so a developer can see the flow worked end to end.
 *   3. `state().configured` is `false`, and `mailHealth()` surfaces it, so a
 *      health check can fail a deploy that believed it was wired.
 *
 * WHY IT SUCCEEDS RATHER THAN THROWING
 * ------------------------------------
 * `matchmaker.noMailer` throws, and its header argues the case well: under
 * double opt-in a failed confirmation costs one buyer one email and leaks
 * nothing. But that reasoning is local to notify-me. Applied to `orders` it
 * means a checkout that has already reserved inventory and taken a commitment
 * fails at the notification, and applied to `moderation` it means a report the
 * spec requires to stay recorded is recorded with an error where a delivery
 * should be. Delivery is not allowed to break the operation that triggered it,
 * and the cheapest way to guarantee that is for the default adapter to have no
 * failure mode at all.
 *
 * WHAT IS RECORDED, AND WHAT IS NOT
 * ---------------------------------
 * `records` holds the full message including the address, in memory, for the
 * life of the process. That is what makes it useful in development and what
 * makes it testable. It is NOT what gets logged: the log line carries the
 * subject and a redacted address, because SECURITY.md's log-redaction rule
 * names notify-me addresses explicitly and a server log is not a place an
 * address may accumulate.
 */
import type { MailMessage, MailTransport, MailTransportState } from "./types";

/** One message that was not sent, with when it was not sent. */
export interface RecordedMail extends MailMessage {
  readonly recordedAt: Date;
}

export interface LoggingMailerOptions {
  /** Why no provider is configured. Shown in the warning and in `state()`. */
  readonly reason: string;
  /** Injected so a test can read what was logged without capturing globals. */
  readonly log?: Pick<Console, "warn" | "info">;
  /** Cap on retained messages, so a long-running dev server cannot grow forever. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 100;

/**
 * `dana@example.com` becomes `d***@example.com`. Enough to recognise an address
 * you already know, not enough to be a copy of one you do not.
 */
export function redactAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

export interface LoggingMailer extends MailTransport {
  /** Everything this process has been asked to send, newest last. */
  readonly records: readonly RecordedMail[];
}

export function createLoggingMailer(options: LoggingMailerOptions): LoggingMailer {
  const log = options.log ?? console;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const records: RecordedMail[] = [];
  let warned = false;

  const state: MailTransportState = {
    kind: "logging",
    configured: false,
    from: null,
    reason: options.reason,
  };

  return {
    records,
    state: () => state,

    async send(message: MailMessage): Promise<void> {
      if (!warned) {
        warned = true;
        log.warn(
          `[mail] NOT CONFIGURED — no email is being delivered. ${options.reason} ` +
            `Set RESEND_API_KEY and MAIL_FROM to send for real. ` +
            `Messages are being written to this log instead.`,
        );
      }

      log.info(
        `[mail] would send to ${redactAddress(message.to)}: ${message.subject}`,
      );

      records.push({ ...message, recordedAt: new Date() });
      if (records.length > limit) records.splice(0, records.length - limit);
    },
  };
}
