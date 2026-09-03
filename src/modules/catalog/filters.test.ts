/**
 * The catalog query's round trip through a URL — task 5.4.
 *
 * catalog-browse: "Active filters SHALL be reflected in the URL so that a
 * filtered view can be shared and reloaded." That sentence is a property, not a
 * feature, and the property is: parsing a URL this module built returns the
 * query it was built from, for every combination. `catalog-browse.test.ts`
 * proves the same thing end to end against real Postgres — that two sessions
 * given one URL see one result set — and these tests are what say WHICH part
 * broke when it does.
 *
 * Nothing here is mocked, and there is nothing that could be: this file is pure
 * functions over plain data.
 */
import { describe, expect, it } from "vitest";
import { nonNegativeAgorot } from "@/shared/money";
import {
  DEFAULT_QUERY,
  NO_FILTERS,
  activeFilterChips,
  activeFilterCount,
  catalogHref,
  clearAllFilters,
  clearFilter,
  clearPriceRange,
  hasActiveFilters,
  parseCatalogQuery,
  priceRangeLabel,
  toSearchParams,
  toggleFilter,
  withPage,
  withSort,
  type CatalogQuery,
} from "./filters";
import { PRICE_BANDS, isPriceBandActive, withPriceBand } from "./price-bands";

const shekels = (value: number) => nonNegativeAgorot(value * 100);

/** The spec's own combined filter: a medium, a mood, and ₪200–₪600. */
const COMBINED: CatalogQuery = {
  filters: {
    ...NO_FILTERS,
    media: ["ceramics_objects"],
    moods: ["calm"],
    minPriceAgorot: shekels(200),
    maxPriceAgorot: shekels(600),
  },
  sort: "price_asc",
  page: 3,
};

/** Parse the string a link would actually carry, the way a fresh session does. */
function parseHref(href: string) {
  const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  return parseCatalogQuery(new URLSearchParams(query));
}

describe("a filtered view survives being turned into a URL and back", () => {
  it("returns the same query it serialised, across every axis at once", () => {
    const { query, ignored } = parseHref(catalogHref(COMBINED));

    expect(query).toEqual(COMBINED);
    expect(ignored).toEqual([]);
  });

  it("round-trips each taxonomy axis on its own", () => {
    const cases: CatalogQuery[] = [
      { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, media: ["photography", "jewelry"] } },
      { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, styles: ["abstract", "pop_art"] } },
      { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, targetSpaces: ["kitchen"] } },
      { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, moods: ["romantic", "edgy"] } },
    ];

    for (const original of cases) {
      expect(parseHref(catalogHref(original)).query).toEqual(original);
    }
  });

  it("round-trips every sort", () => {
    for (const sort of ["newest", "price_asc", "price_desc"] as const) {
      expect(parseHref(catalogHref(withSort(DEFAULT_QUERY, sort))).query.sort).toBe(sort);
    }
  });

  it("round-trips a price range through whole shekels without losing agorot", () => {
    const query: CatalogQuery = {
      ...DEFAULT_QUERY,
      filters: { ...NO_FILTERS, minPriceAgorot: shekels(200), maxPriceAgorot: shekels(2000) },
    };

    const parsed = parseHref(catalogHref(query)).query;

    expect(parsed.filters.minPriceAgorot).toBe(20_000);
    expect(parsed.filters.maxPriceAgorot).toBe(200_000);
  });

  it("gives the unfiltered catalog a clean path with no query string", () => {
    expect(catalogHref(DEFAULT_QUERY)).toBe("/catalog");
  });

  it("omits the defaults, so a shared link carries only what was chosen", () => {
    const href = catalogHref({ ...DEFAULT_QUERY, filters: { ...NO_FILTERS, moods: ["calm"] } });

    expect(href).toBe("/catalog?mood=calm");
  });
});

