/**
 * The catalog query, and its round trip through a URL.
 *
 * catalog-browse, "Filtering and sorting": "Active filters SHALL be reflected
 * in the URL so that a filtered view can be shared and reloaded." This file is
 * where that requirement is actually met, and it is met by making the URL the
 * ONLY place a filter lives. There is no client-side filter state anywhere in
 * this module: every control in `ui/` is a link to another URL, the page
 * component parses that URL into a `CatalogQuery`, and the query drives the
 * SQL. A filtered view therefore survives reload, sharing, the back button and
 * a browser with JavaScript disabled, because there is no state to lose.
 *
 * The alternative -- client state that pushes to the URL as a side effect --
 * has two sources of truth that agree until one of them does not, and the
 * failure mode is a shared link that shows the sender something different from
 * what the recipient sees. That is precisely the scenario the spec asks for a
 * test of.
 *
 * WHY PARSING DROPS AN UNKNOWN VALUE INSTEAD OF REJECTING IT
 * ---------------------------------------------------------
 * `artworks.parseTaxonomyValue` rejects a value outside the closed set, loudly,
 * and is right to: it guards an artist's submission, where a silently dropped
 * style means an artwork classified differently from what its author chose.
 *
 * A catalog URL is a different input with a different failure. It is typed by
 * hand, pasted from a chat message, bookmarked for a year, and produced by a
 * previous deployment whose taxonomy had a value this one has retired. Turning
 * any of those into an error page serves nobody: the visitor wanted the
 * catalog, and the catalog exists. So an unrecognised value is dropped and
 * REPORTED -- `ParsedCatalogQuery.ignored` carries every one -- and the view
 * says which filters it could not apply rather than pretending they were never
 * asked for. Dropping without reporting would be the actual defect, because a
 * dropped filter WIDENS the result set: the visitor sees more than they asked
 * for and has no way to tell.
 *
 * PRICES ARE WHOLE SHEKELS IN THE URL
 * -----------------------------------
 * `?min=200&max=2000`, matching how the approved design labels the range
 * (design/Catalog.dc.html: "₪ 200" / "₪ 2,000") and how a person would type it.
 * They become agorot the moment they are parsed, and everything downstream of
 * this file is integer agorot per ARCHITECTURE.md. The URL is a display
 * surface; the domain is not.
 */
import { formatAgorotCompact, nonNegativeAgorot, type Agorot } from "@/shared/money";
import {
  AXIS_LABELS,
  MEDIA,
  MEDIUM_LABELS,
  MOODS,
  MOOD_LABELS,
  STYLES,
  STYLE_LABELS,
  TARGET_SPACES,
  TARGET_SPACE_LABELS,
  isMedium,
  isMood,
  isStyle,
  isTargetSpace,
  type Medium,
  type Mood,
  type Style,
  type TargetSpace,
} from "@/modules/artworks";

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * catalog-browse: "sorting by newest and by price ascending or descending".
 * Exactly three, and a closed set, because the sort key reaches an `order by`
 * clause -- see `ORDER_BY` in ./query.ts, where the mapping from one of these
 * to SQL is a lookup in a frozen record and never string interpolation.
 */
