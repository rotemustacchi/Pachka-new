/**
 * The catalog page — design/Catalog.dc.html.
 *
 * A Server Component with no `"use client"` in it or below it, so nothing here
 * is serialised into the RSC flight payload embedded in the HTML
 * (SECURITY.md S1-8). It is also pure and synchronous: `browseCatalog` does the
 * fetching and this renders what it returned, which is what lets the whole view
 * — including both empty states and the shared-URL behaviour — be tested
 * without a database.
 *
 * Layout is the design's: a 250px filter rail beside the grid, a heading with
 * the result count and the active filters spelled out, a sort control, and a
 * three-column card grid.
 */
import type { ReactNode } from "react";
import { ArtworkCard } from "@/modules/artworks";
import {
  CATALOG_PATH,
  SORT_LABELS,
  CATALOG_SORTS,
  activeFilterChips,
  catalogHref,
  withPage,
  withSort,
  type CatalogQuery,
  type IgnoredFilterValue,
} from "../filters";
import type { CatalogEntry, CatalogPage } from "../query";
import { CatalogFilterPanel } from "./CatalogFilterPanel";
import { CatalogNoResults, EmptyCatalogState } from "./CatalogEmptyStates";

export interface CatalogViewProps {
  readonly page: CatalogPage;
  /**
   * How to render a card's image, threaded through to `artworks.ArtworkCard`.
   *
   * Required and injected for the reason that module gives: `next/image` needs
   * a loader configured for the Supabase Storage bucket, which is the app's
   * decision. Catalog passes it along rather than deciding it here.
   */
  readonly renderImage: (image: { src: string; alt: string }) => ReactNode;
  /** Where an artwork card links. The route lives in `src/app`. */
  readonly artworkHref?: (entry: CatalogEntry) => string;
  readonly basePath?: string;
  /**
   * Filter values in the URL this deployment could not apply.
   *
   * Surfaced rather than swallowed: an ignored filter WIDENS the results, so a
   * visitor who is not told is looking at more than the link they followed
   * promised. See the header of `filters.ts`.
   */
  readonly ignored?: readonly IgnoredFilterValue[];
}

export const defaultArtworkHref = (entry: CatalogEntry): string => `/artworks/${entry.artwork.id}`;

/** "24 יצירות" / "יצירה אחת" / "אין יצירות". */
export function resultCountLabel(total: number): string {
  if (total === 0) return "אין יצירות";
  if (total === 1) return "יצירה אחת";
  return `${total.toString()} יצירות`;
}

function SortControl({
  query,
  basePath,
}: {
  readonly query: CatalogQuery;
  readonly basePath: string;
}) {
  return (
    <nav aria-label="מיון" className="flex items-center gap-[10px] text-sm">
      <span className="text-ink-muted">מיון:</span>
      <ul className="flex list-none items-center gap-4 border border-rule bg-card px-4 py-[9px] p-0">
        {CATALOG_SORTS.map((sort) => {
          const active = query.sort === sort;
          return (
            <li key={sort}>
              <a
                href={catalogHref(withSort(query, sort), basePath)}
                aria-current={active ? "true" : undefined}
                className={active ? "font-medium text-ink" : "font-light text-ink-muted hover:text-ink"}
              >
                {SORT_LABELS[sort]}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Previous and next, as links.
 *
 * No page-number list. With a finite, curated catalog the useful navigation is
 * "more of this" and "back", and a numbered list on a two-page catalog is
 * chrome that has to be kept correct for no benefit. The page number is still
 * in the URL, so a specific page remains linkable.
 */
function Pagination({
  page,
  basePath,
}: {
  readonly page: CatalogPage;
  readonly basePath: string;
}) {
  if (page.pageCount <= 1) return null;

  const hasPrevious = page.page > 1;
  const hasNext = page.page < page.pageCount;

  return (
    <nav aria-label="ניווט בין עמודי הקטלוג" className="mt-10 flex items-center justify-between">
      {hasPrevious ? (
        <a
          href={catalogHref(withPage(page.query, page.page - 1), basePath)}
          rel="prev"
          className="border-[1.5px] border-ink px-6 py-3 text-sm font-bold text-ink hover:bg-paper-deep"
        >
          העמוד הקודם
        </a>
      ) : (
        <span />
      )}

      <span className="text-sm text-ink-muted">
        עמוד {page.page} מתוך {page.pageCount}
      </span>

      {hasNext ? (
        <a
          href={catalogHref(withPage(page.query, page.page + 1), basePath)}
          rel="next"
          className="border-[1.5px] border-ink px-6 py-3 text-sm font-bold text-ink hover:bg-paper-deep"
        >
          העמוד הבא
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}

function IgnoredNotice({ ignored }: { readonly ignored: readonly IgnoredFilterValue[] }) {
  if (ignored.length === 0) return null;

  return (
    <p role="status" className="mb-5 border border-rule bg-card px-4 py-3 text-sm text-ink-soft">
      חלק מהסינון בקישור הזה אינו מוכר ולא הוחל:{" "}
      {ignored.map((entry) => `${entry.param}=${entry.value}`).join(", ")}. התוצאות רחבות יותר ממה
      שהקישור ביקש.
    </p>
  );
}

export function CatalogView({
  page,
  renderImage,
  artworkHref = defaultArtworkHref,
  basePath = CATALOG_PATH,
  ignored = [],
}: CatalogViewProps) {
  const chips = activeFilterChips(page.query);

  // The empty catalog replaces the whole page, filter rail included. There is
  // nothing to filter, and a sidebar of controls that all lead back to the same
  // message is worse than no sidebar.
  if (page.catalogIsEmpty) {
    return (
      <div className="px-12 py-10">
        <h1 className="mb-8 text-[34px] font-black tracking-[-0.015em] text-ink">הקטלוג</h1>
        <EmptyCatalogState />
      </div>
    );
  }

  return (
    <div className="grid gap-11 px-12 pb-[70px] pt-10 lg:grid-cols-[250px_1fr]">
      <CatalogFilterPanel query={page.query} basePath={basePath} />

      <main>
        <div className="mb-[26px] flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="mb-[6px] text-[34px] font-black tracking-[-0.015em] text-ink">הקטלוג</h1>
            <p className="text-sm text-ink-muted">
              {[resultCountLabel(page.total), ...chips.map((chip) => chip.label)].join(" · ")}
            </p>
          </div>
          <SortControl query={page.query} basePath={basePath} />
        </div>

        <IgnoredNotice ignored={ignored} />

        {page.entries.length === 0 ? (
          <CatalogNoResults query={page.query} basePath={basePath} />
        ) : (
          <>
            <ul className="grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-2 lg:grid-cols-3">
              {page.entries.map((entry) => (
                <li key={entry.artwork.id}>
                  <a href={artworkHref(entry)} className="block">
                    <ArtworkCard
                      artwork={entry.artwork}
                      artistName={entry.artist.displayName}
                      renderImage={renderImage}
                    />
                  </a>
                </li>
              ))}
            </ul>
            <Pagination page={page} basePath={basePath} />
          </>
        )}
      </main>
    </div>
  );
}
