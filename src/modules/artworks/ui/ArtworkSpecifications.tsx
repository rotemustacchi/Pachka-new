/**
 * The specification block on the artwork detail page.
 *
 * artwork-listings: every mandatory field "SHALL be shown on the artwork detail
 * page", because the MVP gives a buyer no way to ask the artist a question.
 * This component is where that sentence is kept true, and it is written as a
 * derived list rather than as hand-placed rows so that a field cannot be
 * quietly dropped by an edit to the JSX.
 *
 * Layout and labels follow design/Artwork.dc.html: a "מפרט" heading over
 * label/value rows -- מידות, משקל, חומרים, מסגור, שנת יצירה, שימוש ב-AI.
 *
 * Only logical CSS properties. The document is `dir="rtl"`, the repo lints
 * physical-direction utilities as errors, and the numeric runs here (dimensions,
 * weights) are exactly where a physical margin would look right in Hebrew and
 * break the moment anything renders left-to-right.
 */
import {
  AI_DISCLOSURE_LABEL,
  AI_DISCLOSURE_NO,
  AI_DISCLOSURE_YES,
  framingLabel,
  inventoryLabel,
  leadTimeLabel,
  type PublicArtwork,
} from "../serialize";

export interface ArtworkSpecificationsProps {
  readonly artwork: PublicArtwork;
}

interface SpecRow {
  readonly label: string;
  readonly value: string;
}

/**
 * Build the rows.
 *
 * A row whose value is absent is omitted rather than rendered empty -- but for
 * a published artwork the mandatory ones cannot be absent, so an omission here
 * is visible evidence that something published incomplete. The conditional
 * fields (depth, framing) legitimately do not apply to every medium, which is
 * why the same mechanism serves both.
 */
export function specificationRows(artwork: PublicArtwork): readonly SpecRow[] {
  const rows: SpecRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };

  add("מידות", artwork.dimensionsFormatted);
  add("משקל", artwork.weightFormatted);
  add("חומרים", artwork.materials);
  add("מסגור", framingLabel(artwork.isFramed));
  add("שנת יצירה", artwork.yearCreated === null ? null : String(artwork.yearCreated));
  add("סוג", inventoryLabel(artwork));
  add("אספקה", leadTimeLabel(artwork.leadTimeDays));
  add(
    "ייצור בהזמנה",
    artwork.madeToOrder && artwork.productionLeadTimeDays !== null
      ? `${artwork.productionLeadTimeDays} ימי עסקים`
      : null,
  );

  // The disclosure is always shown, both ways round. "לא" is information a
  // buyer wants; an absent row would leave them guessing whether the question
  // was asked at all.
  rows.push({
    label: AI_DISCLOSURE_LABEL,
    value: artwork.aiAssisted ? AI_DISCLOSURE_YES : AI_DISCLOSURE_NO,
  });

  return rows;
}

export function ArtworkSpecifications({ artwork }: ArtworkSpecificationsProps) {
  const rows = specificationRows(artwork);

  return (
    <section aria-labelledby="artwork-specifications-heading">
      <h2
        id="artwork-specifications-heading"
        className="caps mb-4 text-[13px] tracking-[0.14em] text-ink-soft"
      >
        מפרט
      </h2>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-sm text-ink-muted">{row.label}</dt>
            <dd className="text-base text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
