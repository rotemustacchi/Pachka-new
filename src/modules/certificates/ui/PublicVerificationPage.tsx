/**
 * THE public verification page. Not a view of it — the page itself.
 *
 * `app/verify/[identifier]/page.tsx` parses the route params and delegates
 * here; it composes no query of its own and shapes no data. That arrangement is
 * the point, and it is worth being explicit about why, because the obvious
 * alternative looks tidier and is the one that leaks.
 *
 * If the route fetched the certificate and this component only rendered what it
 * was handed, then the fetch and the redaction would live in `app/`, where no
 * test in this module can see them — and a test asserting that
 * `toPublicCertificate()` omits the buyer's name would prove nothing about what
 * the page actually sends to a browser. The page would be free to compose its
 * own query, select a column the projection excludes, and pass it down; the
 * suite would stay green.
 *
 * So the data fetch and the render are one unit, here, and the integration test
 * renders THIS function to markup and greps the output. What the test executes
 * is what the visitor receives.
 *
 * The fetch is `verifyCertificate()`, which rate limits before it parses, and
 * returns a `PublicCertificate` — a type with no field that could carry a buyer
 * detail. `CertificateDocument` accepts nothing else. Three independent
 * mechanisms, none of which is "remember not to".
 */
import type { ReactNode } from "react";
import type { CertificatesDeps } from "../deps";
import { verifyCertificate } from "../verify";
import { CertificateDocument } from "./CertificateDocument";

export interface PublicVerificationPageProps {
  readonly deps: CertificatesDeps;
  /** Straight from the URL segment. Untrusted; may be anything at all. */
  readonly identifier: unknown;
  /**
   * The requesting address, for the rate limit. The route reads it from the
   * request headers — this module does not touch `next/headers`, so it stays
   * renderable in a test without a request context.
   */
  readonly clientIp: string;
  /** See `CertificateDocument`. */
  readonly renderImage?: (image: { src: string; alt: string }) => ReactNode;
}

/**
 * Resolve and render, or raise.
 *
 * An unknown identifier raises `not_found`, which the route turns into Next's
 * 404 — `authenticity-certificate`, *Unknown identifier*. Deliberately NOT
 * caught and rendered as a friendly "no such certificate" page here: that page
 * would be a distinguishable response, and the whole not-found story on this
 * surface depends on malformed, unknown and non-existent identifiers being
 * answered identically.
 */
export async function PublicVerificationPage({
  deps,
  identifier,
  clientIp,
  renderImage,
}: PublicVerificationPageProps) {
  const certificate = await verifyCertificate(deps, { identifier, clientIp });

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <CertificateDocument certificate={certificate} renderImage={renderImage} />
    </main>
  );
}
