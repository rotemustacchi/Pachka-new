/**
 * The return terms, rendered (task 8.10).
 *
 * `shipping.returnTerms()` returns them as DATA, and says why: the artwork page
 * belongs to `catalog` and the checkout summary to `orders`, and both render
 * this rather than writing their own wording, so the two screens cannot drift
 * apart or from the configured window. This component is that rendering.
 *
 * It takes the terms as a prop and fetches nothing, so either surface can hand
 * it whatever it already loaded. The statements are rendered in the order the
 * module returns them and none is filtered out — a page that showed four of the
 * seven would be making a disclosure decision, and that decision is the
 * module's. Where the buyer bears the cost and the transit risk is two of those
 * statements, which is the specific thing 8.10 asks to be visible before
 * purchase.
 *
 * WHERE THIS IS MOUNTED. `catalog`'s `ArtworkDetailView` already accepts a
 * `returnTerms` prop of its own and renders them itself, so the artwork page
 * needs only to pass `await returnTerms(db)` — see the report. This panel is
 * for a surface with no view of its own, which today means the checkout
 * summary, owned by `orders`.
 */
import type { ReturnTerms } from "@/modules/shipping";

export interface ReturnTermsPanelProps {
  readonly terms: Pick<ReturnTerms, "windowDays" | "statements">;
  /** @default "h2" */
  readonly headingLevel?: "h2" | "h3";
}

export function ReturnTermsPanel({ terms, headingLevel = "h2" }: ReturnTermsPanelProps) {
  const Heading = headingLevel;

  return (
    <section aria-labelledby="return-terms-heading" className="border border-rule bg-card p-5">
      <Heading id="return-terms-heading" className="m-0 text-base font-bold">
        ביטול והחזרה
      </Heading>

      {/* The window as a number, in its own line, because it is the fact a
          buyer looks for first. `.numeric` keeps Latin digits LTR inside the
          RTL document. */}
      <p className="m-0 mt-2 text-[15px]">
        <span className="numeric font-bold">{terms.windowDays}</span> ימים מיום קבלת היצירה
      </p>

      <ul className="mt-3 flex flex-col gap-2 text-[14px] font-light leading-relaxed text-ink-soft">
        {terms.statements.map((statement) => (
          <li key={statement.code}>{statement.text}</li>
        ))}
      </ul>
    </section>
  );
}
