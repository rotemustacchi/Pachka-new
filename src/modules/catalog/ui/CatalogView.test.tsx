/**
 * The catalog page, rendered — tasks 5.1, 5.3, 5.4 and 5.5.
 *
 * The two empty states get the most attention here, and the empty-catalog one
 * most of all: PACHKA launches with no artists, so the first visitors to the
 * product see that state and nothing else. A test that only covers the grid
 * covers the case that will not exist for weeks.
 *
 * Everything is asserted through the rendered output — the text a visitor
 * reads, the links they can follow. Nothing here inspects a call.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nonNegativeAgorot, type Agorot } from "@/shared/money";
import type { PublicArtist } from "@/modules/accounts";
import type { PublicArtwork } from "@/modules/artworks";
import { CatalogView, resultCountLabel } from "./CatalogView";
import { DEFAULT_QUERY, NO_FILTERS, type CatalogQuery } from "../filters";
import type { CatalogEntry, CatalogPage } from "../query";

const ARTIST: PublicArtist = {
  id: "3f6b1c2e-0000-4000-8000-000000000001",
  displayName: "יעל שוורץ",
  biography: "ציירת מתל אביב.",
  city: "תל אביב",
  avatarPath: null,
  memberSince: "2026-02-01T09:00:00.000Z",
};

function artwork(overrides: Partial<PublicArtwork> = {}): PublicArtwork {
  const price = (overrides.priceAgorot ?? nonNegativeAgorot(125_000)) as Agorot;

  return {
    id: "a0000000-0000-4000-8000-000000000001",
    artistId: ARTIST.id,
    status: "published",
    statusLabel: "מפורסמת",
    title: "קו החוף, שקיעה",
    description: "ציור שנעשה בחוף פולג.",
    priceAgorot: price,
    priceFormatted: "₪1,250.00",
    heightCm: 100,
    widthCm: 70,
    depthCm: null,
    dimensionsFormatted: "100 × 70 ס״מ",
    weightGrams: 1850,
    weightFormatted: "1,850 גרם",
    materials: "אקריליק על בד פשתן",
    isFramed: true,
    leadTimeDays: 5,
    yearCreated: 2026,
    medium: { value: "painting_illustration", label: "ציור ואיור" },
    styles: [{ value: "minimalist", label: "מינימליסטי" }],
    targetSpaces: [{ value: "living_room", label: "סלון" }],
    moods: [{ value: "calm", label: "מרגיע" }],
    inventoryType: "unique",
    stock: 1,
    madeToOrder: false,
    productionLeadTimeDays: null,
    availableUnits: 1,
    purchasable: true,
    soldOut: false,
    aiAssisted: false,
    aiAssistedLabel: null,
    images: [
      {
        id: "i1",
        displayPath: "a1/display.jpg",
        thumbnailPath: "a1/thumb.jpg",
        altText: "ציור של קו חוף בשקיעה",
        isPrimary: true,
      },
    ],
    publishedAt: "2026-06-01T09:00:00.000Z",
    ...overrides,
  };
}

const entry = (overrides: Partial<PublicArtwork> = {}): CatalogEntry => ({
  artwork: artwork(overrides),
  artist: ARTIST,
});

function page(overrides: Partial<CatalogPage> = {}): CatalogPage {
  const entries = overrides.entries ?? [entry()];
  return {
    entries,
    total: entries.length,
    page: 1,
    pageSize: 24,
    pageCount: entries.length === 0 ? 0 : 1,
    query: DEFAULT_QUERY,
    catalogIsEmpty: false,
    ...overrides,
  };
}

// eslint-disable-next-line @next/next/no-img-element -- a test stub, not a page.
const renderImage = ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />;

const renderCatalog = (value: CatalogPage, ignored: { param: string; value: string }[] = []) =>
  render(<CatalogView page={value} renderImage={renderImage} ignored={ignored} />);

describe("an anonymous visitor browsing the catalog", () => {
  it("sees the artwork's image, title, artist name and price with no sign-in anywhere", () => {
    renderCatalog(page());

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("הקטלוג");
    expect(screen.getByText("קו החוף, שקיעה")).toBeInTheDocument();
    expect(screen.getByText("יעל שוורץ")).toBeInTheDocument();
    expect(screen.getByText("₪1,250.00")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ציור של קו חוף בשקיעה" })).toBeInTheDocument();

    // Nothing on this page asks a visitor to identify themselves. The catalog
    // is public, and a sign-in gate here would be the defect.
    expect(screen.queryByText(/כניסה|הרשמה|התחברות/)).not.toBeInTheDocument();
  });

  it("links each card to its artwork", () => {
    renderCatalog(page());

    const link = screen.getByRole("link", { name: /קו החוף, שקיעה/ });
    expect(link).toHaveAttribute("href", "/artworks/a0000000-0000-4000-8000-000000000001");
  });

  it("shows the AI-assistance label on a card that declared it", () => {
    renderCatalog(page({ entries: [entry({ aiAssisted: true, aiAssistedLabel: "נוצר בעזרת AI" })] }));

    expect(screen.getByText("נוצר בעזרת AI")).toBeInTheDocument();
  });

  it("counts the results in the heading", () => {
    renderCatalog(page({ total: 24 }));

    expect(screen.getByText(/24 יצירות/)).toBeInTheDocument();
  });
});

describe("the empty-catalog state — what the first visitors to PACHKA see", () => {
  const emptyCatalog = page({ entries: [], total: 0, pageCount: 0, catalogIsEmpty: true });

  it("invites artists to join rather than rendering an empty grid", () => {
    renderCatalog(emptyCatalog);

    expect(screen.getByRole("heading", { name: /הקטלוג עוד מחכה ליצירה הראשונה/ })).toBeVisible();
    expect(screen.getByText(/זה הרגע להיות\s+הראשונים בקטלוג/)).toBeVisible();
  });

  it("gives that invitation somewhere to go", () => {
    renderCatalog(emptyCatalog);

    expect(screen.getByRole("link", { name: "הצטרפות כאמן" })).toHaveAttribute(
      "href",
      "/become-an-artist",
    );
  });

  it("is not an error, and not a list", () => {
    renderCatalog(emptyCatalog);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("does not offer to clear filters, because there are none to clear", () => {
    renderCatalog(emptyCatalog);

    expect(screen.queryByText(/ניקוי כל הסינון/)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });
});

describe("the no-results state — the catalog has artworks, this filter has none", () => {
  const filtered: CatalogQuery = {
    filters: {
      ...NO_FILTERS,
      media: ["ceramics_objects"],
      moods: ["calm"],
      minPriceAgorot: nonNegativeAgorot(20_000),
      maxPriceAgorot: nonNegativeAgorot(60_000),
    },
    sort: "newest",
    page: 1,
  };

  const noResults = page({
    entries: [],
    total: 0,
    pageCount: 0,
    query: filtered,
    catalogIsEmpty: false,
  });

  it("says nothing matched rather than showing an error", () => {
    renderCatalog(noResults);

    expect(screen.getByRole("heading", { name: /לא נמצאו יצירות/ })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does NOT tell a visitor the catalog is empty when it is not", () => {
    renderCatalog(noResults);

    expect(screen.queryByText(/הקטלוג עוד מחכה/)).not.toBeInTheDocument();
  });

  it("offers to clear each filter individually, keeping the others", () => {
    renderCatalog(noResults);

    // Removing the mood keeps the medium and the price range in the link.
    const removeMood = screen.getByRole("link", { name: "הסרת הסינון מרגיע" });
    const href = removeMood.getAttribute("href") ?? "";

    expect(href).not.toContain("mood=calm");
    expect(href).toContain("medium=ceramics_objects");
    expect(href).toContain("min=200");
    expect(href).toContain("max=600");
  });

  it("offers a chip for every active filter, price included", () => {
    renderCatalog(noResults);

    expect(screen.getByRole("link", { name: "הסרת הסינון קרמיקה ואובייקטים" })).toBeVisible();
    expect(screen.getByRole("link", { name: "הסרת הסינון מרגיע" })).toBeVisible();
    expect(screen.getByRole("link", { name: /הסרת הסינון ₪ 200 – ₪ 600/ })).toBeVisible();
  });

  it("also offers to clear everything at once", () => {
    renderCatalog(noResults);

    expect(screen.getByRole("link", { name: "ניקוי כל הסינון" })).toHaveAttribute("href", "/catalog");
  });
});

describe("sorting", () => {
  it("offers newest and both price directions as links that change only the sort", () => {
    renderCatalog(page({ query: { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, moods: ["calm"] } } }));

    const sorting = screen.getByRole("navigation", { name: "מיון" });

    expect(within(sorting).getByRole("link", { name: "מחיר: מהנמוך לגבוה" })).toHaveAttribute(
      "href",
      "/catalog?mood=calm&sort=price_asc",
    );
    expect(within(sorting).getByRole("link", { name: "מחיר: מהגבוה לנמוך" })).toHaveAttribute(
      "href",
      "/catalog?mood=calm&sort=price_desc",
    );
  });

  it("marks the sort currently in effect", () => {
    renderCatalog(page({ query: { ...DEFAULT_QUERY, sort: "price_desc" } }));

    const current = screen.getByRole("link", { name: "מחיר: מהגבוה לנמוך" });
    expect(current).toHaveAttribute("aria-current", "true");
  });
});

describe("every filter control is a link, so the view lives in the URL", () => {
  it("makes a medium checkbox a link that toggles it in the query string", () => {
    renderCatalog(page());

    expect(screen.getByRole("link", { name: "קרמיקה ואובייקטים" })).toHaveAttribute(
      "href",
      "/catalog?medium=ceramics_objects",
    );
  });

  it("makes an active filter's link the one that removes it", () => {
    renderCatalog(
      page({ query: { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, moods: ["calm"] } } }),
    );

    const chip = screen.getByRole("link", { name: "מרגיע" });
    expect(chip).toHaveAttribute("href", "/catalog");
    expect(chip).toHaveAttribute("aria-current", "true");
  });

  it("keeps the price form free of JavaScript by submitting as a GET", () => {
    const { container } = renderCatalog(page());

    const form = container.querySelector("form");
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/catalog");
  });

  it("carries the other filters through the price form as hidden inputs", () => {
    const { container } = renderCatalog(
      page({
        query: { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, moods: ["calm"] }, sort: "price_asc" },
      }),
    );

    const hidden = [...container.querySelectorAll<HTMLInputElement>('input[type="hidden"]')];
    const carried = hidden.map((input) => `${input.name}=${input.value}`);

    // Without these, submitting a price would silently clear every other filter.
    expect(carried).toContain("mood=calm");
    expect(carried).toContain("sort=price_asc");
  });
});

describe("pagination", () => {
  it("links forward and back while staying on the same filters", () => {
    renderCatalog(
      page({
        total: 50,
        page: 2,
        pageCount: 3,
        query: { ...DEFAULT_QUERY, filters: { ...NO_FILTERS, moods: ["calm"] }, page: 2 },
      }),
    );

    expect(screen.getByRole("link", { name: "העמוד הקודם" })).toHaveAttribute(
      "href",
      "/catalog?mood=calm",
    );
    expect(screen.getByRole("link", { name: "העמוד הבא" })).toHaveAttribute(
      "href",
      "/catalog?mood=calm&page=3",
    );
  });

  it("shows no pagination when everything fits on one page", () => {
    renderCatalog(page());

    expect(screen.queryByRole("navigation", { name: /ניווט בין עמודי/ })).not.toBeInTheDocument();
  });
});

describe("a link carrying a filter this deployment does not recognise", () => {
  it("says which filters it could not apply, because the results are wider than asked for", () => {
    renderCatalog(page(), [{ param: "style", value: "coastal_minimal" }]);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("style=coastal_minimal");
    expect(notice).toHaveTextContent(/רחבות יותר/);
  });

  it("says nothing when every filter in the link was understood", () => {
    renderCatalog(page());

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("the result count label", () => {
  it("reads naturally for none, one and many", () => {
    expect(resultCountLabel(0)).toBe("אין יצירות");
    expect(resultCountLabel(1)).toBe("יצירה אחת");
    expect(resultCountLabel(24)).toBe("24 יצירות");
  });
});
