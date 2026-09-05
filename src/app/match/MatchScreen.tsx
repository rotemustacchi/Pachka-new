/**
 * /match — the questionnaire and its results, as one unit.
 *
 * THE FETCH AND THE RENDER ARE DELIBERATELY NOT SPLIT
 * --------------------------------------------------
 * `certificates.PublicVerificationPage` makes the same choice and states the
 * reason: if the route fetched and this only rendered what it was handed, the
 * decisions would live in `page.tsx` where no test can reach them, and a test
 * asserting that the no-matches state is honest would prove nothing about what
 * a visitor receives. So `page.tsx` supplies a database handle and a
 * fingerprint and nothing else, and the integration test renders THIS function
 * to markup.
 *
 * THE THREE STATES, AND WHY NONE OF THEM IS AN EDGE CASE
 * -----------------------------------------------------
 * PACHKA launches with zero artists. The sparse-catalog and no-matches states
 * are not month-four discoveries — they are what the first visitors literally
 * see, so they are the primary UI here and the five-good-matches case is the
 * unusual one.
 *
 * The honesty rules are the module's and are not re-decided here: the result
 * list is never padded to length, an artwork below the minimum score is never
 * in it, and when nothing clears the bar the answer says so plainly.
 * `MatchOutcome.message` carries the wording and `MatchResults` renders it as
 * `role="status"` rather than `alert`, because a young marketplace is a true
 * statement and not an error.
 *
 * The escape hatch is rendered in EVERY state, including a full result set. A
 * buyer who got five good matches and liked none of them needs the same three
 * doors — revise, browse the pre-filtered catalog, notify me — as a buyer who
 * got none.
 *
 * A REJECTED SUBMISSION COMES BACK AS FIELD MESSAGES, NOT A BANNER
 * ---------------------------------------------------------------
 * The contract requires a budget ceiling AND both wall dimensions: without a
 * continuous signal there is nothing to rank on, only tags to filter by, and
 * every artwork carrying the tags scores identically. `parseAnswers` rejects
 * with `AppError.fields` naming each missing field, and those are handed
 * straight to `QuestionnaireForm`, which renders each one beside its own field.
 *
 * Note that no validation happens here. `runMatchmaker` parses before it
 * consumes the rate limit and before it writes anything, so a rejected
 * submission costs the database nothing and leaves no `match_queries` row.
 */
import type { ReactNode } from "react";
import { ArtworkCard } from "@/modules/artworks";
import { findCatalogArtwork, type CatalogArtworkDetail, type CatalogDeps } from "@/modules/catalog";
import {
  MatchResults,
  NotifyMeForm,
  QuestionnaireForm,
  runMatchmaker,
  type Match,
  type MatchmakerSearchDeps,
} from "@/modules/matchmaker";
import { isAppError, type FieldErrors } from "@/shared/errors";
import { renderCardImage } from "@/app/_lib/images";
import {
  MATCH_PATH,
  answersFromParams,
  wasNotified,
  wasSubmitted,
  type RawAnswerBag,
} from "./answers";

/** Where the questionnaire posts, and where a notify-me address posts. */
export const SEARCH_ACTION = `${MATCH_PATH}/search`;
export const NOTIFY_ACTION = `${MATCH_PATH}/notify`;

export interface MatchScreenProps {
  readonly deps: MatchmakerSearchDeps;
  /** For hydrating the artwork ids the matchmaker returns. */
  readonly catalog: CatalogDeps;
  readonly params: URLSearchParams;
  /** Already hashed at the edge, so a raw IP never reaches the module. */
  readonly clientFingerprint: string;
  readonly viewerFingerprint: string;
}

function Shell({ children }: { readonly children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1100px] px-6 py-12 sm:px-12">{children}</div>;
}

/**
 * The questionnaire itself.
 *
 * `notice` carries the top-level message of a rejected submission — the field
 * messages are rendered by the form, beside their fields, which is where a
 * person filling in a form can act on them.
 */
