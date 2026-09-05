/**
 * The questionnaire's answers, in the URL.
 *
 * WHY THE ANSWERS LIVE IN THE URL AT ALL
 * --------------------------------------
 * `matchmaker.QuestionnaireForm` is a Server Component that renders
 * `<form method="post">` with a string action — so the browser performs a
 * native POST. The App Router serves POST from a Route Handler, and a segment
 * cannot hold both a `page.tsx` and a `route.ts`. So the submission lands at
 * `/match/search`, which transcodes the form into a query string and redirects
 * to `/match`, where the page runs the questionnaire and renders the results.
 *
 * That is the standard POST-redirect-GET, and it buys the same property
 * `catalog` insists on for filters: the results view is reloadable, shareable
 * and back-button-safe, and a refresh does not re-post. `/match/search` holds
 * no logic — it validates nothing and decides nothing — because every answer is
 * validated by `parseAnswers` on the page, which is where a field-level error
 * can actually be rendered next to its field.
 *
 * NOTHING HERE VALIDATES ANYTHING
 * -------------------------------
 * This file only moves values between a `FormData`, a `URLSearchParams` and the
 * `RawAnswers` bag whose every field is `unknown` by design. `parseAnswers`
 * owns the closed sets, the budget rule and the wall-dimension rule, and it
 * rejects rather than drops — a dropped answer produces a ranking the buyer did
 * not ask for with nothing telling them so. Re-checking a value here would be a
 * second copy of a closed set that could fall out of step with `artworks`'
 * taxonomy.
 */

/** The single-valued questions. */
const SINGLE = ["medium", "palette", "budgetMin", "budgetMax", "wallHeight", "wallWidth"] as const;

/** The multi-valued ones. `parseAnswers` caps how many may be chosen. */
const MULTI = ["styles", "targetSpaces", "moods"] as const;

/**
 * The marker that says a questionnaire was submitted.
 *
 * Presence of this — rather than of `budgetMax` — is what tells `/match` to
 * show results instead of the empty form. The difference matters for the one
 * case that has to work: a submission with the budget left blank must reach
 * `parseAnswers`, be rejected, and come back as a message beside the budget
 * field. Keying off `budgetMax` would silently show the blank form again and
 * the buyer would never learn why.
 */
export const SUBMITTED_PARAM = "submitted";

/** Set after a notify-me capture, so the results page can acknowledge it. */
export const NOTIFIED_PARAM = "notified";

export type RawAnswerBag = Readonly<Record<string, unknown>>;

function firstOf(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  return value === null ? undefined : value;
}

/** Was a questionnaire submitted, or is this a first visit? */
export function wasSubmitted(params: URLSearchParams): boolean {
  return params.get(SUBMITTED_PARAM) === "1";
}

export function wasNotified(params: URLSearchParams): boolean {
  return params.get(NOTIFIED_PARAM) === "1";
}

/**
 * The URL's answers, as the shape `runMatchmaker` takes.
 *
 * Absent single values are omitted rather than sent as `""`, so
 * `parseOptionalOne` sees `undefined`. An empty multi-value list is sent as an
 * empty array, which is what "the axis was on the page and nothing was chosen"
 * means.
 */
export function answersFromParams(params: URLSearchParams): RawAnswerBag {
  const answers: Record<string, unknown> = {};

  for (const name of SINGLE) {
    const value = firstOf(params, name);
    if (value !== undefined) answers[name] = value;
  }
  for (const name of MULTI) {
    answers[name] = params.getAll(name);
  }
  return answers;
}

/**
 * A posted form, as a query string.
 *
 * Blank single fields are dropped so a URL carries only what was actually
 * answered — except that `budgetMax` is kept even when blank, because the
 * page's job on a blank budget is to say so, and a dropped field is
 * indistinguishable from a field that was never on the form.
 */
export function paramsFromForm(form: FormData): URLSearchParams {
  const params = new URLSearchParams();
  params.set(SUBMITTED_PARAM, "1");

  for (const name of SINGLE) {
    const value = form.get(name);
    if (typeof value !== "string") continue;
    if (value.trim() === "" && name !== "budgetMax") continue;
    params.set(name, value.trim());
  }

  for (const name of MULTI) {
    for (const value of form.getAll(name)) {
      if (typeof value === "string" && value !== "") params.append(name, value);
    }
  }

  return params;
}

/** Where the results for these answers live. */
export const MATCH_PATH = "/match";

export function matchHref(params: URLSearchParams): string {
  const query = params.toString();
  return query === "" ? MATCH_PATH : `${MATCH_PATH}?${query}`;
}

/**
 * The same answers, with the notify-me acknowledgement flag set.
 *
 * The notify handler redirects here rather than to a bare `/match`, so a buyer
 * who leaves an address lands back on the results they were reading with the
 * acknowledgement in place — not on an empty questionnaire that has forgotten
 * everything they told it.
 */
export function acknowledgedHref(params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.set(NOTIFIED_PARAM, "1");
  return matchHref(next);
}
