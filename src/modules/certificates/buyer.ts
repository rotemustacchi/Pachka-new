/**
 * The buyer's copy — the one document in the system that carries their name.
 *
 * `authenticity-certificate`, as rewritten after the security review: the
 * buyer's name appears "only on the certificate document delivered privately to
 * the buyer, never on the public verification page."
 *
 * WHERE THE NAME COMES FROM, AND WHY IT IS NOT STORED
 * --------------------------------------------------
 * It is read at render time from the order's delivery details, through
 * `orders.buyerOrder()` — which scopes by `buyer_id` in its WHERE clause rather
 * than fetching and then checking. So the name reaches this module only for an
 * order the caller actually placed, and the check is the owning module's, not a
 * second copy of it here.
 *
 * That is deliberate on two counts. It keeps the certificate row free of the
 * name entirely (see the migration, note C2) — a column that does not exist
 * cannot be selected onto a public page by a future refactor. And it honours
 * the boundary as `orders` states it: that module "will never hand you the
 * buyer's address for a fulfilment you do not own, which is the structural half
 * of that." Reading `order_shipping_details` directly with my own buyer_id
 * predicate would reproduce the check while stepping around the guarantee, and
 * a reproduced check is one that can drift.
 */
import { buyerOrder, type OrdersDeps } from "@/modules/orders";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";
import type { BuyerNameSource, CertificatesDeps } from "./deps";
import { certificateNotFound } from "./identifier";
import { certificatesForFulfilment, issueCertificatesForFulfilment, withheldReason } from "./issue";
import { deriveValidity, findCertificateRecord } from "./verify";
import {
  CERTIFICATE_COLUMNS,
  toCertificateRecord,
  toPublicCertificate,
  type BuyerCertificate,
  type CertificateRecord,
  type PublicCertificate,
} from "./types";

/**
 * The real source: `orders.buyerOrder()`, whose own query is scoped by buyer.
 *
 * Built from an `OrdersDeps` the composition root already has, rather than this
 * module constructing one — a `PaymentProvider` has no business being a
 * prerequisite for rendering a certificate, and a second `OrdersDeps` built here
 * would be a second set of that module's settings to keep in step.
 */
export function buyerNamesFromOrders(ordersDeps: OrdersDeps): BuyerNameSource {
  return async (buyerId, orderId) => {
    // Throws `not_found` for an order this buyer did not place. Left to
    // propagate as-is: it is the same answer, from the same module, that any
    // other attempt to read a stranger's order gets.
    const detail = await buyerOrder(ordersDeps, buyerId, orderId);
    return detail.delivery.fullName;
  };
}

function buyerNameSourceFor(deps: CertificatesDeps): BuyerNameSource {
  if (deps.buyerNames === undefined) {
    // Fails closed, loudly. The alternative — rendering the private document
    // with the name omitted or a placeholder — would silently produce a
    // certificate missing content the spec makes mandatory, and it would look
    // fine.
    throw AppError.conflict(
      "No buyer-name source is wired. Pass `buyerNames: buyerNamesFromOrders(ordersDeps)`.",
      { code: "certificates.buyer_names_unwired" },
    );
  }
  return deps.buyerNames;
}

/**
 * Every certificate on one of the buyer's own orders, newest artwork first.
 *
 * Scoped by `buyer_id` in the WHERE clause. A row read here still carries no
 * buyer name — there is no such column — so even a mistake in this predicate
 * could not disclose one person to another.
 */
export async function certificatesForOrder(
  sql: Sql,
  buyerId: string,
  orderId: string,
): Promise<CertificateRecord[]> {
  const { rows } = await sql.query(
    `select ${CERTIFICATE_COLUMNS} from certificates
      where order_id = $1 and buyer_id = $2
      order by issued_at, unit_ordinal`,
    [orderId, buyerId],
  );
  return rows.map((row) => toCertificateRecord(row as never));
}

/** One line of the buyer's order view: a certificate, or why there isn't one yet. */
export interface OrderCertificateEntry {
  readonly fulfilmentId: string;
  /** Empty until the parcel is delivered. */
  readonly certificates: readonly PublicCertificate[];
  /**
   * Why this parcel has no certificates, or `null` when it has them.
   *
   * `authenticity-certificate`, *Certificate withheld before delivery*: "WHEN a
   * buyer views an order that is paid but not yet delivered THEN no certificate
   * is available." The buyer is told which of the three reasons applies, because
   * "no certificate" with no explanation reads as a bug to the person waiting.
   */
  readonly withheld: ReturnType<typeof withheldReason>;
}

/**
 * The buyer's order view, per parcel — and the self-heal.
 *
 * Issuance is a separate step from `orders.confirmDelivery()`, because
 * ARCHITECTURE.md's dependency table points `certificates` at `orders` and not
 * the reverse, so `orders` cannot call it. A separate step can be missed. This
 * function therefore issues anything a delivered fulfilment is owed and does not
 * have, which is safe because issuance is idempotent, and which means a dropped
 * hook costs a page view rather than a buyer's document.
 */
export async function orderCertificates(
  deps: CertificatesDeps,
  buyerId: string,
  orderId: string,
): Promise<readonly OrderCertificateEntry[]> {
  const { rows } = await deps.db.query<{ id: string; status: string }>(
    `select f.id, f.status
       from fulfilments f
       join orders o on o.id = f.order_id
      where f.order_id = $1 and o.buyer_id = $2
      order by f.created_at, f.id`,
    [orderId, buyerId],
  );

  const entries: OrderCertificateEntry[] = [];

  for (const fulfilment of rows) {
    const withheld = withheldReason(fulfilment.status as never);
    if (withheld !== null) {
      entries.push({ fulfilmentId: fulfilment.id, certificates: [], withheld });
      continue;
    }

    await issueCertificatesForFulfilment(deps, fulfilment.id);

    const records = await certificatesForFulfilment(deps.db, fulfilment.id);
    const certificates: PublicCertificate[] = [];
    for (const record of records) {
      certificates.push(toPublicCertificate(record, await deriveValidity(deps.db, record)));
    }

    entries.push({ fulfilmentId: fulfilment.id, certificates, withheld: null });
  }

  return entries;
}

/**
 * One certificate, rendered for the buyer who owns it, name included.
 *
 * The identifier alone is not authority: it is resolved, and then the order it
 * belongs to is read back through `orders` AS THIS BUYER. A buyer holding a
 * stranger's identifier — from a shared link, or a guess — gets the same
 * `not_found` the public path gives for an identifier that does not exist,
 * rather than a certificate with somebody else's name on it.
 */
export async function buyerCertificate(
  deps: CertificatesDeps,
  buyerId: string,
  identifier: unknown,
): Promise<BuyerCertificate> {
  const record =
    typeof identifier === "string" ? await findCertificateRecord(deps.db, identifier.trim()) : null;

  // The ownership check is `record.buyerId !== buyerId`, and it answers with the
  // uniform not-found rather than a forbidden. SECURITY.md S1-18 item 3: a 403
  // confirms the resource exists, which on this surface confirms that a
  // guessed identifier was a real certificate.
  if (record === null || record.buyerId !== buyerId) throw certificateNotFound();

  const buyerName = await buyerNameSourceFor(deps)(buyerId, record.orderId);

  return {
    certificate: toPublicCertificate(record, await deriveValidity(deps.db, record)),
    buyerName,
  };
}
