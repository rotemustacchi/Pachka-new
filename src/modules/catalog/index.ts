/**
 * `catalog` — the public, browsable catalog and the artwork detail page.
 *
 * This file is the module's entire surface. ARCHITECTURE.md: nothing outside a
 * module may import a deeper path than its `index.ts`.
 *
 * CATALOG OWNS NO TABLES
 * ----------------------
 * There is no catalog migration and there is not meant to be one. Every fact on
 * these pages belongs to `artworks` or `accounts`; catalog is the read surface
 * that filters, sorts, paginates and renders them. A table here — a cached
 * facet count, a denormalised card row, a materialised view of published
 * artworks — would be a second answer to "what is published right now", and the
 * cost of that is a suspended artist's work staying visible because the copy
 * had not caught up.
 *
 * BROWSE IS A FIRST-CLASS SURFACE
 * ------------------------------
 * The homepage decision was full catalog browse alongside the matchmaker,
 * deliberately overriding the PRD's "no infinite feed". Browse is not the
 * fallback for buyers who would not answer the questionnaire. It is still
 * curated, but the curation happens at admission — an artwork is quality-gated
 * before it can be published — rather than by hiding the catalog from people.
 *
 * FILTER STATE LIVES IN THE URL AND NOWHERE ELSE
 * ----------------------------------------------
 * Not "is synchronised to the URL": lives there. No component in this module is
 * a Client Component, none holds filter state, and every control is a link to
 * another URL. That is what makes a filtered view shareable, reloadable,
 * back-button-safe and functional without JavaScript, and it is why there is no
 * way for the address bar and the grid to disagree. See `filters.ts`.
 *
 * FOR THE ROUTES THAT MOUNT THIS
 * ------------------------------
 * `src/app` supplies four things this module may not reach for itself, because
 * the dependency table lets catalog call `artworks` and `accounts` only:
 *
 *   • `renderImage` — `next/image` needs a loader for the storage bucket.
 *   • `returnTerms` — from `shipping.returnTerms(db)`. Its `ReturnTerms` is
 *     assignable to `CatalogReturnTerms` as it stands.
 *   • `shippingRange` — an estimate derived from `shipping`'s rate table.
 *   • `purchaseAction` — `orders` owns the cart. It is rendered only when the
 *     artwork is purchasable, and that check is inside the view, not in the
 *     route, so a route cannot forget it.
 */

// ---- The query, and its round trip through a URL. The shareable-view contract.
export {
  AXIS_DEFINITIONS,
  CATALOG_PATH,
  CATALOG_SORTS,
  DEFAULT_QUERY,
  DEFAULT_SORT,
  FILTER_AXES,
  FILTER_PARAMS,
  MAX_PRICE_PARAM,
  MIN_PRICE_PARAM,
  NO_FILTERS,
  PAGE_PARAM,
  SORT_LABELS,
  SORT_PARAM,
  activeFilterChips,
  activeFilterCount,
  catalogHref,
  clearAllFilters,
  clearFilter,
  clearPriceRange,
  hasActiveFilters,
  isCatalogSort,
  isFilterActive,
  parseCatalogQuery,
  priceRangeLabel,
  toSearchParams,
  toggleFilter,
  withPage,
  withSort,
  type ActiveFilterChip,
  type CatalogFilters,
  type CatalogQuery,
  type CatalogSearchParams,
  type CatalogSort,
  type FilterAxis,
  type IgnoredFilterValue,
  type ParsedCatalogQuery,
} from "./filters";

export {
  PRICE_BANDS,
  isPriceBandActive,
  withPriceBand,
  type PriceBand,
} from "./price-bands";

// ---- The reads. Every one a SELECT over another module's tables.
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  browseCatalog,
  countPublishedArtworks,
  findCatalogArtwork,
  type BrowseOptions,
  type CatalogArtworkDetail,
  type CatalogDeps,
  type CatalogEntry,
  type CatalogPage,
} from "./query";

// ---- The views. Server Components throughout: no `"use client"` in this
// module or below it, so no prop object reaches the RSC payload in the HTML.
export { CatalogView, defaultArtworkHref, resultCountLabel, type CatalogViewProps } from "./ui/CatalogView";
export {
  CatalogFilterPanel,
  filterToggleHref,
  type CatalogFilterPanelProps,
} from "./ui/CatalogFilterPanel";
export {
  BECOME_AN_ARTIST_PATH,
  CatalogNoResults,
  EmptyCatalogState,
  type CatalogEmptyStateProps,
  type CatalogNoResultsProps,
} from "./ui/CatalogEmptyStates";
export {
  ArtworkDetailView,
  shippingLine,
  type ArtworkDetailViewProps,
  type CatalogReturnTerms,
  type CatalogShippingRange,
} from "./ui/ArtworkDetailView";
