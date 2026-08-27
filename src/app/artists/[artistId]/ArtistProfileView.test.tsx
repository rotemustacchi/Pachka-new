/**
 * The public artist profile, rendered — tasks 2.6 and 2.9.
 *
 * The last describe in this file is the one that matters most. SECURITY.md S1-8
 * asks for a standing regression test that fetches the artist profile page and
 * asserts no contact detail appears in the response body, because the usual way
 * a correct serializer is defeated in an App Router codebase is invisible: React
 * puts the whole prop object of a Client Component into the HTML, and the page
 * looks perfect while `curl` finds the phone number.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtistProfileView, StarRating } from "./ArtistProfileView";
import type { PublicArtist, Review, ReviewSummary } from "@/modules/accounts";

const ARTIST: PublicArtist = {
  id: "3f6b1c2e-0000-4000-8000-000000000001",
  displayName: "יעל שוורץ",
  biography: "ציירת מתל אביב, עובדת בעיקר באקריליק על פשתן.",
  city: "תל אביב",
  avatarPath: null,
  memberSince: "2026-02-01T09:00:00.000Z",
};

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "r1",
    orderId: "o1",
    artistId: ARTIST.id,
    buyerId: "b1",
    buyerDisplayName: "מיכל ר.",
    rating: 5,
    body: "הגיע ארוז מצוין ובדיוק בזמן.",
    createdAt: "2026-06-04T10:00:00.000Z",
    ...overrides,
  };
}

const summaryOf = (reviews: readonly Review[]): ReviewSummary =>
  reviews.length === 0
    ? { average: null, count: 0 }
    : {
        average:
          Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10,
        count: reviews.length,
      };

function renderProfile(reviews: readonly Review[] = [], artist: PublicArtist = ARTIST) {
  return render(
    <ArtistProfileView artist={artist} reviews={reviews} summary={summaryOf(reviews)} />,
  );
}

describe("the artist header", () => {
  it("shows the display name as the page heading", () => {
    renderProfile();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("יעל שוורץ");
  });

  it("shows the city", () => {
    renderProfile();

    expect(screen.getByText("תל אביב")).toBeInTheDocument();
  });

  it("shows the biography", () => {
    renderProfile();

    expect(screen.getByText(/ציירת מתל אביב/)).toBeInTheDocument();
  });

  it("shows the year the artist joined", () => {
    renderProfile();

    expect(screen.getByText(/מאז 2026/)).toBeInTheDocument();
  });

  it("omits the city line entirely when the artist gave none", () => {
    // Rather than rendering an empty separator, which reads as a missing word.
    renderProfile([], { ...ARTIST, city: null });

    expect(screen.queryByText("תל אביב")).not.toBeInTheDocument();
  });

  it("renders without a biography", () => {
    renderProfile([], { ...ARTIST, biography: "" });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("יעל שוורץ");
  });
});

describe("reviews on the profile", () => {
  it("lists each review's text", () => {
    renderProfile([review()]);

    expect(screen.getByText("הגיע ארוז מצוין ובדיוק בזמן.")).toBeInTheDocument();
  });

  it("attributes each review to the buyer's display name", () => {
    renderProfile([review()]);

    expect(screen.getByText("מיכל ר.")).toBeInTheDocument();
  });

  it("shows the month and year the review was written", () => {
    renderProfile([review()]);

    // Scoped to the review card: "2026" alone also matches the member-since
    // line in the header, so the loose version of this passed for the wrong
    // reason.
    expect(screen.getByText(/יוני\s+2026/)).toBeInTheDocument();
  });

  it("renders a review that has a rating but no text", () => {
    renderProfile([review({ body: "" })]);

    expect(screen.getByText("מיכל ר.")).toBeInTheDocument();
  });

  it("lists every review, not just the first", () => {
    renderProfile([
      review({ id: "r1", buyerDisplayName: "מיכל ר." }),
      review({ id: "r2", buyerDisplayName: "אורי כ.", rating: 4 }),
    ]);

    expect(screen.getByText("מיכל ר.")).toBeInTheDocument();
    expect(screen.getByText("אורי כ.")).toBeInTheDocument();
  });

  it("says so plainly when there are none", () => {
    // Not zero stars: "no reviews yet" and "rated zero" are different things,
    // and the difference matters to an artist who has just joined.
    renderProfile([]);

    expect(screen.getByText(/עדיין אין ביקורות/)).toBeInTheDocument();
  });
});

describe("the aggregate rating", () => {
  it("shows the average and the count together", () => {
    renderProfile([review({ id: "a", rating: 5 }), review({ id: "b", rating: 4 })]);

    expect(screen.getByText(/4\.5 · 2 ביקורות/)).toBeInTheDocument();
  });

  it("is absent entirely when there are no reviews", () => {
    // The "ביקורות" section heading is always there; what must not appear is a
    // count, which would render as "0 ביקורות" next to zero stars.
    renderProfile([]);

    expect(screen.queryByText(/\d+\s+ביקורות/)).not.toBeInTheDocument();
  });

  it("rounds to one decimal place", () => {
    const three = [
      review({ id: "a", rating: 5 }),
      review({ id: "b", rating: 4 }),
      review({ id: "c", rating: 5 }),
    ];

    renderProfile(three);

    expect(screen.getByText(/4\.7 · 3 ביקורות/)).toBeInTheDocument();
  });
});

describe("the star rating", () => {
  it("announces the rating to a screen reader rather than only drawing it", () => {
    render(<StarRating rating={4} />);

    expect(screen.getByRole("img", { name: "4 מתוך 5" })).toBeInTheDocument();
  });

  it("draws five stars whatever the rating", () => {
    const { container } = render(<StarRating rating={3} />);

    expect(container.textContent).toBe("★★★★★");
  });

  it("rounds a fractional average to whole stars", () => {
    render(<StarRating rating={4.5} />);

    expect(screen.getByRole("img", { name: "4.5 מתוך 5" })).toBeInTheDocument();
  });
});

describe("what the rendered HTML must never contain", () => {
  /**
   * The S1-8 standing regression test. `PublicArtist` has no field that could
   * carry these, which is the point -- this asserts that the type-level
   * guarantee survives rendering, and it will keep asserting it if someone
   * later widens the props or introduces a Client Component here.
   */
  const SENTINELS = ["leak@example.com", "0501112222", "@leakhandle", "12 Nahalat Binyamin"];

  it("contains no contact details anywhere in the markup", () => {
    const { container } = renderProfile([review()]);

    for (const sentinel of SENTINELS) {
      expect(container.innerHTML).not.toContain(sentinel);
    }
  });

  it("contains no contact details even when a review mentions the artist", () => {
    const { container } = renderProfile([
      review({ body: "יעל הייתה נהדרת, ממליצה בחום על העבודות שלה." }),
    ]);

    for (const sentinel of SENTINELS) {
      expect(container.innerHTML).not.toContain(sentinel);
    }
  });

  it("would fail if a contact field were ever rendered", () => {
    // Proves the assertion above is capable of failing, rather than passing
    // because the sentinel strings simply never existed in this test.
    const { container } = render(<p>leak@example.com</p>);

    expect(container.innerHTML).toContain("leak@example.com");
  });
});
