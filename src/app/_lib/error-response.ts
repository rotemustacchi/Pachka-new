/**
 * An `AppError` as an HTTP response, for the Route Handlers.
 *
 * `shared/errors` already owns the mapping — `httpStatusFor` turns each kind
 * into its status, and `rate_limited` is 429 rather than 409 precisely because
 * nothing about the request is wrong and the same request will succeed once the
 * window resets. That is what a client needs to be told, and a 409 does not
 * tell it. This function only carries that decision onto the wire; it does not
 * re-make it, and it branches on no kind of its own.
 *
 * WHY HTML AND NOT JSON
 * --------------------
 * These handlers exist to receive a browser form post. A person who trips the
 * matchmaker's anonymous rate limit is looking at a browser, and a page of JSON
 * tells them nothing. So the body is a minimal RTL document carrying the
 * error's own message — which is safe to show verbatim: `AppError` messages are
 * written for the caller, and anything that is not an `AppError` is flattened
 * by `toErrorBody` to a generic string, because an unexpected error may carry a
 * connection string or a row of somebody else's data (SECURITY.md S2-26).
 *
 * The status is what matters most here. A scripted flood against an anonymous
 * endpoint should meet a real 429, not a 303 to a friendly page that looks to a
 * script exactly like success.
 */
import { httpStatusFor, toErrorBody } from "@/shared/errors";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** The message is interpolated into markup, so it is escaped. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ESCAPES[character] ?? character);
}

export function errorResponse(error: unknown): Response {
  const status = httpStatusFor(error);
  const { error: body } = toErrorBody(error);

  return new Response(
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">` +
      `<title>${escapeHtml(body.message)}</title></head>` +
      `<body><main><p>${escapeHtml(body.message)}</p></main></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}
