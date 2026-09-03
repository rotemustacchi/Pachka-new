/**
 * The certificate itself, as a document.
 *
 * THE PROP TYPE IS THE PRIVACY CONTROL
 * ------------------------------------
 * This component accepts a `PublicCertificate` and NOTHING ELSE. There is no
 * `buyerName` prop, no `order` prop, no escape hatch — so no composition of
 * this component can render a buyer's name, however the page around it is
 * written. `authenticity-certificate` requires the public verification page to
 * show "the artwork, artist, medium, dimensions, edition information, sale date
 * and validity — and SHALL NOT display the buyer's name or any other buyer
 * detail", and the way to keep that true a year from now is to make the
 * violating render impossible to express rather than to remember not to write
 * it.
 *
 * The buyer's copy is `BuyerCertificateDocument`, which wraps this one and adds
 * the name above it. That is the only place in the codebase where a certificate
 * and a person appear together.
 *
 * THE DECLARATION IS NOT SMALL PRINT
 * ----------------------------------
 * `declaration.ts` explains at length why. Mechanically: the declaration
 * renders as a titled section of the document body, in the body text size, in
 * the ordinary flow — not a footnote, not a tooltip, not collapsed. PACHKA is
 * putting its name on a document about an object it has never seen, and the
 * sentence that says so is load-bearing content.
 */
import type { ReactNode } from "react";
import { Card, SectionHeading } from "@/shared/ui";
import {
  ARTIST_DECLARATION_HEADING,
  CERTIFICATE_TITLE,
  VALID_STATEMENT,
  VOID_STATEMENT,
} from "../declaration";
import type { PublicCertificate } from "../types";

export interface CertificateDocumentProps {
  readonly certificate: PublicCertificate;
  /**
   * How to render the artwork image.
   *
   * Injected rather than chosen here, for the reason `ArtworkCard` gives:
   * `next/image` needs a loader configured for the Supabase Storage bucket,
   * which is the app's decision and not this module's. Optional here — unlike
   * on the card — because a certificate with no picture is still a valid
   * certificate, and a document that refused to render without one would fail
   * on exactly the sales where the artist's upload went wrong.
   */
  readonly renderImage?: (image: { src: string; alt: string }) => ReactNode;
}

/** One label-and-value line of the specification list. */
function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

export function CertificateDocument({ certificate, renderImage }: CertificateDocumentProps) {
  const {
    title,
    artistDisplayName,
    mediumLabel,
    dimensions,
    materials,
    yearCreated,
    editionStatement,
    saleDate,
    imagePath,
    identifier,
    validity,
    declaration,
  } = certificate;

  return (
    <article className="flex flex-col gap-6" aria-label={CERTIFICATE_TITLE}>
      <header className="flex flex-col gap-2">
        <SectionHeading>{CERTIFICATE_TITLE}</SectionHeading>
        {/*
          Validity, stated in words rather than only as a colour or a chip. A
          void certificate that differed from a valid one only by a grey tint
          would be indistinguishable in a photocopy, a screenshot, or to a
          screen reader -- and this document exists to be shown to third
          parties in exactly those forms.
        */}
        <p className={validity === "void" ? "text-base font-bold text-ink" : "text-sm text-ink-muted"}>
          {validity === "void" ? VOID_STATEMENT : VALID_STATEMENT}
        </p>
      </header>

      {imagePath && renderImage ? (
        <div className="aspect-[4/5] w-full overflow-hidden bg-paper-deep">
          {renderImage({ src: imagePath, alt: title })}
        </div>
      ) : null}

      <Card className="p-5">
        <dl className="flex flex-col gap-2 text-sm">
          <Field label="שם היצירה" value={title} />
          <Field label="האמן/ית" value={artistDisplayName} />
          <Field label="טכניקה" value={mediumLabel} />
          {dimensions === null ? null : <Field label="מידות" value={dimensions} />}
          {materials === null ? null : <Field label="חומרים" value={materials} />}
          {yearCreated === null ? null : <Field label="שנת יצירה" value={String(yearCreated)} />}
          <Field label="מהדורה" value={editionStatement} />
          <Field label="תאריך המכירה" value={new Date(saleDate).toLocaleDateString("he-IL")} />
          <Field label="מספר תעודה" value={identifier} />
        </dl>
      </Card>

      {/*
        The liability boundary. Rendered as a section of the document, at body
        size, always -- see the file header and declaration.ts.
      */}
      <section className="flex flex-col gap-2 border-t border-rule pt-4" aria-label={ARTIST_DECLARATION_HEADING}>
        <h3 className="text-base font-bold text-ink">{ARTIST_DECLARATION_HEADING}</h3>
        {declaration.map((statement) => (
          <p key={statement} className="text-sm text-ink">
            {statement}
          </p>
        ))}
      </section>
    </article>
  );
}
