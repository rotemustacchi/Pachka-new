/**
 * The artwork detail page, rendered — tasks 5.6 and 5.7.
 *
 * The specification assertions in the first block are not box-ticking. The MVP
 * has no buyer-to-artist messaging, so this page is the only place a buyer can
 * learn the size, weight, materials, framing and lead time of a piece before
 * committing money to it. A missing row here is a piece that cannot be bought,
 * which is why the spec lists the fields explicitly and why they are asserted
 * one by one rather than by a snapshot that would go green on any change.
 *
 * The second half is task 5.7: sold and unlisted artworks render, read-only,
 * with no purchase action. The absence assertions matter more than the presence
 * ones — a buy button on a sold unique painting takes money for something that
 * does not exist.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nonNegativeAgorot, type Agorot } from "@/shared/money";
import type { PublicArtist } from "@/modules/accounts";
import type { PublicArtwork } from "@/modules/artworks";
import { ArtworkDetailView, shippingLine, type CatalogReturnTerms } from "./ArtworkDetailView";

const ARTIST: PublicArtist = {
  id: "3f6b1c2e-0000-4000-8000-000000000001",
  displayName: "יעל שוורץ",
  biography: "ציירת מתל אביב.",
  city: "תל אביב",
  avatarPath: null,
  memberSince: "2026-02-01T09:00:00.000Z",
};

/**
 * The return terms as `shipping.returnTerms()` produces them, trimmed to the
 * two fields this page reads. The real value is assignable to this without a
 * cast, which is the point of declaring the type structurally.
 */
const RETURN_TERMS: CatalogReturnTerms = {
  windowDays: 14,
  statements: [
    { code: "window", text: "ניתן לבטל עסקה ולהחזיר את היצירה תוך 14 ימים מיום קבלתה." },
    { code: "return_shipping_paid_by_buyer", text: "עלות משלוח ההחזרה חלה על הקונה." },
    { code: "transit_risk_on_buyer", text: "האחריות לנזק שייגרם ליצירה במשלוח ההחזרה חלה על הקונה." },
  ],
};

