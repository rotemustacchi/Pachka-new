/**
 * The two surfaces the AI-assistance disclosure has to appear on, and the
 * specification block a buyer reads instead of asking a question.
 *
 * Rendered for real and asserted through the accessible tree, not through
 * class names -- what matters is that a buyer can read the disclosure, not that
 * a particular span exists.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AI_ASSISTED_LABEL, type PublicArtwork } from "../serialize";
import { AiAssistedLabel } from "./AiAssistedLabel";
import { ArtworkCard } from "./ArtworkCard";
import { ArtworkSpecifications, specificationRows } from "./ArtworkSpecifications";
import { DeclarationsStep } from "./DeclarationsStep";

/**
 * The image renderer the app supplies in production (a configured `next/image`).
 * Here it is a plain element, so the card's own behaviour is what is under test
 * rather than an image loader's.
 */
/* eslint-disable @next/next/no-img-element -- this IS the loader seam:
   ArtworkCard takes `renderImage` precisely so the module never picks an image
   strategy, and a test supplying a plain element is the point of that prop. */
const renderImage = ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />;
/* eslint-enable @next/next/no-img-element */

function artwork(overrides: Partial<PublicArtwork> = {}): PublicArtwork {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    artistId: "22222222-2222-4222-8222-222222222222",
    status: "published",
    statusLabel: "מפורסם",
    title: "קו החוף, שקיעה",
    description: "ציור שנעשה בחוף פולג.",
    priceAgorot: 125_000 as PublicArtwork["priceAgorot"],
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
    targetSpaces: [],
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
        id: "img-1",
        displayPath: "art/display.jpg",
        thumbnailPath: null,
        altText: "ציור של קו החוף",
        isPrimary: true,
      },
    ],
    publishedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("the AI-assistance label", () => {
  it("appears when the artist declared AI assistance", () => {
    render(<AiAssistedLabel aiAssisted={true} />);

    expect(screen.getByText(AI_ASSISTED_LABEL)).toBeInTheDocument();
  });

  it("does not appear when the artist declared none", () => {
    const { container } = render(<AiAssistedLabel aiAssisted={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * `null` cannot reach a published artwork -- an unanswered question blocks
   * publication -- but rendering nothing is the safe behaviour if one somehow
   * did, because a label claiming "no AI" on an unanswered artwork would be a
   * false disclosure rather than a missing one.
   */
  it("does not appear when the question was never answered", () => {
    const { container } = render(<AiAssistedLabel aiAssisted={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("the artwork card", () => {
  /** artwork-listings: the label appears "on the artwork card and detail page". */
  it("carries the label when AI assistance was declared", () => {
    render(
      <ArtworkCard
        artwork={artwork({ aiAssisted: true })}
        artistName="יעל שוורץ"
        renderImage={renderImage}
      />,
    );

    expect(screen.getByText(AI_ASSISTED_LABEL)).toBeInTheDocument();
  });

  it("shows the title, the artist and the price", () => {
    render(<ArtworkCard artwork={artwork()} artistName="יעל שוורץ" renderImage={renderImage} />);

    expect(screen.getByRole("heading", { name: "קו החוף, שקיעה" })).toBeInTheDocument();
    expect(screen.getByText("יעל שוורץ")).toBeInTheDocument();
    expect(screen.getByText("₪1,250.00")).toBeInTheDocument();
  });

  it("shows no label when no AI assistance was declared", () => {
    render(<ArtworkCard artwork={artwork()} artistName="יעל שוורץ" renderImage={renderImage} />);

    expect(screen.queryByText(AI_ASSISTED_LABEL)).not.toBeInTheDocument();
  });

  /**
   * catalog-browse: a sold artwork renders read-only with no purchase action.
   * Keyed off derived sold-out rather than the status, so an edition whose last
   * unit is held by an in-progress checkout does not advertise itself as
   * available and then refuse the buyer on the detail page.
   */
  it("marks a sold-out artwork and offers no purchase control", () => {
    render(
      <ArtworkCard
        artwork={artwork({ soldOut: true, purchasable: false, availableUnits: 0 })}
        artistName="יעל שוורץ"
        renderImage={renderImage}
      />,
    );

    expect(screen.getByText("נמכר")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("the specification block", () => {
  /** artwork-listings: "Specifications rendered to buyers". */
  it("shows dimensions, weight, materials, framing and lead time", () => {
    render(<ArtworkSpecifications artwork={artwork()} />);

    expect(screen.getByText("100 × 70 ס״מ")).toBeInTheDocument();
    expect(screen.getByText("1,850 גרם")).toBeInTheDocument();
    expect(screen.getByText("אקריליק על בד פשתן")).toBeInTheDocument();
    expect(screen.getByText("ממוסגר, מוכן לתלייה")).toBeInTheDocument();
    expect(screen.getByText("נשלח תוך 5 ימי עסקים")).toBeInTheDocument();
  });

  /**
   * Both ways round. "לא" is information a buyer wants, and an absent row would
   * leave them guessing whether the question was asked at all.
   */
  it("states the AI answer whichever way it went", () => {
    const { unmount } = render(<ArtworkSpecifications artwork={artwork()} />);
    expect(screen.getByText("שימוש ב-AI")).toBeInTheDocument();
    expect(screen.getByText("לא")).toBeInTheDocument();
    unmount();

    render(<ArtworkSpecifications artwork={artwork({ aiAssisted: true })} />);
    expect(screen.getByText(/בינה מלאכותית/)).toBeInTheDocument();
  });

  it("omits the framing row for a medium where framing does not apply", () => {
    const ring = artwork({
      isFramed: null,
      medium: { value: "jewelry", label: "תכשיטים" },
    });

    expect(specificationRows(ring).map((row) => row.label)).not.toContain("מסגור");
  });

  it("describes an edition by its declared size", () => {
    const edition = artwork({ inventoryType: "edition", stock: 10, availableUnits: 9 });

    expect(specificationRows(edition)).toContainEqual({ label: "סוג", value: "מהדורה מתוך 10" });
  });
});

describe("the declarations step", () => {
  /**
   * The three-state AI question, as controls. An unticked checkbox would be
   * indistinguishable from an unanswered question and would silently answer
   * "no" for every artist who never scrolled this far.
   */
  it("leaves both AI answers unselected until the artist picks one", () => {
    render(
      <DeclarationsStep
        affirmsOriginality={false}
        onOriginalityChange={() => {}}
        aiAssisted={null}
        onAiAssistedChange={() => {}}
      />,
    );

    expect(screen.getByRole("radio", { name: "כן" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "לא" })).not.toBeChecked();
  });

  it("shows 'no' as a real, selected answer rather than an absence", () => {
    render(
      <DeclarationsStep
        affirmsOriginality={true}
        onOriginalityChange={() => {}}
        aiAssisted={false}
        onAiAssistedChange={() => {}}
      />,
    );

    expect(screen.getByRole("radio", { name: "לא" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "כן" })).not.toBeChecked();
  });

  it("states both halves of the originality affirmation", () => {
    render(
      <DeclarationsStep
        affirmsOriginality={false}
        onOriginalityChange={() => {}}
        aiAssisted={null}
        onAiAssistedChange={() => {}}
      />,
    );

    const affirmation = screen.getByRole("checkbox");
    expect(affirmation).not.toBeChecked();
    expect(screen.getByText(/יצירה מקורית שלי/)).toBeInTheDocument();
    expect(screen.getByText(/זכויות היוצרים/)).toBeInTheDocument();
  });
});