export const CATALOG_SORTS = ["newest", "price_asc", "price_desc"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export const DEFAULT_SORT: CatalogSort = "newest";

/** design/Catalog.dc.html shows "החדשים ביותר" as the default sort's label. */
export const SORT_LABELS: Readonly<Record<CatalogSort, string>> = {
  newest: "החדשים ביותר",
  price_asc: "מחיר: מהנמוך לגבוה",
  price_desc: "מחיר: מהגבוה לנמוך",
};

export function isCatalogSort(value: unknown): value is CatalogSort {
  return typeof value === "string" && (CATALOG_SORTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The filters
// ---------------------------------------------------------------------------

/**
 * A multi-select axis is OR within itself and AND across axes.
 *
 * "medium ceramics AND mood calm" is the spec's combined-filter scenario, and
 * "medium ceramics OR medium jewelry" is what a visitor means by ticking two
 * boxes in one group. Anything else makes a second tick in one group return
 * fewer results than the first, which reads as broken.
 */
export interface CatalogFilters {
  readonly media: readonly Medium[];
  readonly styles: readonly Style[];
  readonly targetSpaces: readonly TargetSpace[];
  readonly moods: readonly Mood[];
  /** Inclusive lower bound, in agorot. */
  readonly minPriceAgorot: Agorot | null;
  /** Inclusive upper bound, in agorot. */
  readonly maxPriceAgorot: Agorot | null;
}

export const NO_FILTERS: CatalogFilters = {
  media: [],
  styles: [],
  targetSpaces: [],
  moods: [],
  minPriceAgorot: null,
  maxPriceAgorot: null,
};

export interface CatalogQuery {
  readonly filters: CatalogFilters;
  readonly sort: CatalogSort;
  /** 1-based, as it appears in the URL. */
  readonly page: number;
}

export const DEFAULT_QUERY: CatalogQuery = {
  filters: NO_FILTERS,
  sort: DEFAULT_SORT,
  page: 1,
};

/**
 * The taxonomy axes a visitor can filter on, keyed by the URL parameter.
 *
 * Short parameter names, because these are what a shared link looks like and
 * `?space=living_room` reads better than `?targetSpaces=living_room`. They are
 * a public contract from the first shared link onwards: renaming one breaks
 * every bookmark, so they are stated once, here.
 */
export const FILTER_PARAMS = {
  medium: "medium",
  style: "style",
  space: "space",
  mood: "mood",
} as const;

export const SORT_PARAM = "sort";
export const PAGE_PARAM = "page";
export const MIN_PRICE_PARAM = "min";
export const MAX_PRICE_PARAM = "max";

/** The four taxonomy axes as this module addresses them. */
export const FILTER_AXES = ["media", "styles", "targetSpaces", "moods"] as const;
export type FilterAxis = (typeof FILTER_AXES)[number];

interface AxisDefinition {
  readonly param: string;
  /** The closed set, in declared order — which is also the canonical URL order. */
  readonly values: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  /** The group heading, from the artworks taxonomy so the two surfaces agree. */
  readonly heading: string;
  readonly accepts: (value: unknown) => boolean;
}

export const AXIS_DEFINITIONS: Readonly<Record<FilterAxis, AxisDefinition>> = {
  media: {
    param: FILTER_PARAMS.medium,
    values: MEDIA,
    labels: MEDIUM_LABELS,
    heading: AXIS_LABELS.medium,
    accepts: isMedium,
  },
  styles: {
    param: FILTER_PARAMS.style,
    values: STYLES,
    labels: STYLE_LABELS,
    heading: AXIS_LABELS.styles,
    accepts: isStyle,
  },
  targetSpaces: {
    param: FILTER_PARAMS.space,
    values: TARGET_SPACES,
    labels: TARGET_SPACE_LABELS,
    heading: AXIS_LABELS.target_spaces,
    accepts: isTargetSpace,
  },
  moods: {
    param: FILTER_PARAMS.mood,
    values: MOODS,
    labels: MOOD_LABELS,
    heading: AXIS_LABELS.moods,
    accepts: isMood,
  },
};

// ---------------------------------------------------------------------------
// Parsing a URL
// ---------------------------------------------------------------------------

/**
 * What Next.js hands a page as `searchParams`, or a plain `URLSearchParams`.
 *
 * Both are accepted because the page component receives the former and every
 * test, link builder and round-trip assertion works with the latter, and
 * converting at each call site is how the two drift.
 */
export type CatalogSearchParams =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** A parameter value that was present but not understood, and was therefore not applied. */
export interface IgnoredFilterValue {
  readonly param: string;
  readonly value: string;
}

export interface ParsedCatalogQuery {
  readonly query: CatalogQuery;
  /**
   * Every value the URL asked for that this deployment could not apply.
   *
   * Non-empty means the visitor is seeing a WIDER result set than the link they
   * followed described, so the view tells them. See the file header.
   */
  readonly ignored: readonly IgnoredFilterValue[];
}

function valuesOf(params: CatalogSearchParams, name: string): readonly string[] {
  if (params instanceof URLSearchParams) return params.getAll(name);

  const raw = (params as Record<string, string | readonly string[] | undefined>)[name];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw as readonly string[];
  return [raw as string];
}

function firstOf(params: CatalogSearchParams, name: string): string | undefined {
  return valuesOf(params, name)[0];
}

/**
 * Whole shekels from the URL into agorot.
 *
 * Rejects anything that is not a non-negative whole number of shekels by
 * reporting it as ignored rather than by throwing, for the same reason the
 * taxonomy values are dropped: a malformed price in a pasted link must not
 * replace the catalog with an error page.
 *
 * A range whose lower bound is above its upper bound is passed through EXACTLY
 * AS GIVEN rather than swapped or dropped. It matches nothing, which is a state
 * this module already handles well -- the no-results view names the price
 * filter and offers to clear it. Swapping would silently answer a different
 * question than the one asked, and dropping would widen the results, which is
 * the failure this file is most careful about everywhere else.
 */
function parsePriceShekels(
  params: CatalogSearchParams,
  param: string,
  ignored: IgnoredFilterValue[],
): Agorot | null {
  const raw = firstOf(params, param);
  if (raw === undefined || raw.trim() === "") return null;

  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) {
    ignored.push({ param, value: raw });
    return null;
  }

  return nonNegativeAgorot(Number(trimmed) * 100);
}

/**
 * Normalise a list of values for one axis: drop what this deployment does not
 * recognise, collapse duplicates, and order by the taxonomy's declared order.
 *
 * The ordering is what makes a URL canonical. Two visitors who tick the same
 * two styles in opposite orders must produce the same link, or "share this
 * view" produces two strings for one view and no cache, log or test can treat
 * them as equal. `artworks.parseTaxonomyList` normalises the same way and for a
 * related reason.
 */
function parseAxis(
  params: CatalogSearchParams,
  axis: FilterAxis,
  ignored: IgnoredFilterValue[],
): readonly string[] {
  const definition = AXIS_DEFINITIONS[axis];
  const accepted = new Set<string>();

  // A value may arrive either as repeated parameters (?style=a&style=b) or
  // comma-separated (?style=a,b). Both are produced by hand-edited links and
  // both are cheap to accept; only the first is ever GENERATED, so the URL this
  // module emits stays canonical.
  for (const raw of valuesOf(params, definition.param)) {
    for (const piece of raw.split(",")) {
      const value = piece.trim();
      if (value === "") continue;
      if (definition.accepts(value)) accepted.add(value);
      else ignored.push({ param: definition.param, value });
    }
  }

  return definition.values.filter((value) => accepted.has(value));
}

export function parseCatalogQuery(params: CatalogSearchParams): ParsedCatalogQuery {
  const ignored: IgnoredFilterValue[] = [];

  const filters: CatalogFilters = {
    media: parseAxis(params, "media", ignored) as readonly Medium[],
    styles: parseAxis(params, "styles", ignored) as readonly Style[],
    targetSpaces: parseAxis(params, "targetSpaces", ignored) as readonly TargetSpace[],
    moods: parseAxis(params, "moods", ignored) as readonly Mood[],
    minPriceAgorot: parsePriceShekels(params, MIN_PRICE_PARAM, ignored),
    maxPriceAgorot: parsePriceShekels(params, MAX_PRICE_PARAM, ignored),
  };

  const rawSort = firstOf(params, SORT_PARAM);
  let sort: CatalogSort = DEFAULT_SORT;
  if (rawSort !== undefined && rawSort !== "") {
    if (isCatalogSort(rawSort)) sort = rawSort;
    else ignored.push({ param: SORT_PARAM, value: rawSort });
  }

  const rawPage = firstOf(params, PAGE_PARAM);
  let page = 1;
  if (rawPage !== undefined && rawPage !== "") {
    // A page number out of range is clamped to 1 rather than reported: unlike a
    // filter, it changes which slice is shown and not which artworks qualify,
    // so there is nothing to warn a visitor about. Past the last page the query
    // returns nothing and the view offers the first page back.
    const parsed = /^\d{1,6}$/.test(rawPage.trim()) ? Number(rawPage.trim()) : 1;
    page = parsed >= 1 ? parsed : 1;
  }

  return { query: { filters, sort, page }, ignored };
}

// ---------------------------------------------------------------------------
// Building a URL
// ---------------------------------------------------------------------------

/**
 * The canonical search params for a query.
 *
 * Defaults are omitted, so the unfiltered catalog is `/catalog` and not
 * `/catalog?sort=newest&page=1`. Everything else appears in a fixed order,
 * which -- together with the declared-order normalisation in `parseAxis` --
 * makes `toSearchParams` a canonical form: two queries that mean the same thing
 * serialise to the same string, and `parseCatalogQuery(toSearchParams(q))`
 * returns `q`. `filters.test.ts` asserts that round trip on every axis, because
 * it is the property the spec's "filtered view is shareable" scenario rests on.
 */
export function toSearchParams(query: CatalogQuery): URLSearchParams {
  const params = new URLSearchParams();

  for (const axis of FILTER_AXES) {
    const definition = AXIS_DEFINITIONS[axis];
    const chosen = query.filters[axis] as readonly string[];
    // Emitted in the taxonomy's declared order rather than in the order the
    // query object happens to hold them. `toggleFilter` already keeps that
    // order, so this changes nothing for a query built through this module --
    // it makes the canonical form a property of SERIALISATION instead of a
    // property of how the query was assembled, so a hand-built query object
    // cannot produce a second URL for a view that already has one.
    for (const value of definition.values) {
      if (chosen.includes(value)) params.append(definition.param, value);
    }
  }

  if (query.filters.minPriceAgorot !== null) {
    params.set(MIN_PRICE_PARAM, String(Math.round(query.filters.minPriceAgorot / 100)));
  }
  if (query.filters.maxPriceAgorot !== null) {
    params.set(MAX_PRICE_PARAM, String(Math.round(query.filters.maxPriceAgorot / 100)));
  }

  if (query.sort !== DEFAULT_SORT) params.set(SORT_PARAM, query.sort);
  if (query.page > 1) params.set(PAGE_PARAM, String(query.page));

  return params;
}

/** The catalog's own path. The route that serves it lives in `src/app`. */
export const CATALOG_PATH = "/catalog";

/** A link to a catalog view. The single way this module writes a catalog URL. */
export function catalogHref(query: CatalogQuery, basePath: string = CATALOG_PATH): string {
  const params = toSearchParams(query).toString();
  return params === "" ? basePath : `${basePath}?${params}`;
}

// ---------------------------------------------------------------------------
// Changing one filter at a time
// ---------------------------------------------------------------------------

/**
 * Every mutation resets to page 1.
 *
 * Changing a filter while staying on page 3 lands a visitor past the end of a
 * result set they have not seen the start of. There is no case where keeping
 * the page number is what someone meant.
 */
function reset(query: CatalogQuery, filters: CatalogFilters): CatalogQuery {
  return { filters, sort: query.sort, page: 1 };
}

function withAxis(
  filters: CatalogFilters,
  axis: FilterAxis,
  values: readonly string[],
): CatalogFilters {
  const ordered = AXIS_DEFINITIONS[axis].values.filter((value) => values.includes(value));
  switch (axis) {
    case "media":
      return { ...filters, media: ordered as readonly Medium[] };
    case "styles":
      return { ...filters, styles: ordered as readonly Style[] };
    case "targetSpaces":
      return { ...filters, targetSpaces: ordered as readonly TargetSpace[] };
    case "moods":
      return { ...filters, moods: ordered as readonly Mood[] };
  }
}

/** Add the value if absent, remove it if present. What a sidebar control links to. */
export function toggleFilter(query: CatalogQuery, axis: FilterAxis, value: string): CatalogQuery {
  const current = query.filters[axis] as readonly string[];
  const next = current.includes(value)
    ? current.filter((existing) => existing !== value)
    : [...current, value];

  return reset(query, withAxis(query.filters, axis, next));
}

/** Remove one value from one axis. What a "clear this filter" chip links to. */
export function clearFilter(query: CatalogQuery, axis: FilterAxis, value: string): CatalogQuery {
  const current = query.filters[axis] as readonly string[];
  return reset(
    query,
    withAxis(
      query.filters,
      axis,
      current.filter((existing) => existing !== value),
    ),
  );
}

/** Drop the price range, keeping every other filter. Also a clearable chip. */
export function clearPriceRange(query: CatalogQuery): CatalogQuery {
  return reset(query, { ...query.filters, minPriceAgorot: null, maxPriceAgorot: null });
}

/** Every filter off, sort kept. The "clear all" action on the no-results view. */
export function clearAllFilters(query: CatalogQuery): CatalogQuery {
  return { filters: NO_FILTERS, sort: query.sort, page: 1 };
}

export function withSort(query: CatalogQuery, sort: CatalogSort): CatalogQuery {
  return { filters: query.filters, sort, page: 1 };
}

export function withPage(query: CatalogQuery, page: number): CatalogQuery {
  return { filters: query.filters, sort: query.sort, page: Math.max(1, Math.trunc(page)) };
}

export function isFilterActive(filters: CatalogFilters, axis: FilterAxis, value: string): boolean {
  return (filters[axis] as readonly string[]).includes(value);
}

export function hasActiveFilters(filters: CatalogFilters): boolean {
  return (
    FILTER_AXES.some((axis) => filters[axis].length > 0) ||
    filters.minPriceAgorot !== null ||
    filters.maxPriceAgorot !== null
  );
}

export function activeFilterCount(filters: CatalogFilters): number {
  const taxonomy = FILTER_AXES.reduce((total, axis) => total + filters[axis].length, 0);
  const price = filters.minPriceAgorot !== null || filters.maxPriceAgorot !== null ? 1 : 0;
  return taxonomy + price;
}

/**
 * One removable filter, labelled.
 *
 * catalog-browse: when a combination matches nothing the system "offers to
 * clear INDIVIDUAL filters" -- individually, not just all at once, because a
 * visitor who filtered on four things and got nothing wants to know which one
 * to give up, and "clear everything" throws away the three that were fine.
 */
export interface ActiveFilterChip {
  /** Stable key for React, and for a test to address a chip without its label. */
  readonly id: string;
  readonly label: string;
  /** The query this chip's link goes to: the same view without this one filter. */
  readonly clearedQuery: CatalogQuery;
}

export function activeFilterChips(query: CatalogQuery): readonly ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];

  for (const axis of FILTER_AXES) {
    const definition = AXIS_DEFINITIONS[axis];
    for (const value of query.filters[axis]) {
      chips.push({
        id: `${definition.param}:${value}`,
        label: definition.labels[value] ?? value,
        clearedQuery: clearFilter(query, axis, value),
      });
    }
  }

  const { minPriceAgorot, maxPriceAgorot } = query.filters;
  if (minPriceAgorot !== null || maxPriceAgorot !== null) {
    chips.push({
      id: "price",
      label: priceRangeLabel(minPriceAgorot, maxPriceAgorot),
      clearedQuery: clearPriceRange(query),
    });
  }

  return chips;
}

/**
 * "₪ 200 – ₪ 2,000", or an open-ended form when only one bound is set.
 *
 * `formatAgorotCompact` rather than `formatAgorot`: these are the design's own
 * display prices ("₪ 200", "₪ 2,000"), and a filter bound carrying two decimal
 * places reads like a total rather than a threshold. Formatting money anywhere
 * but `shared/money` is forbidden, which is why this builds the string from
 * that function rather than from `toLocaleString` -- the latter would also make
 * the label depend on the locale the server process happens to be running in.
 */
export function priceRangeLabel(min: Agorot | null, max: Agorot | null): string {
  if (min !== null && max !== null) {
    return `${formatAgorotCompact(min)} – ${formatAgorotCompact(max)}`;
  }
  if (min !== null) return `מ־${formatAgorotCompact(min)}`;
  if (max !== null) return `עד ${formatAgorotCompact(max)}`;
  return "";
}