function artwork(overrides: Partial<PublicArtwork> = {}): PublicArtwork {
  return {
    id: "a0000000-0000-4000-8000-000000000001",
    artistId: ARTIST.id,
    status: "published",
    statusLabel: "מפורסמת",
    title: "קו החוף, שקיעה",
    description: "ציור שנעשה בחוף פולג בשעת בין ערביים.",
    priceAgorot: nonNegativeAgorot(125_000),
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
      {
        id: "i2",
        displayPath: "a1/second.jpg",
        thumbnailPath: "a1/second-thumb.jpg",
        altText: "פרט מתוך הציור",
        isPrimary: false,
      },
    ],
    publishedAt: "2026-06-01T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * The specification block, addressed by its accessible name.
 *
 * Several facts legitimately appear both here and in the summary beside the
 * price, so an unscoped `getByText` for one of them is ambiguous rather than
 * wrong. Scoping says which of the two occurrences the test is about.
 */
const specifications = () => screen.getByRole("region", { name: "מפרט" });

const shippingRange = {
  minAgorot: nonNegativeAgorot(4500) as Agorot,
  maxAgorot: nonNegativeAgorot(8000) as Agorot,
};

// eslint-disable-next-line @next/next/no-img-element -- a test stub, not a page.
const renderImage = ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />;

function renderDetail(
  overrides: Partial<PublicArtwork> = {},
  props: Partial<React.ComponentProps<typeof ArtworkDetailView>> = {},
) {
  return render(
    <ArtworkDetailView
      artwork={artwork(overrides)}
      artist={ARTIST}
      artistProfileIsPublic
      returnTerms={RETURN_TERMS}
      shippingRange={shippingRange}
      purchaseAction={<button type="button">הוספה לעגלה</button>}
      renderImage={renderImage}
      {...props}
    />,
  );
}

describe("the full specification set — the only place a buyer can learn these", () => {
  it("shows the dimensions", () => {
    renderDetail();
    expect(screen.getByText("100 × 70 ס״מ")).toBeInTheDocument();
  });

  it("shows the weight", () => {
    renderDetail();
    expect(screen.getByText("1,850 גרם")).toBeInTheDocument();
  });

  it("shows the materials", () => {
    renderDetail();
    expect(screen.getByText("אקריליק על בד פשתן")).toBeInTheDocument();
  });

  it("shows whether the piece is framed", () => {
    renderDetail();
    expect(screen.getByText("ממוסגר, מוכן לתלייה")).toBeInTheDocument();
  });

  it("shows the dispatch lead time", () => {
    renderDetail();
    // Scoped to the specification block: the lead time deliberately appears
    // twice on this page -- once in the summary line under the price, as the
    // approved design has it, and once as a specification row, because
    // `artworks.ArtworkSpecifications` derives its rows from the artwork rather
    // than from this page's layout. Asserting it unscoped would be ambiguous,
    // and asserting it only in the summary would let the specification row
    // vanish unnoticed.
    expect(within(specifications()).getByText(/נשלח תוך 5 ימי עסקים/)).toBeInTheDocument();
  });

  it("shows the year it was made", () => {
    renderDetail();
    expect(screen.getByText("2026")).toBeInTheDocument();
  });

  // The AI disclosure is shown BOTH ways round. "לא" is information a buyer
  // wants; an absent row would leave them guessing whether the question was
  // even asked. One assertion per test, because two `renderDetail()` calls in
  // one test leave two documents mounted and every query ambiguous.
  it("answers the AI-assistance question when the answer is no", () => {
    renderDetail();

    expect(within(specifications()).getByText("לא")).toBeInTheDocument();
  });

  it("answers the AI-assistance question when the answer is yes", () => {
    renderDetail({ aiAssisted: true, aiAssistedLabel: "נוצר בעזרת AI" });

    expect(
      within(specifications()).getByText("כן, נעשה שימוש משמעותי בבינה מלאכותית"),
    ).toBeInTheDocument();
  });

  it("states that a one-off piece is unique", () => {
    renderDetail();

    expect(within(specifications()).getByText("יצירה יחידה")).toBeInTheDocument();
  });

  it("states the edition size for an edition", () => {
    renderDetail({ inventoryType: "edition", stock: 10 });

    expect(within(specifications()).getByText("מהדורה מתוך 10")).toBeInTheDocument();
  });
});

describe("the rest of what the page must carry", () => {
  it("shows the title as the page heading and the price", () => {
    renderDetail();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("קו החוף, שקיעה");
    expect(screen.getByText("₪ 1,250")).toBeInTheDocument();
  });

  it("shows every image, not only the primary one", () => {
    renderDetail();

    expect(screen.getByRole("img", { name: "ציור של קו חוף בשקיעה" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "פרט מתוך הציור" })).toBeInTheDocument();
  });

  it("shows the estimated shipping range and the lead time together", () => {
    renderDetail();

    expect(screen.getByText("משלוח מוערך ₪ 45 – ₪ 80 · נשלח תוך 5 ימי עסקים")).toBeInTheDocument();
  });

  it("shows the description", () => {
    renderDetail();

    expect(screen.getByText(/ציור שנעשה בחוף פולג/)).toBeInTheDocument();
  });

  it("shows the classification, each value linking to the catalog filtered by it", () => {
    renderDetail();

    expect(screen.getByRole("link", { name: "מינימליסטי" })).toHaveAttribute(
      "href",
      "/catalog?style=minimalist",
    );
    expect(screen.getByRole("link", { name: "מרגיע" })).toHaveAttribute("href", "/catalog?mood=calm");
    expect(screen.getByRole("link", { name: "סלון" })).toHaveAttribute(
      "href",
      "/catalog?space=living_room",
    );
  });

  it("summarises the return policy, including who pays return shipping", () => {
    renderDetail();

    const returns = screen.getByRole("region", { name: "החזרות וביטול עסקה" });
    expect(within(returns).getByText(/תוך 14 ימים מיום קבלתה/)).toBeVisible();
    expect(within(returns).getByText("עלות משלוח ההחזרה חלה על הקונה.")).toBeVisible();
    expect(within(returns).getByText(/האחריות לנזק/)).toBeVisible();
  });

  it("states the return window beside the purchase action, before the buyer commits", () => {
    renderDetail();

    expect(screen.getByText(/14 יום להחזרה · תעודת מקוריות דיגיטלית/)).toBeInTheDocument();
  });
});

describe("the artist's display name", () => {
  it("links to their profile", () => {
    renderDetail();

    expect(screen.getByRole("link", { name: "יעל שוורץ" })).toHaveAttribute(
      "href",
      "/artists/3f6b1c2e-0000-4000-8000-000000000001",
    );
  });

  it("shows the city at city granularity", () => {
    renderDetail();

    expect(screen.getByText("· תל אביב")).toBeInTheDocument();
  });

  it("renders as plain text when the artist has no public profile to link to", () => {
    // An artist whose only piece has sold has no profile page: `accounts`
    // publishes one only for an artist with something PUBLISHED. A link here
    // would be a link to a 404.
    renderDetail({ status: "sold", purchasable: false, soldOut: true }, {
      artistProfileIsPublic: false,
    });

    expect(screen.queryByRole("link", { name: "יעל שוורץ" })).not.toBeInTheDocument();
    expect(screen.getByText("יעל שוורץ")).toBeInTheDocument();
  });

  it("never shows a contact detail — `PublicArtist` cannot carry one", () => {
    const { container } = renderDetail();

    expect(container.innerHTML).not.toMatch(/@|\+972|05\d-?\d{7}/);
  });
});

describe("a sold artwork renders read-only, with no purchase action", () => {
  const sold = { status: "sold" as const, purchasable: false, soldOut: true, availableUnits: 0 };

  it("shows no purchase control at all", () => {
    renderDetail(sold);

    expect(screen.queryByRole("button", { name: "הוספה לעגלה" })).not.toBeInTheDocument();
  });

  it("says why, rather than leaving a gap where the button was", () => {
    renderDetail(sold);

    expect(screen.getByRole("status")).toHaveTextContent("היצירה נמכרה ואינה זמינה לרכישה.");
  });

  it("still shows the full specification, because the page is still a record of the work", () => {
    renderDetail(sold);

    expect(screen.getByText("100 × 70 ס״מ")).toBeInTheDocument();
    expect(screen.getByText("אקריליק על בד פשתן")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("קו החוף, שקיעה");
  });
});

describe("an unlisted artwork renders read-only too, and says something different", () => {
  const unlisted = { status: "unlisted" as const, purchasable: false, soldOut: false };

  it("shows no purchase control", () => {
    renderDetail(unlisted);

    expect(screen.queryByRole("button", { name: "הוספה לעגלה" })).not.toBeInTheDocument();
  });

  it("does not claim it was sold", () => {
    renderDetail(unlisted);

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("היצירה אינה מוצגת למכירה כרגע.");
    expect(notice).not.toHaveTextContent("נמכרה");
  });
});

describe("an edition whose last unit is held by someone else's checkout", () => {
  it("offers no purchase action even though its status is still published", () => {
    // `purchasable` is derived from availability AND status together. A page
    // that keyed off `status === "published"` alone would sell the last unit
    // twice.
    renderDetail({
      status: "published",
      inventoryType: "edition",
      stock: 3,
      availableUnits: 0,
      soldOut: true,
      purchasable: false,
    });

    expect(screen.queryByRole("button", { name: "הוספה לעגלה" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("היצירה נמכרה ואינה זמינה לרכישה.");
  });
});

describe("what the route has not wired yet", () => {
  it("omits the shipping estimate rather than inventing one", () => {
    renderDetail({}, { shippingRange: undefined });

    expect(screen.queryByText(/משלוח מוערך/)).not.toBeInTheDocument();
    // The lead time is a fact about the artwork, not about shipping cost, so it
    // survives the estimate being unavailable.
    expect(within(specifications()).getByText(/נשלח תוך 5 ימי עסקים/)).toBeInTheDocument();
  });

  it("omits the return terms rather than stating a window it does not know", () => {
    renderDetail({}, { returnTerms: undefined });

    expect(screen.queryByRole("region", { name: "החזרות וביטול עסקה" })).not.toBeInTheDocument();
    expect(screen.queryByText(/יום להחזרה/)).not.toBeInTheDocument();
  });
});

describe("the shipping line", () => {
  it("joins the estimate and the lead time, and drops whichever is absent", () => {
    expect(shippingLine(shippingRange, 5)).toBe("משלוח מוערך ₪ 45 – ₪ 80 · נשלח תוך 5 ימי עסקים");
    expect(shippingLine(undefined, 5)).toBe("נשלח תוך 5 ימי עסקים");
    expect(shippingLine(shippingRange, null)).toBe("משלוח מוערך ₪ 45 – ₪ 80");
    expect(shippingLine(undefined, null)).toBeNull();
  });
});
