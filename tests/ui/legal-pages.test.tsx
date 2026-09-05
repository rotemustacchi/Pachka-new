/**
 * The three legal pages, and the footer that is the only way to reach them.
 *
 * WHY THE FOOTER CHECK IS THE FIRST TEST
 * --------------------------------------
 * `SiteFooter` shipped linking to `/terms`, `/returns` and `/privacy` before
 * any of the three existed, so every page in the product carried three dead
 * links — the same defect `SiteHeader.test.tsx` was written to catch after the
 * header shipped pointing at `/login` and `/join`. That test guards the header
 * and nothing guarded the footer. This one does, by the same means: read the
 * routes `src/app` actually serves off the filesystem and require every footer
 * href to be one of them.
 *
 * WHY THE CONTENT ASSERTIONS ARE ABOUT SUBSTANCE, NOT RENDERING
 * -------------------------------------------------------------
 * "The terms page renders" is worth almost nothing — a page of lorem ipsum
 * passes it. What makes these documents non-boilerplate is a short list of
 * facts about PACHKA specifically that a template would have got wrong, and
 * that a well-meaning later edit could quietly drop: that PACHKA holds the
 * buyer's money rather than merely introducing the parties, that there is no
 * online payment yet, that an artist's contact details are never disclosed, and
 * that the certificate records a declaration rather than a verification. Those
 * are the things asserted.
 *
 * THE DRAFT DISCLOSURE IS ALSO A TEST
 * -----------------------------------
 * Both pages carry an unreviewed-draft banner and visible markers naming every
 * fact still missing. A page that lost them would look finished, which is the
 * failure worth catching: it is how an invented company number gets in.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "@/shared/ui";
import TermsPage from "@/app/(legal)/terms/page";
import PrivacyPage from "@/app/(legal)/privacy/page";

const APP_DIR = path.join(process.cwd(), "src", "app");

/** Route paths served by a page.tsx, with Next.js route groups `(name)` removed. */
function servedRoutes(dir = APP_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
      found.push(...servedRoutes(full, prefix + segment));
    } else if (entry === "page.tsx") {
      found.push(prefix === "" ? "/" : prefix);
    }
  }
  return found;
}

describe("the footer, which is the only route to the legal pages", () => {
  it("points every link at a route that exists", () => {
    render(<SiteFooter />);
    const routes = new Set(servedRoutes());

    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((href): href is string => href !== null && href.startsWith("/"));

    expect(hrefs.length).toBeGreaterThan(0); // positive control: not vacuous
    for (const href of hrefs) {
      expect(routes, `the footer links to ${href}, which no page.tsx serves`).toContain(href);
    }
  });

  it("reaches all three legal documents", () => {
    render(<SiteFooter />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual(expect.arrayContaining(["/terms", "/privacy", "/returns"]));
  });

  it("finds the routes that do exist, so the checks above cannot pass vacuously", () => {
    const routes = servedRoutes();

    expect(routes).toContain("/terms");
    expect(routes).toContain("/privacy");
    expect(routes).toContain("/returns");
  });
});

describe("the terms of service", () => {
  it("says that PACHKA holds the buyer's money rather than merely introducing the parties", () => {
    render(<TermsPage />);

    // artist-payouts: the platform collects the price and settles with the
    // artist by hand later. A marketplace template says the opposite.
    expect(screen.getByText(/גובה את התשלום מהקונה ומחזיקה בכספו/)).toBeInTheDocument();
  });

  it("discloses that there is no online payment, before a buyer confirms anything", () => {
    render(<TermsPage />);

    // checkout-orders ships a manual adapter: the order is created unpaid and
    // an operator marks it paid. A buyer who learns this after confirming has
    // been misled.
    expect(screen.getByText(/אין כרגע מנגנון סליקה מקוון/)).toBeInTheDocument();
  });

  it("states the commission rule the payouts module actually applies", () => {
    render(<TermsPage />);

    // Commission is on the item subtotal EXCLUDING shipping (artist-payouts).
    expect(screen.getByText(/בלי דמי המשלוח/)).toBeInTheDocument();
  });

  it("states that the certificate records a declaration and not a verification", () => {
    render(<TermsPage />);

    expect(screen.getByText(/פאצ׳קה אינה מאמתת/)).toBeInTheDocument();
  });

  it("states that an artist's contact details are never disclosed, at any stage", () => {
    render(<TermsPage />);

    expect(
      screen.getByText(/אינם מוצגים לקונה בשום שלב — לרבות לאחר שההזמנה סופקה/),
    ).toBeInTheDocument();
  });
});

describe("the privacy policy", () => {
  it("names the buyer data the checkout actually collects", () => {
    render(<PrivacyPage />);

    // checkout-orders collects full name, phone and delivery address.
    expect(screen.getByText(/שם מלא, מספר טלפון וכתובת מסירה/)).toBeInTheDocument();
  });

  it("names the artist bank details the payout ledger actually holds", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/שם בעל החשבון, בנק, סניף ומספר חשבון/)).toBeInTheDocument();
  });

  it("discloses that uploaded images are sent to an external AI provider", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/נשלחת לספק בינה מלאכותית חיצוני/)).toBeInTheDocument();
  });
});

describe("the unfinished state of both documents, which is disclosed rather than hidden", () => {
  it.each([
    ["terms", TermsPage],
    ["privacy", PrivacyPage],
  ])("%s carries the unreviewed-draft banner", (_name, Page) => {
    const { container } = render(<Page />);

    expect(container.querySelector("[data-legal-draft]")).not.toBeNull();
  });

  it.each([
    ["terms", TermsPage],
    ["privacy", PrivacyPage],
  ])("%s marks every missing fact visibly instead of inventing one", (_name, Page) => {
    const { container } = render(<Page />);
    const markers = container.querySelectorAll("[data-review]");

    // If this fails because the markers are gone, the question to ask is
    // whether a lawyer actually answered them or whether someone filled the
    // blanks in with something plausible. An invented company number is worse
    // than a blank one. See docs/launch-readiness.md.
    expect(markers.length).toBeGreaterThan(0);

    for (const marker of markers) {
      // A marker with no question is a to-do nobody can action.
      expect(marker.textContent?.trim().length ?? 0).toBeGreaterThan(20);
    }
  });
});
