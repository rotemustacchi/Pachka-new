/**
 * The real provider: Resend, over plain `fetch`.
 *
 * WHY THERE IS NO SDK IN package.json
 * -----------------------------------
 * The whole argument for a port is that the thing behind it is small. Sending
 * one transactional email is a single POST with a bearer token and a JSON body;
 * an SDK for that adds a dependency to audit, a version to keep current, and a
 * second place for the `From` address to come from. It also drags a bundle into
 * a Vercel function whose cold start PACHKA pays for on every checkout. So:
 * `fetch`, which the runtime already has.
 *
 * The endpoint and `fetch` are both injected. That is not indirection for its
 * own sake — it is the only way the tests can exercise this adapter at all,
 * because the one rule they may not break is that no test reaches the network.
 * `fetch` is the genuine external boundary here, and it is the only thing any
 * mail test fakes.
 *
 * WHAT A FAILURE IS ALLOWED TO SAY
 * --------------------------------
 * Nothing the provider wrote. Resend's error bodies quote the offending field
 * back — "Invalid `to` field: someone@example.com" — and `moderation` stores a
 * notification failure in `reports.notification_error`, a database column.
 * Passing the provider's prose through would put a recipient address in a table
 * and in the server log, both of which SECURITY.md's redaction list forbids. So
 * a rejection carries the HTTP status and Resend's own machine-readable `name`
 * (`validation_error`, `rate_limit_exceeded`, ...), which are enums and cannot
 * contain an address.
 *
 * A 429 is `rate_limited` and everything else is `external_failure`, matching
 * the split `uploads/ports.ts` already established for its providers: one is
 * worth retrying, the other is an outage.
 */
import { AppError } from "@/shared/errors";
import { hebrewHtmlBody } from "./body";
import type { MailMessage, MailTransport, MailTransportState } from "./types";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** The subset of `fetch` this adapter uses. Narrow, so a fake is small. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface ResendMailerOptions {
  readonly apiKey: string;
  /** The fixed platform sender. SECURITY.md S2-21 item 5: never user-supplied. */
  readonly from: string;
  /** Injected so tests can drive this adapter without a network. */
  readonly fetch: FetchLike;
  readonly endpoint?: string;
  /** A hung provider must not hold a checkout open. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Resend's error envelope. Only `name` is ever read — see the header. */
function providerErrorName(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const name = (parsed as { name?: unknown } | null)?.name;
    return typeof name === "string" && /^[a-z_]{1,64}$/.test(name) ? name : "unknown_error";
  } catch {
    return "unparseable_error";
  }
}

export function createResendMailer(options: ResendMailerOptions): MailTransport {
  const endpoint = options.endpoint ?? RESEND_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const state: MailTransportState = {
    kind: "resend",
    configured: true,
    from: options.from,
    reason: null,
  };

  return {
    state: () => state,

    async send(message: MailMessage): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await options.fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.body,
            html: message.html ?? hebrewHtmlBody(message.body),
          }),
          signal: controller.signal,
        });
      } catch (cause) {
        // A network refusal, a DNS failure, or our own abort. None of them can
        // be told apart usefully here, and none may quote the address.
        throw AppError.externalFailure("Mail provider is unreachable.", {
          code: "mail.provider_unreachable",
          details: { provider: "resend" },
          cause,
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return;

      const name = providerErrorName(await response.text().catch(() => ""));

      if (response.status === 429) {
        throw AppError.rateLimited("Mail provider refused: rate limited.", {
          code: "mail.provider_rate_limited",
          details: { provider: "resend", status: 429, providerError: name },
        });
      }

      throw AppError.externalFailure(`Mail provider refused (${response.status}: ${name}).`, {
        code: "mail.provider_refused",
        details: { provider: "resend", status: response.status, providerError: name },
      });
    },
  };
}
