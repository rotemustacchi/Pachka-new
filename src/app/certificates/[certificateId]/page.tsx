/**
 * /certificates/[certificateId] — the public verification page.
 *
 * THIS ROUTE IS THIN ON PURPOSE, AND THE THINNESS IS THE SECURITY CONTROL
 * ----------------------------------------------------------------------
 * `PublicVerificationPage` is the page, not a view of it: it fetches AND
 * renders. Its own header explains why the obvious alternative is the one that
 * leaks — if this route fetched the certificate and the module only rendered
 * what it was handed, the fetch and the redaction would live here, where no
 * test in that module can see them, and a test asserting that the projection
 * omits the buyer's name would prove nothing about what the page sends to a
 * browser. The route would be free to compose its own query, select a column
 * the projection excludes, and pass it down, with the suite still green.
 *
 * So this file composes no query and shapes no data. It reads two things off
 * the request and hands them over.
 *
 * THE BUYER'S NAME IS NOT HERE, AND CANNOT BE PUT HERE
 * ---------------------------------------------------
 * The spec originally put a buyer's name on a publicly-resolvable page, which
 * publishes a purchase record naming a private individual; the security review
 * caught it (SECURITY.md S0-6, SPEC-B) and the spec was rewritten. The
 * enforcement is fourfold and none of it is "remember not to": there is no
 * buyer-name column, `PublicCertificate` has no field a buyer detail could
 * travel in, `CertificateDocument` accepts nothing else, and the table has no
 * `anon` grant at all.
 *
 * A VOID CERTIFICATE IS RENDERED AS VOID
 * --------------------------------------
 * Not as missing. A returned or cancelled sale still has a certificate, and its
 * document says so on its face — telling someone holding a voided certificate
 * that no such certificate exists would be a worse answer than the truth, and
 * would make the not-found response mean two different things.
 *
 * An UNKNOWN identifier is a different matter and is deliberately not caught
 * and rendered as a friendly "no such certificate" page: that page would be a
 * distinguishable response, and the whole not-found story here depends on
 * malformed, unknown and non-existent identifiers being answered identically.
 *
 * KNOWN LIMITATION, REPORTED RATHER THAN PATCHED
 * ----------------------------------------------
 * `verifyCertificate` rate limits before it parses and raises `rate_limited`,
 * which is a 429. A Next.js page cannot set a status code, so a refused caller
 * gets the module's own message with a 200 behind it. Returning a true 429
 * would mean serving this from a Route Handler and giving up the site layout,
 * which is a routing-shape decision rather than this route's to make.
 */
import { notFound } from "next/navigation";
import { PublicVerificationPage } from "@/modules/certificates";
import { isAppError } from "@/shared/errors";
import { getDatabase } from "@/shared/db";
import { certificatesDeps } from "@/app/_lib/deps";
import { renderCertificateImage } from "@/app/_lib/images";
import { clientIp } from "@/app/_lib/request";

export const dynamic = "force-dynamic";
export const metadata = { title: "אימות תעודת מקוריות — פאצ׳קה" };

interface PageProps {
  /** Untrusted. May be anything at all; the module parses it. */
  readonly params: Promise<{ readonly certificateId: string }>;
}

export default async function CertificateVerificationPage({ params }: PageProps) {
  const { certificateId } = await params;

  try {
    return await PublicVerificationPage({
      deps: certificatesDeps(getDatabase()),
      identifier: certificateId,
      clientIp: await clientIp(),
      renderImage: renderCertificateImage,
    });
  } catch (error) {
    if (isAppError(error) && error.kind === "not_found") notFound();
    if (isAppError(error) && error.kind === "rate_limited") {
      return (
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
          <p role="alert" className="m-0 text-[15px] text-ink">
            {error.message}
          </p>
        </main>
      );
    }
    throw error;
  }
}
