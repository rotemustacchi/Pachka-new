/**
 * POST /match/notify — the notify-me capture.
 *
 * The one thing that must not leak here is whether the address was already
 * stored. `captureNotifyRequest` returns the same `{ acknowledged: true }`
 * whatever the truth is, and `NOTIFY_ACKNOWLEDGEMENT` is a constant phrased
 * conditionally, so there is no answer for this handler to vary. It therefore
 * redirects to exactly one place on success — the results the buyer was already
 * reading, with the acknowledgement flag set — and never to a different place
 * for a new address than for a known one.
 *
 * The answers travel in this route's own query string so the redirect lands
 * back on the same results rather than on an empty questionnaire that has
 * forgotten everything the buyer said.
 *
 * WHY A REFUSAL IS A STATUS AND NOT A PRETTY PAGE
 * ----------------------------------------------
 * `consumeNotifyRateLimit` limits by client AND by hashed address, because this
 * is an anonymous write surface. A script that trips it should meet a real 429
 * — which is what `rate_limited` means and what `httpStatusFor` returns — and
 * not a 303 to a friendly page that looks to a script exactly like success.
 * `errorResponse` carries the message through, so a person sees the module's
 * own Hebrew wording with the right status behind it.
 *
 * The raw address is hashed by the module before it is stored, and the client
 * IP is hashed here at the edge, so neither reaches a table in the clear.
 */
import { NextResponse } from "next/server";
import { captureNotifyRequest, depsWithoutMail, hashSubject } from "@/modules/matchmaker";
import { getDatabase } from "@/shared/db";
import { errorResponse } from "@/app/_lib/error-response";
import { clientIp } from "@/app/_lib/request";
import { acknowledgedHref } from "../answers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const queryId = form.get("matchQueryId") ?? form.get("queryId");

  try {
    await captureNotifyRequest(depsWithoutMail(getDatabase()), {
      email: form.get("email"),
      matchQueryId: typeof queryId === "string" && queryId !== "" ? queryId : null,
      clientFingerprint: hashSubject(await clientIp()),
    });
  } catch (error) {
    return errorResponse(error);
  }

  const answers = new URL(request.url).searchParams;
  return NextResponse.redirect(new URL(acknowledgedHref(answers), request.url), 303);
}