function Questionnaire({
  fieldErrors,
  notice,
}: {
  readonly fieldErrors?: FieldErrors;
  readonly notice?: string;
}) {
  return (
    <Shell>
      <p className="caps text-caps mb-4 text-ink-muted">Your Personal Art Curator</p>
      <h1 className="mb-3 text-[40px] font-black leading-[1.06] tracking-[-.02em] text-ink">
        נמצא לכם יצירה
      </h1>
      <p className="mb-10 max-w-[52ch] text-[17px] font-light leading-[1.7] text-ink-soft">
        שש שאלות, פחות מדקה. נשתמש בתשובות כדי לדרג את יצירות הקהילה — לא כדי לחסום אותן.
      </p>

      {notice !== undefined ? (
        <p
          role="alert"
          className="mb-8 border border-rule bg-card px-5 py-4 text-[15px] leading-[1.7] text-ink"
        >
          {notice}
        </p>
      ) : null}

      <QuestionnaireForm action={SEARCH_ACTION} fieldErrors={fieldErrors} />
    </Shell>
  );
}

/**
 * Hydrate the ids the matchmaker returned.
 *
 * `runMatchmaker` returns artwork IDS and never artworks, so that shaping an
 * artwork for a buyer stays `artworks.toPublicArtwork`'s job and the matchmaker
 * has no way to leak a column by assembling its own view. This is the
 * hydration the module asks the route to perform, and it goes through
 * `catalog`, which already applies that shaping.
 *
 * A match whose artwork has become invisible between the ranking query and this
 * read — sold and reconciled, taken down, its artist suspended — is dropped
 * rather than rendered as a gap. It is the same not-found the artwork route
 * answers, and showing a placeholder card would be offering a buyer something
 * that cannot be sold to them.
 */
async function hydrate(
  catalog: CatalogDeps,
  matches: readonly Match[],
): Promise<ReadonlyMap<string, CatalogArtworkDetail>> {
  const found = new Map<string, CatalogArtworkDetail>();

  const details = await Promise.all(
    matches.map((match) =>
      findCatalogArtwork(catalog, match.artworkId).catch((error: unknown) => {
        if (isAppError(error) && error.kind === "not_found") return null;
        throw error;
      }),
    ),
  );

  for (const detail of details) {
    if (detail !== null) found.set(detail.artwork.id, detail);
  }
  return found;
}

export async function MatchScreen({
  deps,
  catalog,
  params,
  clientFingerprint,
  viewerFingerprint,
}: MatchScreenProps) {
  if (!wasSubmitted(params)) return <Questionnaire />;

  const answers: RawAnswerBag = answersFromParams(params);

  let outcome;
  try {
    outcome = await runMatchmaker(deps, { answers, clientFingerprint, viewerFingerprint });
  } catch (error) {
    // Not branched on kind beyond this: a form shows the message and the field
    // errors whatever the kind was. A rejected budget and a tripped rate limit
    // both leave the buyer on the questionnaire with an explanation, which is
    // the only place either is actionable.
    if (!isAppError(error)) throw error;
    return <Questionnaire fieldErrors={error.fields} notice={error.message} />;
  }

  const hydrated = await hydrate(catalog, outcome.matches);

  const renderMatch = (match: Match): ReactNode => {
    const detail = hydrated.get(match.artworkId);
    if (detail === undefined) return null;

    return (
      <a href={`/artworks/${detail.artwork.id}`} className="block">
        <ArtworkCard
          artwork={detail.artwork}
          artistName={detail.artist.displayName}
          renderImage={renderCardImage}
        />
      </a>
    );
  };

  return (
    <Shell>
      <p className="caps text-caps mb-4 text-ink-muted">Your Matches</p>
      <h1 className="mb-8 text-[34px] font-black tracking-[-0.015em] text-ink">ההתאמות שלכם</h1>

      <MatchResults
        matches={outcome.matches}
        message={outcome.message}
        noMatches={outcome.noMatches}
        catalogHref={outcome.escapeHatch.catalogHref}
        // Back to a blank questionnaire. `QuestionnaireForm` takes no initial
        // values, so it cannot be pre-filled with what was already answered;
        // reported upstream rather than worked around with a second form here.
        reviseHref={MATCH_PATH}
        notifyForm={
          <NotifyMeForm
            action={`${NOTIFY_ACTION}?${params.toString()}`}
            queryId={outcome.queryId}
            acknowledged={wasNotified(params)}
          />
        }
        renderMatch={renderMatch}
      />
    </Shell>
  );
}
