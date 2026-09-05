/**
 * The shell every legal page renders inside.
 *
 * WHY THESE PAGES ARE NOT BOILERPLATE
 * -----------------------------------
 * A terms page copied from another shop describes another shop. PACHKA's
 * mechanics are unusual in three ways that a buyer has a legal interest in
 * knowing: the platform holds the buyer's money and settles with the artist by
 * hand after delivery plus the return window; returns route through a PACHKA
 * address so that an artist's home address is never printed on a label; and the
 * certificate of authenticity records the ARTIST'S declaration rather than any
 * verification PACHKA performed. Every sentence in these three documents is
 * traceable to `openspec/changes/pachka-marketplace-mvp/specs/**` or to a key
 * in `src/shared/config/registry.ts`.
 *
 * WHY THE PLACEHOLDERS ARE LOUD RATHER THAN QUIET
 * -----------------------------------------------
 * The facts these documents still lack — the company's registered name and
 * number, the return address, the address for a privacy request, the
 * cancellation-fee decision — cannot be invented. An invented company number is
 * worse than a blank one: a blank is obviously unfinished, while a plausible
 * nine-digit number reads as checked. So `Review` renders a marker that is
 * impossible to miss on the page and trivial to grep for in the source, and
 * `docs/launch-readiness.md` lists every one of them as a launch blocker.
 *
 * The draft banner is part of the same decision. These documents are a
 * faithful description of the system written by an engineer, not legal advice,
 * and until a lawyer has read them the page says so to every visitor.
 */
import type { ReactNode } from "react";

export interface LegalDocumentProps {
  readonly title: string;
  /** One line under the title: what this document governs. */
  readonly summary: string;
  readonly children: ReactNode;
}

export function LegalDocument({ title, summary, children }: LegalDocumentProps) {
  return (
    <article className="mx-auto flex max-w-[68ch] flex-col gap-8 px-5 py-10 sm:px-8 sm:py-16">
      <header className="flex flex-col gap-4">
        <h1 className="m-0 text-[30px] leading-[1.25] font-black text-ink sm:text-[38px]">{title}</h1>
        <p className="m-0 text-[16px] leading-[1.7] font-light text-ink-soft">{summary}</p>
        <DraftBanner />
      </header>
      <div className="flex flex-col gap-9">{children}</div>
    </article>
  );
}

/**
 * Shown to every visitor, deliberately.
 *
 * A site that takes money behind an unreviewed terms page is making a promise
 * it has not checked. Saying so is the honest state of the document today, and
 * removing this banner is the last item on the legal section of the launch
 * checklist rather than a cosmetic tidy-up.
 */
function DraftBanner() {
  return (
    <aside
      role="note"
      data-legal-draft
      className="border border-alert bg-card px-4 py-3 text-[14px] leading-[1.6] text-alert"
    >
      <strong className="font-bold">מסמך טיוטה.</strong> הנוסח שלהלן מתאר את אופן הפעולה של
      PACHKA כפי שהוא ממומש במערכת, אך טרם עבר בדיקה משפטית. אין לראות בו ייעוץ משפטי. הסעיפים
      המסומנים להלן טעונים השלמה לפני שהאתר יגבה תשלום כלשהו.
    </aside>
  );
}

export interface ClauseProps {
  readonly heading: string;
  readonly children: ReactNode;
}

/** One section of a legal document: a heading and its prose. */
export function Clause({ heading, children }: ClauseProps) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-[19px] leading-[1.4] font-bold text-ink sm:text-[21px]">{heading}</h2>
      <div className="flex flex-col gap-3 text-[15px] leading-[1.85] font-light text-ink-soft">
        {children}
      </div>
    </section>
  );
}

/** A bulleted list inside a clause, with the RTL-safe marker position. */
export function Points({ children }: { readonly children: ReactNode }) {
  return <ul className="m-0 flex list-disc flex-col gap-2 ps-5">{children}</ul>;
}

export type Reviewer = "lawyer" | "operator";

const REVIEWER_LABEL: Record<Reviewer, string> = {
  lawyer: "לבדיקת עו״ד",
  operator: "להשלמה על ידי המפעיל",
};

export interface ReviewProps {
  /** Who has to resolve this, and therefore which label is shown. */
  readonly by?: Reviewer;
  /** What exactly is missing. Rendered — a marker with no question is a to-do nobody can action. */
  readonly children: ReactNode;
}

/**
 * The visible marker for a fact this document does not have.
 *
 * `data-review` is what the test and the launch checklist count: a page that
 * quietly loses one of these would otherwise look finished.
 */
export function Review({ by = "lawyer", children }: ReviewProps) {
  return (
    <span
      data-review={by}
      className="inline bg-paper-deep px-1.5 py-0.5 text-[14px] font-medium text-alert"
    >
      [{REVIEWER_LABEL[by]}: {children}]
    </span>
  );
}

/** A number rendered LTR inside Hebrew text. Never render a bare numeral. */
export function Num({ children }: { readonly children: ReactNode }) {
  return <span className="numeric">{children}</span>;
}