describe("the URL is canonical, so one view has one address", () => {
  it("orders values by the taxonomy's declared order, not by the order they were clicked", () => {
    const clickedBackwards = toggleFilter(
      toggleFilter(DEFAULT_QUERY, "styles", "pop_art"),
      "styles",
      "abstract",
    );
    const clickedForwards = toggleFilter(
      toggleFilter(DEFAULT_QUERY, "styles", "abstract"),
      "styles",
      "pop_art",
    );

    expect(catalogHref(clickedBackwards)).toBe(catalogHref(clickedForwards));
    expect(catalogHref(clickedForwards)).toBe("/catalog?style=abstract&style=pop_art");
  });

  it("serialises a query object canonically even when it was not built canonically", () => {
    // A query assembled by hand -- by a test, or by a route reconstructing one
    // from somewhere other than `toggleFilter` -- must not get a second URL for
    // a view that already has one.
    const outOfOrder: CatalogQuery = {
      ...DEFAULT_QUERY,
      filters: { ...NO_FILTERS, media: ["jewelry", "photography"] },
    };

    expect(catalogHref(outOfOrder)).toBe("/catalog?medium=photography&medium=jewelry");
  });

  it("normalises a hand-written URL into the same view as a clicked one", () => {
    // Comma-separated, reversed, and with a duplicate: all three are things a
    // person types or a link accumulates, and none of them is a different view.
    const typed = parseCatalogQuery(new URLSearchParams("style=pop_art,abstract,abstract"));

    expect(toSearchParams(typed.query).toString()).toBe("style=abstract&style=pop_art");
  });

  it("treats an absent parameter and an empty one as the same absence", () => {
    const empty = parseCatalogQuery(new URLSearchParams("medium=&sort=&min=&page="));

    expect(empty.query).toEqual(DEFAULT_QUERY);
    expect(empty.ignored).toEqual([]);
  });

  it("accepts what Next.js hands a page, not only URLSearchParams", () => {
    const fromNext = parseCatalogQuery({
      medium: ["ceramics_objects", "jewelry"],
      mood: "calm",
      sort: "price_desc",
      page: "2",
    });

    expect(fromNext.query.filters.media).toEqual(["ceramics_objects", "jewelry"]);
    expect(fromNext.query.filters.moods).toEqual(["calm"]);
    expect(fromNext.query.sort).toBe("price_desc");
    expect(fromNext.query.page).toBe(2);
  });
});

describe("a URL this deployment cannot fully honour", () => {
  it("drops a taxonomy value outside the closed set instead of failing the page", () => {
    const { query, ignored } = parseCatalogQuery(
      new URLSearchParams("style=minimalist&style=coastal_minimal"),
    );

    expect(query.filters.styles).toEqual(["minimalist"]);
    expect(ignored).toEqual([{ param: "style", value: "coastal_minimal" }]);
  });

  it("reports every dropped value, because dropping one WIDENS the results", () => {
    const { ignored } = parseCatalogQuery(
      new URLSearchParams("medium=sculpture&mood=nostalgic&sort=cheapest&min=lots"),
    );

    expect(ignored).toEqual([
      { param: "medium", value: "sculpture" },
      { param: "mood", value: "nostalgic" },
      { param: "min", value: "lots" },
      { param: "sort", value: "cheapest" },
    ]);
  });

  it("falls back to the default sort rather than reaching SQL with an unknown one", () => {
    const { query } = parseCatalogQuery(new URLSearchParams("sort=price_asc;drop table artworks"));

    expect(query.sort).toBe("newest");
  });

  it("keeps a reversed price range exactly as given, so it matches nothing and says so", () => {
    // Not swapped and not dropped: swapping answers a different question than
    // the one asked, and dropping widens the results. Matching nothing is a
    // state the no-results view already handles well.
    const { query, ignored } = parseCatalogQuery(new URLSearchParams("min=2000&max=200"));

    expect(query.filters.minPriceAgorot).toBe(200_000);
    expect(query.filters.maxPriceAgorot).toBe(20_000);
    expect(ignored).toEqual([]);
  });

  it("clamps a nonsensical page number instead of paginating past the universe", () => {
    expect(parseCatalogQuery(new URLSearchParams("page=0")).query.page).toBe(1);
    expect(parseCatalogQuery(new URLSearchParams("page=-4")).query.page).toBe(1);
    expect(parseCatalogQuery(new URLSearchParams("page=abc")).query.page).toBe(1);
  });
});

