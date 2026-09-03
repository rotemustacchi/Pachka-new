/**
 * The two empty states, which say opposite things.
 *
 * catalog-browse asks for both, and getting them the wrong way round is worse
 * than either being ugly:
 *
 *   EMPTY CATALOG — nothing is published at all. "Displays a message inviting
 *   artists to join, rather than an empty grid or an error." PACHKA launches
 *   with zero artists, so this is not an edge case discovered in month four; it
 *   is the first thing every early visitor sees, and it is the product's only
 *   chance to convert a curious visitor into the artist who fixes it. Offering
 *   that visitor a "clear your filters" link instead would be nonsense: they
 *   have no filters, and clearing nothing would show them the same page again.
 *
 *   NO RESULTS — the catalog has artworks; this combination has none. "States
 *   that nothing matched and offers to clear individual filters." Individually:
 *   a visitor who picked four things and got nothing needs to know which one to
 *   give up, and a single "clear everything" button throws away the three that
 *   were fine. Telling this visitor that PACHKA is waiting for its first artist
 *   would be a lie about a catalog they can see is full.
 *
 * Which one applies is decided in `query.ts` against the database, not guessed
 * from the length of an array.
 */
import { Badge } from "@/shared/ui";
import {
  CATALOG_PATH,
  activeFilterChips,
  catalogHref,
  clearAllFilters,
  type CatalogQuery,
} from "../filters";

/** Where a visitor who wants to sell becomes an artist. Owned by `src/app`. */
export const BECOME_AN_ARTIST_PATH = "/become-an-artist";

export interface CatalogEmptyStateProps {
  /** Rendered in place of the default call to action, when a route has its own. */
  readonly action?: React.ReactNode;
}

/**
 * Nothing is published yet.
 *
 * Deliberately not styled as an error. It is a true and temporary statement
 * about a marketplace on its first day, and the visitor reading it is the
 * person who can change it — so the page speaks to them rather than apologising
 * to a buyer.
 */
export function EmptyCatalogState({ action }: CatalogEmptyStateProps) {
  return (
    <section
      aria-labelledby="catalog-empty-heading"
      className="flex flex-col items-center border border-rule bg-card px-6 py-16 text-center"
    >
      <h2 id="catalog-empty-heading" className="mb-3 text-[26px] font-black text-ink">
        הקטלוג עוד מחכה ליצירה הראשונה
      </h2>
      <p className="mb-8 max-w-[46ch] text-[15px] font-light leading-[1.7] text-ink-soft">
        PACHKA רק נפתחת, ואף אמן עדיין לא פרסם כאן יצירה. אם את או אתה יוצרים בארץ — זה הרגע להיות
        הראשונים בקטלוג.
      </p>
      {action ?? (
        <a
          href={BECOME_AN_ARTIST_PATH}
          className="inline-flex items-center justify-center rounded-button bg-ink px-10 py-4 text-base font-bold text-paper hover:bg-ink-soft"
        >
          הצטרפות כאמן
        </a>
      )}
    </section>
  );
}

export interface CatalogNoResultsProps {
  readonly query: CatalogQuery;
  readonly basePath?: string;
}

/**
 * This filter combination matched nothing.
 *
 * Every active filter is rendered as a chip whose link is the same view without
 * that one filter — `activeFilterChips` builds those queries, so the "remove
 * this filter" link and the sidebar's own toggle produce identical URLs and
 * cannot drift into two ways of expressing one view.
 */
export function CatalogNoResults({ query, basePath = CATALOG_PATH }: CatalogNoResultsProps) {
  const chips = activeFilterChips(query);

  return (
    <section
      aria-labelledby="catalog-no-results-heading"
      className="border border-rule bg-card px-6 py-14 text-center"
    >
      <h2 id="catalog-no-results-heading" className="mb-3 text-[22px] font-black text-ink">
        לא נמצאו יצירות שמתאימות לסינון
      </h2>
      <p className="mb-7 text-[15px] font-light text-ink-soft">
        אפשר להסיר סינון אחד ולנסות שוב, בלי לוותר על השאר.
      </p>

      {chips.length > 0 ? (
        <ul className="mb-7 flex list-none flex-wrap justify-center gap-[7px] p-0">
          {chips.map((chip) => (
            <li key={chip.id}>
              <a
                href={catalogHref(chip.clearedQuery, basePath)}
                aria-label={`הסרת הסינון ${chip.label}`}
              >
                <Badge variant="tag">
                  {chip.label}
                  <span aria-hidden="true" className="ms-2 text-ink-muted">
                    ✕
                  </span>
                </Badge>
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <a
        href={catalogHref(clearAllFilters(query), basePath)}
        className="inline-flex items-center justify-center border-[1.5px] border-ink px-8 py-[14px] text-[15px] font-bold text-ink hover:bg-paper-deep"
      >
        ניקוי כל הסינון
      </a>
    </section>
  );
}
