/**
 * The buyer's private copy: the document, plus the one line the public page
 * must never carry.
 *
 * This is the only component in the codebase that renders a certificate and a
 * person's name together. It takes a `BuyerCertificate`, which is produced only
 * by `buyerCertificate()` — a function that resolves the identifier, checks the
 * row's `buyer_id` against the caller, and reads the name back through
 * `orders.buyerOrder()`, whose own query is scoped by buyer.
 *
 * `authenticity-certificate`: the buyer's name appears "only on the certificate
 * document delivered privately to the buyer". The body is the same
 * `CertificateDocument` the public page renders, so the two cannot drift in
 * wording or in what they disclose about the artwork — the difference between
 * them is exactly this one block and nothing else.
 */
import type { ReactNode } from "react";
import type { BuyerCertificate } from "../types";
import { CertificateDocument } from "./CertificateDocument";

export interface BuyerCertificateDocumentProps {
  readonly document: BuyerCertificate;
  /** See `CertificateDocument`. */
  readonly renderImage?: (image: { src: string; alt: string }) => ReactNode;
}

export function BuyerCertificateDocument({
  document,
  renderImage,
}: BuyerCertificateDocumentProps) {
  return (
    <div className="flex flex-col gap-4">
      <CertificateDocument certificate={document.certificate} renderImage={renderImage} />

      <section className="border-t border-rule pt-4" aria-label="הונפקה עבור">
        <dl className="flex justify-between gap-4 text-sm">
          <dt className="text-ink-muted">הונפקה עבור</dt>
          <dd className="text-ink">{document.buyerName}</dd>
        </dl>
      </section>
    </div>
  );
}
