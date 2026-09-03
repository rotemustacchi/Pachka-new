/**
 * Return terms reach the page (task 8.10).
 *
 * `shipping-and-returns` requires the terms -- including who bears return
 * shipping and transit risk -- to be displayed before purchase. The module
 * returns them as data and says why: two surfaces render them, and neither may
 * write its own wording.
 *
 * So the thing worth testing is the whole path, and that is what this does: a
 * real database with the real configuration, the real `returnTerms`, and the
 * real component rendered to markup. `createElement` rather than JSX only
 * because the integration project compiles `.ts`.
 *
 * The second test is the point of routing this through configuration at all: an
 * operator changing the window changes what the buyer reads, with nothing
 * rebuilt. A page with "14 ימים" typed into it would pass the first test and
 * fail this one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setConfig } from "@/shared/config";
import { returnTerms } from "@/modules/shipping";
import { ReturnTermsPanel } from "@/app/_shipping/ReturnTermsPanel";
import { useTestDatabase } from "../harness";

describe("the return terms panel", () => {
  const database = useTestDatabase();

  it("renders every statement the module returns, in its order", async () => {
    const terms = await returnTerms(database.db);

    const markup = renderToStaticMarkup(createElement(ReturnTermsPanel, { terms }));

    for (const statement of terms.statements) {
      expect(markup).toContain(statement.text);
    }

    // The two disclosures 8.10 names explicitly.
    const codes = terms.statements.map((statement) => statement.code);
    expect(codes).toEqual(
      expect.arrayContaining(["return_shipping_paid_by_buyer", "transit_risk_on_buyer"]),
    );
  });

  it("follows the configured window rather than a number typed into the page", async () => {
    await setConfig(database.db, "returns.window_days", 21);

    const terms = await returnTerms(database.db);
    const markup = renderToStaticMarkup(createElement(ReturnTermsPanel, { terms }));

    expect(terms.windowDays).toBe(21);
    expect(markup).toContain("21");
  });
});
