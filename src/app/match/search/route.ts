/**
 * POST /match/search — the questionnaire's form target.
 *
 * `QuestionnaireForm` renders `<form method="post">` with a string action, so
 * the browser performs a native POST, and the App Router serves POST from a
 * Route Handler. A segment cannot hold both a `page.tsx` and a `route.ts`, so
 * the form posts here and this redirects to `/match` with the answers in the
 * query string.
 *
 * THIS HANDLER DECIDES NOTHING
 * ----------------------------
 * It transcodes a `FormData` into a `URLSearchParams` and issues a 303. It does
 * not validate an answer, does not touch the database, does not consume a rate
 * limit and does not know what any field means. All of that belongs to
 * `parseAnswers` and `runMatchmaker`, which run on the page — the one place a
 * field-level rejection can be rendered beside its field.
 *
 * 303 rather than 302: it changes the browser's method to GET, which is what
 * makes the results page reloadable without re-posting the form.
 *
 * There is no GET here on purpose. A visitor who lands on `/match/search`
 * directly gets Next's 405, and the questionnaire lives at `/match`.
 */
import { NextResponse } from "next/server";
import { matchHref, paramsFromForm } from "../answers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  return NextResponse.redirect(new URL(matchHref(paramsFromForm(form)), request.url), 303);
}
