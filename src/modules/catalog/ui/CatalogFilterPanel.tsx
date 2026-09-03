/**
 * The filter sidebar — design/Catalog.dc.html.
 *
 * EVERY CONTROL IS A LINK, AND THAT IS THE FEATURE
 * -----------------------------------------------
 * catalog-browse requires a filtered view to be shareable and reloadable. The
 * usual way to build this panel is client-side state that pushes to the URL as
 * a side effect, which gives two sources of truth and a shared link that can
 * show the recipient something the sender never saw.
 *
 * Here there is no state at all. A medium checkbox is an `<a>` to the same
 * catalog with that medium toggled in the query string; the server parses the
 * URL and runs the query. The consequences are all good ones: the view survives
 * reload and the back button, a filter can be middle-clicked into a new tab,
 * the whole panel works with JavaScript disabled, and nothing in this file can
 * disagree with the address bar because nothing in this file remembers anything.
 *
 * It also means no `"use client"` anywhere below this component, so React never
 * serialises these props into the RSC payload embedded in the HTML
 * (SECURITY.md S1-8).
 *
 * The one exception is the price range, which needs two typed numbers rather
 * than a choice from a set. It is a plain `method="get"` form: submitting it
 * navigates to the same path with `min` and `max` in the query string, which is
 * the same mechanism by another name and equally free of JavaScript. The
 * approved design draws a two-handle slider there; a slider cannot be built
 * without client JavaScript, and shipping preset bands plus exact inputs keeps
 * the filter usable, shareable and precise in the meantime. Reported upstream
 * as a deliberate deviation from the mockup.
 */
import { Badge } from "@/shared/ui";
import {
  AXIS_DEFINITIONS,
  CATALOG_PATH,
  FILTER_AXES,
  MAX_PRICE_PARAM,
  MIN_PRICE_PARAM,
  SORT_PARAM,
  catalogHref,
  clearAllFilters,
  clearPriceRange,
  hasActiveFilters,
  isFilterActive,
  toSearchParams,
  toggleFilter,
  DEFAULT_SORT,
  type CatalogQuery,
  type FilterAxis,
} from "../filters";
import { PRICE_BANDS, isPriceBandActive, withPriceBand } from "../price-bands";

export interface CatalogFilterPanelProps {
  readonly query: CatalogQuery;
  readonly basePath?: string;
}

/**
 * The medium axis, drawn as the design's square checkboxes.
 *
 * A link styled as a checkbox rather than an `<input type="checkbox">`, because
 * a real checkbox that navigates on click needs JavaScript, and one inside a
 * form needs a submit button the design does not have. The state the filled
 * square shows sighted visitors is carried for assistive technology by
 * `aria-current` -- not `aria-pressed`, which is a button attribute and is
 * ignored on a link, so it would have looked correct while announcing nothing.
 */
