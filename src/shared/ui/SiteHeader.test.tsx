import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteHeader } from "./SiteHeader";

/**
 * Every link in the primary nav must resolve to a real route.
 *
 * This exists because the header shipped pointing at `/login`, `/artists` and
 * `/join`, none of which were ever created — the sign-in route is `/sign-in`.
 * A dead link in the header is on every page in the product, so it is the most
 * visible defect the app can have, and nothing was checking for it.
 */
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

describe("SiteHeader", () => {
  it("points every link at a route that exists", () => {
    render(<SiteHeader />);
    const routes = new Set(servedRoutes());

    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((href): href is string => href !== null && href.startsWith("/"));

    expect(hrefs.length).toBeGreaterThan(0); // positive control: not vacuous
    for (const href of hrefs) {
      expect(routes, `header links to ${href}, which no page.tsx serves`).toContain(href);
    }
  });

  it("finds the routes that do exist, so the check above cannot pass vacuously", () => {
    const routes = servedRoutes();
    expect(routes).toContain("/");
    expect(routes).toContain("/sign-in");
  });
});
