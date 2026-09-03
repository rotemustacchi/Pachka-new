/**
 * The results view, and the two honest states it has to be able to be.
 *
 * art-matchmaker, "Honest behavior on a sparse catalog", is the requirement
 * this file is mostly about, and it is a requirement about a product decision
 * rather than about a layout: return fewer results rather than padding, never
 * show an artwork below the minimum score, and when nothing clears the bar, say
 * so and offer the catalog and a notify-me instead of five poor matches.
 *
 * PACHKA launches with no artists. The nearly-empty state is not an edge case
 * discovered in month four — it is what the first visitors literally see, and a
 * view that only looks right with five good matches in it is a view that has
 * never been correct in production.
 *
 * WHY THIS COMPONENT DOES NOT RENDER AN ARTWORK
 * --------------------------------------------
 * It takes a `renderMatch` and calls it. `artworks.toPublicArtwork` and
 * `accounts.toPublicArtist` are the only sanctioned shaping of an artwork and
 * an artist for a buyer (ARCHITECTURE.md), and `artworks.ArtworkCard` is the
 * approved card. If this component assembled its own view of an artwork it
 * would be a second place a column could leak from, so it assembles none.
 *
 * No `"use client"`, here or below: SECURITY.md S1-8.
 */
import { Badge } from "@/shared/ui";
import type { Match } from "../search";

export interface MatchResultsProps {
  readonly matches: readonly Match[];
  /** The plain message about a sparse catalog or no matches, or null. */
  readonly message: string | null;
  readonly noMatches: boolean;
  /** The pre-filtered catalog, from `MatchOutcome.escapeHatch`. */
  readonly catalogHref: string;
  /** Where re-answering starts again. Owned by `src/app`. */
  readonly reviseHref: string;
  /** The notify-me capture, rendered by the route that owns the action. */
  readonly notifyForm: React.ReactNode;
  /** Renders one artwork. Supplied by the route; see the header. */
  readonly renderMatch: (match: Match) => React.ReactNode;
}

/**
 * The escape hatch, rendered in every state.
 *
 * art-matchmaker: "Every matchmaker result view SHALL offer the buyer a way to
 * continue: revising their answers, opening the full filtered catalog, or
 * requesting notification." Every: so this is not conditional on there being no
 * matches. A buyer who got five good matches and liked none of them needs the
 * same three doors as a buyer who got none.
 */
function EscapeHatch({
  catalogHref,
  reviseHref,
  notifyForm,
}: Pick<MatchResultsProps, "catalogHref" | "reviseHref" | "notifyForm">) {
  return (
    <section aria-labelledby="matchmaker-continue" className="mt-12 border-t border-rule pt-8">
      <h2 id="matchmaker-continue" className="mb-4 text-[20px] font-black text-ink">
        לא בדיוק זה?
      </h2>
      <div className="mb-6 flex flex-wrap gap-3">
        <a
          href={reviseHref}
          className="inline-flex items-center justify-center rounded-button border border-ink px-6 py-3 text-[15px] font-bold text-ink hover:bg-ink hover:text-paper"
        >
          לשנות תשובות
        </a>
        <a
          href={catalogHref}
          className="inline-flex items-center justify-center rounded-button border border-ink px-6 py-3 text-[15px] font-bold text-ink hover:bg-ink hover:text-paper"
        >
          לכל הקטלוג
        </a>
      </div>
      {notifyForm}
    </section>
  );
}

export function MatchResults({
  matches,
  message,
  noMatches,
  catalogHref,
  reviseHref,
  notifyForm,
  renderMatch,
}: MatchResultsProps) {
  return (
    <div>
      {message !== null && (
        // `status`, not `alert`: this is a true statement about a young
        // marketplace, not an error, and a screen reader should not announce it
        // as one.
        <p
          role="status"
          className="mb-8 border border-rule bg-card px-5 py-4 text-[15px] font-light leading-[1.7] text-ink-soft"
        >
          {message}
        </p>
      )}

      {!noMatches && (
        <ul className="grid list-none grid-cols-1 gap-8 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {matches.map((match) => (
            <li key={match.artworkId} className="relative">
              {renderMatch(match)}
              {match.overBudgetLabel !== null && (
                // art-matchmaker: an over-budget piece is "visibly marked as
                // above budget with the amount by which it exceeds it". The
                // amount, not merely the fact — a buyer deciding whether to
                // stretch needs the number, and hiding it to keep the card tidy
                // is the kind of tidiness that costs someone money.
                //
                // `tag-selected` rather than a new variant: it is the approved
                // high-contrast chip in `shared/ui`, and a second treatment
                // invented here would be a second design system.
                <p className="mt-3">
                  <Badge variant="tag-selected">{match.overBudgetLabel}</Badge>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <EscapeHatch catalogHref={catalogHref} reviseHref={reviseHref} notifyForm={notifyForm} />
    </div>
  );
}