function CheckboxAxis({
  query,
  axis,
  basePath,
}: {
  readonly query: CatalogQuery;
  readonly axis: FilterAxis;
  readonly basePath: string;
}) {
  const definition = AXIS_DEFINITIONS[axis];

  return (
    <div className="mb-[22px] border-t border-rule pt-5">
      <div className="mb-[13px] text-sm font-bold text-ink">{definition.heading}</div>
      <ul className="flex list-none flex-col gap-[10px] p-0 text-sm font-light">
        {definition.values.map((value) => {
          const active = isFilterActive(query.filters, axis, value);
          return (
            <li key={value}>
              <a
                href={catalogHref(toggleFilter(query, axis, value), basePath)}
                aria-current={active ? "true" : undefined}
                className="flex items-center gap-[9px] text-ink hover:text-ink-soft"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block size-[14px] border ${
                    active ? "border-ink bg-ink" : "border-rule"
                  }`}
                />
                {definition.labels[value]}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Style, space and mood, drawn as the design's `.tag` chips. */
function ChipAxis({
  query,
  axis,
  basePath,
}: {
  readonly query: CatalogQuery;
  readonly axis: FilterAxis;
  readonly basePath: string;
}) {
  const definition = AXIS_DEFINITIONS[axis];

  return (
    <div className="mb-[22px] border-t border-rule pt-5">
      <div className="mb-[13px] text-sm font-bold text-ink">{definition.heading}</div>
      <ul className="flex list-none flex-wrap gap-[7px] p-0">
        {definition.values.map((value) => {
          const active = isFilterActive(query.filters, axis, value);
          return (
            <li key={value}>
              <a
                href={catalogHref(toggleFilter(query, axis, value), basePath)}
                aria-current={active ? "true" : undefined}
              >
                <Badge variant={active ? "tag-selected" : "tag"}>{definition.labels[value]}</Badge>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Carry the rest of the query through the price form.
 *
 * A GET form replaces the entire query string with its own fields, so every
 * filter that is not the price has to travel as a hidden input or submitting
 * the price silently clears the other four axes. `page` is deliberately NOT
 * carried: a changed price range starts at page one.
 */
function CarriedFilters({ query }: { readonly query: CatalogQuery }) {
  const carried: { readonly name: string; readonly value: string }[] = [];

  for (const axis of FILTER_AXES) {
    const { param } = AXIS_DEFINITIONS[axis];
    for (const value of query.filters[axis]) carried.push({ name: param, value });
  }
  if (query.sort !== DEFAULT_SORT) carried.push({ name: SORT_PARAM, value: query.sort });

  return (
    <>
      {carried.map((field) => (
        <input
          key={`${field.name}:${field.value}`}
          type="hidden"
          name={field.name}
          value={field.value}
        />
      ))}
    </>
  );
}

function PriceFilter({
  query,
  basePath,
}: {
  readonly query: CatalogQuery;
  readonly basePath: string;
}) {
  const { minPriceAgorot, maxPriceAgorot } = query.filters;
  const shekels = (value: number | null) => (value === null ? "" : String(Math.round(value / 100)));

  return (
    <div className="border-t border-rule pt-5">
      <div className="mb-4 text-sm font-bold text-ink">מחיר</div>

      <ul className="mb-4 flex list-none flex-col gap-2 p-0">
        {PRICE_BANDS.map((band) => {
          const active = isPriceBandActive(query.filters, band);
          return (
            <li key={band.id}>
              <a
                href={catalogHref(withPriceBand(query, band), basePath)}
                aria-current={active ? "true" : undefined}
                className={`text-sm ${active ? "font-bold text-ink" : "font-light text-ink-soft"} hover:text-ink`}
              >
                {band.label}
              </a>
            </li>
          );
        })}
      </ul>

      {/* A GET form, not a slider: see the file header. */}
      <form method="get" action={basePath} className="flex flex-col gap-2">
        <CarriedFilters query={query} />
        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-xs text-ink-muted">מ־₪</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              name={MIN_PRICE_PARAM}
              defaultValue={shekels(minPriceAgorot)}
              className="w-full border border-rule bg-card px-2 py-[6px] text-sm text-ink"
            />
          </label>
          <label className="flex-1">
            <span className="mb-1 block text-xs text-ink-muted">עד ₪</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              name={MAX_PRICE_PARAM}
              defaultValue={shekels(maxPriceAgorot)}
              className="w-full border border-rule bg-card px-2 py-[6px] text-sm text-ink"
            />
          </label>
        </div>
        <button
          type="submit"
          className="border-[1.5px] border-ink bg-transparent px-4 py-2 text-sm font-bold text-ink hover:bg-paper-deep"
        >
          עדכון טווח המחיר
        </button>
      </form>

      {minPriceAgorot !== null || maxPriceAgorot !== null ? (
        <a
          href={catalogHref(clearPriceRange(query), basePath)}
          className="mt-3 inline-block text-xs text-ink-muted underline hover:text-ink"
        >
          ניקוי טווח המחיר
        </a>
      ) : null}
    </div>
  );
}

export function CatalogFilterPanel({
  query,
  basePath = CATALOG_PATH,
}: CatalogFilterPanelProps) {
  return (
    <aside aria-label="סינון הקטלוג">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="text-[19px] font-black text-ink">סינון</h2>
        {hasActiveFilters(query.filters) ? (
          <a
            href={catalogHref(clearAllFilters(query), basePath)}
            className="text-xs text-ink-muted underline hover:text-ink"
          >
            ניקוי הכול
          </a>
        ) : null}
      </div>

      <CheckboxAxis query={query} axis="media" basePath={basePath} />
      <ChipAxis query={query} axis="styles" basePath={basePath} />
      <ChipAxis query={query} axis="targetSpaces" basePath={basePath} />
      <ChipAxis query={query} axis="moods" basePath={basePath} />
      <PriceFilter query={query} basePath={basePath} />
    </aside>
  );
}

/** Exported so a test can build the same link the panel does without scraping the DOM. */
export function filterToggleHref(
  query: CatalogQuery,
  axis: FilterAxis,
  value: string,
  basePath: string = CATALOG_PATH,
): string {
  return catalogHref(toggleFilter(query, axis, value), basePath);
}

/** The canonical query string for a view. Re-exported for route-level cache keys. */
export { toSearchParams };