describe("changing one filter at a time", () => {
  it("adds a value that was off and removes one that was on", () => {
    const on = toggleFilter(DEFAULT_QUERY, "moods", "calm");
    expect(on.filters.moods).toEqual(["calm"]);

    const off = toggleFilter(on, "moods", "calm");
    expect(off.filters.moods).toEqual([]);
  });

  it("returns to page 1, so a changed filter never lands past the end of its own results", () => {
    const onPageFive = withPage(COMBINED, 5);

    expect(toggleFilter(onPageFive, "styles", "abstract").page).toBe(1);
    expect(clearFilter(onPageFive, "moods", "calm").page).toBe(1);
    expect(clearPriceRange(onPageFive).page).toBe(1);
    expect(clearAllFilters(onPageFive).page).toBe(1);
  });

  it("keeps the chosen sort while filters change", () => {
    expect(toggleFilter(COMBINED, "styles", "abstract").sort).toBe("price_asc");
    expect(clearAllFilters(COMBINED).sort).toBe("price_asc");
  });

  it("clears one filter and leaves the other three standing", () => {
    const cleared = clearFilter(COMBINED, "moods", "calm");

    expect(cleared.filters.moods).toEqual([]);
    expect(cleared.filters.media).toEqual(["ceramics_objects"]);
    expect(cleared.filters.minPriceAgorot).toBe(20_000);
    expect(cleared.filters.maxPriceAgorot).toBe(60_000);
  });
});

describe("the chips that offer to clear individual filters", () => {
  it("gives one chip per active filter, with the price range counted once", () => {
    const chips = activeFilterChips(COMBINED);

    expect(chips.map((chip) => chip.id)).toEqual(["medium:ceramics_objects", "mood:calm", "price"]);
    expect(activeFilterCount(COMBINED.filters)).toBe(3);
  });

  it("labels each chip in Hebrew, from the artworks taxonomy", () => {
    const chips = activeFilterChips(COMBINED);

    expect(chips.map((chip) => chip.label)).toEqual([
      "קרמיקה ואובייקטים",
      "מרגיע",
      "₪ 200 – ₪ 600",
    ]);
  });

  it("points each chip at the same view minus that one filter", () => {
    const [medium, mood, price] = activeFilterChips(COMBINED);

    expect(medium!.clearedQuery.filters.media).toEqual([]);
    expect(medium!.clearedQuery.filters.moods).toEqual(["calm"]);

    expect(mood!.clearedQuery.filters.moods).toEqual([]);
    expect(mood!.clearedQuery.filters.media).toEqual(["ceramics_objects"]);

    expect(price!.clearedQuery.filters.minPriceAgorot).toBeNull();
    expect(price!.clearedQuery.filters.media).toEqual(["ceramics_objects"]);
  });

  it("produces the same URL as the sidebar's own toggle for the same removal", () => {
    const [medium] = activeFilterChips(COMBINED);

    expect(catalogHref(medium!.clearedQuery)).toBe(
      catalogHref(toggleFilter(COMBINED, "media", "ceramics_objects")),
    );
  });

  it("has no chips at all when nothing is filtered", () => {
    expect(activeFilterChips(DEFAULT_QUERY)).toEqual([]);
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
  });
});

describe("price labels and bands", () => {
  it("labels a closed range, and each open-ended one", () => {
    expect(priceRangeLabel(shekels(200), shekels(2000))).toBe("₪ 200 – ₪ 2,000");
    expect(priceRangeLabel(shekels(300), null)).toBe("מ־₪ 300");
    expect(priceRangeLabel(null, shekels(300))).toBe("עד ₪ 300");
    expect(priceRangeLabel(null, null)).toBe("");
  });

  it("applies a band, and clears it when it is already applied", () => {
    const band = PRICE_BANDS[1]!;

    const applied = withPriceBand(DEFAULT_QUERY, band);
    expect(isPriceBandActive(applied.filters, band)).toBe(true);

    const toggledOff = withPriceBand(applied, band);
    expect(toggledOff.filters.minPriceAgorot).toBeNull();
    expect(toggledOff.filters.maxPriceAgorot).toBeNull();
  });

  it("leaves no price unreachable: the bands run from open-below to open-above", () => {
    expect(PRICE_BANDS[0]!.minAgorot).toBeNull();
    expect(PRICE_BANDS[PRICE_BANDS.length - 1]!.maxAgorot).toBeNull();
  });

  it("round-trips a band through the URL like any other filter", () => {
    const applied = withPriceBand(DEFAULT_QUERY, PRICE_BANDS[2]!);

    expect(parseHref(catalogHref(applied)).query).toEqual(applied);
  });
});
