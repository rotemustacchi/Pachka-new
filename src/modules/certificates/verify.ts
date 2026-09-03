/**
 * The public verification path: identifier in, redacted projection out.
 *
 * `authenticity-certificate`, *Public verification does not name the buyer*:
 * "the page displays the artwork, artist, medium, dimensions, edition
 * information, sale date and validity — and SHALL NOT display the buyer's name
 * or any other buyer detail."
 *
 * THIS FUNCTION IS THE ONLY WAY A CERTIFICATE REACHES AN ANONYMOUS READER
 * ----------------------------------------------------------------------
 * `certificates` has no `anon` SELECT policy and no `anon` grant, so there is no
 * second path: an anonymous client cannot read the table over the PostgREST data
 * API at all. SECURITY.md S0-6 item 2 is explicit that the obvious
 * implementation — an anon read policy so the page can query the table — hands
 * the whole table over in one request to anyone holding the anon key, which by
 * design ships in the browser bundle. The public page is therefore a SERVER
 * route calling this function on the privileged connection.
 *
 * The return type is `PublicCertificate`, which has no field that could carry a
 * buyer's name, order id or account id. That is the control: not a redaction
 * step applied on the way out, but a shape with nowhere to put the thing.
 *
 * THE THREE REFUSALS ARE ONE REFUSAL
 * ----------------------------------
 * A malformed identifier, an unknown identifier and a well-formed identifier
 * that does not exist all produce the identical `not_found` from
 * `certificateNotFound()`. SECURITY.md S0-6 item 5 requires exactly that — "no
 * timing or wording difference" — because a distinguishable answer tells an
 * enumerator which of their guesses were at least the right shape, which is most
 * of what they need in order to stop wasting requests.
 */
import type { Sql } from "@/shared/db";
import { certificateNotFound, parseCertificateIdentifier } from "./identifier";
import { consumeVerificationAttempt } from "./rate-limit";
import { verificationLimitFor, type CertificatesDeps } from "./deps";
import {
  CERTIFICATE_COLUMNS,
  toCertificateRecord,
  toPublicCertificate,
  type CertificateRecord,
  type CertificateValidity,
  type PublicCertificate,
} from "./types";

/**
 * Whether the sale behind a certificate still stands.
 *
 * DERIVED, NEVER STORED — the migration's note C3 and SECURITY.md S0-6 item 4.
 * A certificate whose sale is reversed shows as void; the row is not edited and
 * not deleted, because "a generated certificate SHALL NOT be modifiable" and
 * because a buyer at resale needs to tell a void certificate from one that was
 * never issued.
 *
 * Two conditions, and the second is the precise one:
 *
 *  - The fulfilment reached `returned` or `cancelled`. This is `orders` data,
 *    which this module may read.
 *
 *  - A return case for THIS artwork on THIS fulfilment completed in the buyer's
 *    favour. A fulfilment can carry several artworks while a return case is
 *    opened per artwork (`returns_one_per_fulfilment_artwork`), so the
 *    fulfilment-level status alone would void the certificate of a piece the
 *    buyer kept. `received_intact` is the operator confirming the piece came
 *    back undamaged and releasing the refund; `resolved_refunded` is an admin
 *    resolving a disputed case the same way. `resolved_denied` is not here: a
 *    denied return means the buyer kept the work and the sale stands.
 *
 * ARCHITECTURE NOTE, REPORTED RATHER THAN RESOLVED SILENTLY. The second
 * condition reads `returns`, which `shipping` owns, and the dependency table
 * gives `certificates` an edge to `orders` and `artworks` but not to `shipping`.
 * This is a READ of a table this module has a foreign key path to, never a
 * write, and no `shipping` code is imported — but the edge is not in the table
 * and the lead architect is told so rather than the gap being papered over.
 * The alternative, voiding on fulfilment status alone, is wrong in a way that
 * shows on a real document: it would stamp VOID on the certificate of a
 * painting its owner still has on the wall.
 */
export async function deriveValidity(
  sql: Sql,
  record: CertificateRecord,
): Promise<CertificateValidity> {
  const row = await sql.one<{ voided: boolean }>(
    `select (
       exists (
         select 1 from fulfilments f
          where f.id = $1 and f.status in ('returned', 'cancelled')
       )
       or exists (
         select 1 from returns r
          where r.fulfilment_id = $1
            and r.artwork_id = $2
            and r.status in ('received_intact', 'resolved_refunded')
       )
     ) as voided`,
    [record.fulfilmentId, record.artworkId],
  );
  return row.voided ? "void" : "valid";
}

/** Read one certificate by its identifier. Internal: the row, not the projection. */
export async function findCertificateRecord(
  sql: Sql,
  identifier: string,
): Promise<CertificateRecord | null> {
  const row = await sql.maybeOne(
    `select ${CERTIFICATE_COLUMNS} from certificates where id = $1`,
    [identifier],
  );
  return row === null ? null : toCertificateRecord(row as never);
}

export interface VerifyCertificateRequest {
  /** Straight from the URL. Untrusted, unvalidated, possibly not a uuid at all. */
  readonly identifier: unknown;
  /**
   * The client's address, for the rate limit. Required — not optional with a
   * fallback, because an optional value gets omitted at exactly one call site
   * and that call site becomes the unlimited one.
   */
  readonly clientIp: string;
}

/**
 * Resolve an identifier for an anonymous visitor.
 *
 * Rate limit FIRST, before the identifier is even parsed. SECURITY.md requires
 * the limit "enforced server-side before the expensive work", and there is a
 * sharper reason here: an enumerator's requests are precisely the ones that
 * fail, so a limiter placed after the lookup would throttle only the legitimate
 * holder who found their certificate.
 */
export async function verifyCertificate(
  deps: CertificatesDeps,
  request: VerifyCertificateRequest,
): Promise<PublicCertificate> {
  await consumeVerificationAttempt(deps.db, request.clientIp, verificationLimitFor(deps));

  const identifier = parseCertificateIdentifier(request.identifier);
  if (identifier === null) throw certificateNotFound();

  const record = await findCertificateRecord(deps.db, identifier);
  if (record === null) throw certificateNotFound();

  return toPublicCertificate(record, await deriveValidity(deps.db, record));
}
