/**
 * Which adapter, and the one `catch` that keeps mail out of the way.
 *
 * WHY THE VARIABLES ARE READ HERE AND NOT IN `shared/config/env.ts`
 * ----------------------------------------------------------------
 * `env.ts` parses eagerly-cached schemas whose every entry is REQUIRED for the
 * server to function; a missing one is a startup failure with a pointer to
 * `.env.example`. Mail is deliberately not that: absent, the platform still
 * runs, still takes orders and still records reports, and says so. Putting
 * `RESEND_API_KEY` in the server schema as optional would work, but the
 * decision that "absent means the logging adapter" would then live in two
 * files. It lives here, with the adapter it selects.
 *
 * SELECTION FAILS SOFT, ALWAYS
 * ----------------------------
 * There is no configuration this function throws on. A half-configured
 * deployment — a key with no `MAIL_FROM`, or a `MAIL_FROM` that is not an
 * address — selects the logging adapter with a reason saying exactly that,
 * rather than raising at the first checkout of the morning. The reason is
 * visible in `mailHealth()`, which is the surface built for noticing.
 */
import { createLoggingMailer } from "./logging";
import { createResendMailer } from "./resend";
import type { DeliveryOutcome, MailMessage, Mailer, MailTransport, MailTransportState } from "./types";

/** `dana@pachka.co.il` or `PACHKA <dana@pachka.co.il>`. A shape check, not a proof. */
const FROM_PATTERN = /^(?:[^<>]{1,64}<\s*[^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+\s*>|[^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+)$/;

export interface MailEnvironment {
  readonly RESEND_API_KEY?: string | undefined;
  readonly MAIL_FROM?: string | undefined;
}

export interface CreateMailerOptions {
  /** Defaults to `process.env`. Passed explicitly by tests. */
  readonly env?: MailEnvironment;
  /** Defaults to the global `fetch`. The one external boundary any test fakes. */
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: Pick<Console, "warn" | "info">;
}

/**
 * The transport this deployment should use.
 *
 * Pure with respect to its arguments — no module-level cache — so a test can
 * call it twice with two environments. `appMailer()` below is the cached one.
 */
export function createMailer(options: CreateMailerOptions = {}): MailTransport {
  const env = options.env ?? (process.env as MailEnvironment);
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.MAIL_FROM ?? "").trim();

  const logging = (reason: string): MailTransport =>
    createLoggingMailer(options.log === undefined ? { reason } : { reason, log: options.log });

  if (apiKey.length === 0 && from.length === 0) {
    return logging("RESEND_API_KEY and MAIL_FROM are unset.");
  }
  if (apiKey.length === 0) {
    return logging("MAIL_FROM is set but RESEND_API_KEY is unset.");
  }
  if (from.length === 0) {
    return logging("RESEND_API_KEY is set but MAIL_FROM is unset — a sender is mandatory.");
  }
  if (!FROM_PATTERN.test(from)) {
    // The value itself is not repeated: it is operator-supplied, but it is also
    // an address, and an address does not go in a log line.
    return logging("MAIL_FROM is not a valid address.");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return logging("No fetch implementation is available in this runtime.");
  }

  return createResendMailer({
    apiKey,
    from,
    // The narrow `FetchLike` this adapter declares is satisfied by the real
    // `fetch`; the cast is to the SUBSET, never the other way around.
    fetch: fetchImpl as unknown as Parameters<typeof createResendMailer>[0]["fetch"],
  });
}

let cached: MailTransport | undefined;

/**
 * The process-wide transport.
 *
 * Cached so the logging adapter's "not configured" warning is printed once and
 * its record of undelivered messages is one list rather than one per request.
 */
export function appMailer(): MailTransport {
  if (!cached) cached = createMailer();
  return cached;
}

/** Test seam, mirroring `resetEnvCache`: forget the selected transport. */
export function resetMailerCache(): void {
  cached = undefined;
}

/** What a health check reads. Never throws, and never builds a provider call. */
export function mailHealth(): MailTransportState {
  return appMailer().state();
}

/**
 * Send, and refuse to let the result matter.
 *
 * THIS FUNCTION IS THE RULE
 * -------------------------
 * Delivery must never break the operation that triggered it. `moderation`'s
 * spec states it outright — a report is still recorded when its notification
 * fails — and `orders` has more at stake: a checkout that has already reserved
 * a one-of-a-kind painting inside a committed transaction cannot be undone by a
 * mail server being down afterwards.
 *
 * Every wiring site calls this instead of `mailer.send`. The transport itself
 * still rejects, because a port that swallowed its own failures would leave a
 * caller who genuinely wants to know — a health probe, a retry — with no way to
 * find out.
 *
 * The failure is logged without the address and without the provider's prose,
 * for the reason `resend.ts` gives, and the returned `error` is short enough to
 * store in `reports.notification_error`.
 */
export async function deliverQuietly(
  mailer: Mailer,
  message: MailMessage,
  log: Pick<Console, "error"> = console,
): Promise<DeliveryOutcome> {
  try {
    await mailer.send(message);
    return { sent: true, error: null };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message.slice(0, 500) : "Unknown mail failure";
    log.error("[mail] delivery failed; the operation that triggered it is unaffected", {
      subject: message.subject,
      error,
    });
    return { sent: false, error };
  }
}
