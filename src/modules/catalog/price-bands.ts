/**
 * The preset price bands the sidebar offers.
 *
 * The approved design (design/Catalog.dc.html) draws a two-handle slider
 * labelled "₪ 200" to "₪ 2,000". A slider is a client-side control, and this
 * module deliberately has no client state — see the header of
 * `ui/CatalogFilterPanel.tsx`. Bands give the same one-click coarse filtering
 * as dragging a handle, as plain links that end up in the URL; the exact
 * numeric inputs beneath them cover the precision the slider would have added.
 *
 * The endpoints bracket the design's own range and the prices its cards show
 * (₪390 to ₪1,380), with an open band at each end so no artwork is unreachable
 * by any combination of filters — a band set that cannot express "more than the
 * most expensive band's ceiling" hides the top of the catalog from anyone who
 * filters by price at all.
 *
 * Bands are declared in agorot. Nothing in this file rounds, and nothing
 * downstream of it converts: ARCHITECTURE.md's integer-agorot rule holds from
 * here to the `bigint` comparison in the SQL.
 */
import { nonNegativeAgorot, type Agorot } from "@/shared/money";
import { clearPriceRange, type CatalogFilters, type CatalogQuery } from "./filters";

export interface PriceBand {
  /** Stable key. Never rendered; a test addresses a band by this, not by its label. */
  readonly id: string;
  readonly label: string;
  readonly minAgorot: Agorot | null;
  readonly maxAgorot: Agorot | null;
}

const shekels = (value: number): Agorot => nonNegativeAgorot(value * 100);

export const PRICE_BANDS: readonly PriceBand[] = [
  { id: "under_300", label: "עד ₪ 300", minAgorot: null, maxAgorot: shekels(300) },
  { id: "300_600", label: "₪ 300 – ₪ 600", minAgorot: shekels(300), maxAgorot: shekels(600) },
  { id: "600_1200", label: "₪ 600 – ₪ 1,200", minAgorot: shekels(600), maxAgorot: shekels(1200) },
  {
    id: "1200_2500",
    label: "₪ 1,200 – ₪ 2,500",
    minAgorot: shekels(1200),
    maxAgorot: shekels(2500),
  },
  { id: "over_2500", label: "מעל ₪ 2,500", minAgorot: shekels(2500), maxAgorot: null },
];

export function isPriceBandActive(filters: CatalogFilters, band: PriceBand): boolean {
  return filters.minPriceAgorot === band.minAgorot && filters.maxPriceAgorot === band.maxAgorot;
}

/**
 * Apply a band, or clear the price filter when the band already applies.
 *
 * Toggling rather than only setting, so a band behaves like every other control
 * in the panel: clicking the thing that is already on turns it off. A visitor
 * who has to hunt for a separate "clear" link to undo the click they just made
 * has been given a control that only goes one way.
 */
export function withPriceBand(query: CatalogQuery, band: PriceBand): CatalogQuery {
  if (isPriceBandActive(query.filters, band)) return clearPriceRange(query);

  return {
    filters: { ...query.filters, minPriceAgorot: band.minAgorot, maxPriceAgorot: band.maxAgorot },
    sort: query.sort,
    page: 1,
  };
}
