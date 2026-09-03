/**
 * Issuing certificates.
 *
 * `authenticity-certificate`: "The system SHALL generate a certificate for each
 * fulfilment when it reaches `delivered` ... One certificate SHALL be generated
 * per artwork unit sold." An order containing two artworks therefore produces
 * two certificates, and a paid-but-undelivered order produces none.
 *
 * WHY DELIVERY AND NOT PAYMENT
 * ----------------------------
 * A certificate is a statement that a specific person now owns a specific
 * object. Before delivery nobody owns anything yet — the parcel may be lost,
 * the order may be cancelled, the artist may never dispatch. Issuing at payment
 * would put a document into the world asserting a transfer that had not
 * happened, and the document is immutable, so it could not be taken back.
 * `withheldReason()` below is the read side of the same rule.
 *
 * WHY THIS IS NOT CALLED BY `orders`
 * ----------------------------------
 * ARCHITECTURE.md's dependency table points `certificates` at `orders`, not the
 * reverse. `orders.confirmDelivery()` cannot call this function without
 * inverting that edge. So the composition root calls `confirmDelivery` and then
 * calls this, in that order — see the note in `index.ts` about the `src/app`
 * wiring this module needs and does not own.
 *
 * That makes issuance a separate step that could be skipped, so it is written
 * to be safe to call at any time and any number of times: it refuses a
 * fulfilment that is not delivered, and it is idempotent for one that is. The
 * buyer's order view calls it too (`ensureCertificatesForOrder`), which means a
 * missed hook self-heals on the next page view rather than leaving a buyer
 * without the document they were promised.
 */
import {
  FULFILMENT_COLUMNS,
  ORDER_COLUMNS,
  ORDER_ITEM_COLUMNS,
  toFulfilment,
  toOrder,
  toOrderItem,
  type Fulfilment,
  type FulfilmentRow,
  type Order,
  type OrderItem,
  type OrderItemRow,
  type OrderRow,
} from "@/modules/orders";
import { imagesFor, lockArtworkForUpdate, toPublicImages, type Artwork } from "@/modules/artworks";
import type { Sql, Tx } from "@/shared/db";
import { AppError } from "@/shared/errors";
import { artistNameSourceFor, type CertificatesDeps } from "./deps";
import { DECLARATION_VERSION } from "./declaration";
import { newCertificateIdentifier } from "./identifier";
import {
  CERTIFICATE_COLUMNS,
  toCertificateRecord,
  type CertificateRecord,
  type CertificateRow,
} from "./types";

/**
 * Why a fulfilment has no certificates yet, or `null` if it should have them.
 *
 * A string rather than a boolean because the buyer's order view says something
 * different for each case, and because "no certificate" with no explanation
 * reads as a bug to the person waiting for one.
 */
export type WithheldReason = "not_delivered" | "cancelled" | "returned";

export function withheldReason(status: Fulfilment["status"]): WithheldReason | null {
  if (status === "delivered") return null;
  if (status === "cancelled") return "cancelled";
  if (status === "returned" || status === "return_requested") return "returned";
  return "not_delivered";
}

async function readFulfilment(sql: Sql, fulfilmentId: string): Promise<Fulfilment | null> {
  const row = await sql.maybeOne<FulfilmentRow>(
    `select ${FULFILMENT_COLUMNS} from fulfilments where id = $1`,
    [fulfilmentId],
  );
  return row === null ? null : toFulfilment(row);
}

async function readOrder(sql: Sql, orderId: string): Promise<Order> {
  const row = await sql.one<OrderRow>(`select ${ORDER_COLUMNS} from orders where id = $1`, [
    orderId,
  ]);
  return toOrder(row);
}

async function readItems(sql: Sql, fulfilmentId: string): Promise<OrderItem[]> {
  const { rows } = await sql.query<OrderItemRow>(
    `select ${ORDER_ITEM_COLUMNS} from order_items where fulfilment_id = $1 order by created_at, id`,
    [fulfilmentId],
  );
  return rows.map(toOrderItem);
}

/** Certificates already issued against a fulfilment. */
export async function certificatesForFulfilment(
  sql: Sql,
  fulfilmentId: string,
): Promise<CertificateRecord[]> {
  const { rows } = await sql.query<CertificateRow>(
    `select ${CERTIFICATE_COLUMNS} from certificates
      where fulfilment_id = $1
      order by artwork_id, unit_ordinal`,
    [fulfilmentId],
  );
  return rows.map(toCertificateRecord);
}

/**
 * The next free position in this artwork's edition.
 *
 * Nothing in `artworks` numbers individual units — `stock` is the DECLARED
 * edition size, not a live count — so the position is assigned here, as one
 * more than the highest already issued. Correct only because the caller holds
 * the artwork's row lock: two deliveries of the same edition landing together
 * would otherwise both read the same maximum and collide on
 * `certificates_one_per_edition_position`. The lock makes them queue instead,
 * and the constraint is still there in case a future caller forgets it.
 */
async function nextEditionPosition(tx: Tx, artworkId: string): Promise<number> {
  const row = await tx.one<{ next: string }>(
    `select coalesce(max(edition_position), 0) + 1 as next
       from certificates where artwork_id = $1`,
    [artworkId],
  );
  return Number(row.next);
}

/**
 * The artwork facts, as they are at this moment, for snapshotting.
 *
 * `lockArtworkForUpdate` rather than a plain read, for two reasons: it
 * serialises edition numbering (above), and it is the lock `orders` and
 * `artworks` already take on this row, so this module is not introducing a
 * second lock order that could deadlock against the first.
 */
async function snapshotSource(
  tx: Tx,
  artworkId: string,
): Promise<{ artwork: Artwork; imagePath: string | null }> {
  const artwork = await lockArtworkForUpdate(tx, artworkId);
  if (artwork === null) {
    // The FK makes this unreachable in practice. Kept as a real error rather
    // than a non-null assertion, because the alternative is a certificate with
    // an empty title and no way to tell where it came from.
    throw AppError.conflict("The artwork this certificate would describe no longer exists.", {
      code: "certificates.artwork_missing",
      details: { artworkId },
    });
  }

  const images = toPublicImages(await imagesFor(tx, artworkId));
  const primary = images.find((image) => image.isPrimary) ?? images[0] ?? null;

  return { artwork, imagePath: primary === null ? null : primary.displayPath };
}

export interface IssueCertificatesResult {
  /** Every certificate the fulfilment now has — the ones just issued and the ones it already had. */
  readonly certificates: readonly CertificateRecord[];
  /** How many rows this call actually inserted. Zero on a repeat call. */
  readonly issuedCount: number;
}

/**
 * Issue every certificate a delivered fulfilment is owed.
 *
 * Idempotent: `certificates_one_per_unit` is the guarantee, and the insert asks
 * for `on conflict do nothing`, so a retry after a timeout — or a second call
 * from the order view a moment after the delivery hook — adds nothing and
 * raises nothing. That is what lets the same function be the delivery hook and
 * the self-heal.
 *
 * Refuses a fulfilment that has not reached `delivered`. Not silently returning
 * empty: a caller that asked to issue certificates for an undelivered
 * fulfilment has a bug, and the buyer-facing "is one available yet" question is
 * answered by `withheldReason` without calling this at all.
 */
export async function issueCertificatesForFulfilment(
  deps: CertificatesDeps,
  fulfilmentId: string,
): Promise<IssueCertificatesResult> {
  return deps.db.withTransaction(async (tx) => {
    const fulfilment = await readFulfilment(tx, fulfilmentId);
    if (fulfilment === null) {
      throw AppError.notFound("Fulfilment not found", {
        code: "certificates.fulfilment_not_found",
        details: { fulfilmentId },
      });
    }

    const reason = withheldReason(fulfilment.status);
    if (reason !== null) {
      throw AppError.conflict(
        "A certificate is issued when the fulfilment is delivered, and not before.",
        {
          code: "certificates.not_delivered",
          details: { fulfilmentId, status: fulfilment.status, reason },
        },
      );
    }

    const order = await readOrder(tx, fulfilment.orderId);
    const items = await readItems(tx, fulfilmentId);
    const existing = await certificatesForFulfilment(tx, fulfilmentId);

    // `delivered_at` is stamped by the state machine when the fulfilment moved.
    // Falling back to the order's own timestamp would be inventing a date on a
    // document whose whole purpose is to record one, so it is a hard error.
    const deliveredAt = fulfilment.deliveredAt;
    if (deliveredAt === null) {
      throw AppError.conflict("A delivered fulfilment with no delivery timestamp cannot be certified.", {
        code: "certificates.delivery_date_missing",
        details: { fulfilmentId },
      });
    }

    const artistDisplayName = await artistNameSourceFor(deps)(tx, fulfilment.artistId);

    let issuedCount = 0;

    for (const item of items) {
      const alreadyIssued = existing.filter((c) => c.artworkId === item.artworkId).length;
      if (alreadyIssued >= item.quantity) continue;

      const { artwork, imagePath } = await snapshotSource(tx, item.artworkId);

      for (let ordinal = alreadyIssued + 1; ordinal <= item.quantity; ordinal += 1) {
        const isEdition = artwork.inventoryType === "edition";
        const editionPosition = isEdition ? await nextEditionPosition(tx, item.artworkId) : null;

        const inserted = await insertCertificate(tx, {
          id: newCertificateIdentifier(),
          orderId: order.id,
          fulfilmentId,
          artworkId: item.artworkId,
          artistId: fulfilment.artistId,
          buyerId: order.buyerId,
          unitOrdinal: ordinal,
          inventoryType: artwork.inventoryType,
          editionPosition,
          editionSize: isEdition ? artwork.stock : null,
          // `title_snapshot` on the order item is the title as it was when
          // bought, which is the same instant this document is about; the
          // artwork's current title is the fallback for an older row.
          title: item.titleSnapshot ?? artwork.title ?? "",
          artistDisplayName,
          medium: artwork.medium ?? "",
          heightMm: artwork.heightMm,
          widthMm: artwork.widthMm,
          depthMm: artwork.depthMm,
          materials: artwork.materials,
          yearCreated: artwork.yearCreated,
          // An artwork cannot be published, and so cannot be sold, with the AI
          // question unanswered — the publish constraint says so. `?? false`
          // is therefore unreachable, and is a false rather than a throw
          // because refusing to certify a delivered sale over a null would
          // punish the buyer for the platform's data problem.
          aiAssisted: artwork.aiAssisted ?? false,
          imagePath,
          soldAt: order.placedAt,
          deliveredAt,
        });

        if (inserted) issuedCount += 1;
      }
    }

    return { certificates: await certificatesForFulfilment(tx, fulfilmentId), issuedCount };
  });
}

interface InsertInput {
  readonly id: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly artistId: string;
  readonly buyerId: string;
  readonly unitOrdinal: number;
  readonly inventoryType: "unique" | "edition";
  readonly editionPosition: number | null;
  readonly editionSize: number | null;
  readonly title: string;
  readonly artistDisplayName: string;
  readonly medium: string;
  readonly heightMm: number | null;
  readonly widthMm: number | null;
  readonly depthMm: number | null;
  readonly materials: string | null;
  readonly yearCreated: number | null;
  readonly aiAssisted: boolean;
  readonly imagePath: string | null;
  readonly soldAt: string;
  readonly deliveredAt: string;
}

/** Returns whether a row was actually written. `false` means it already existed. */
async function insertCertificate(tx: Tx, input: InsertInput): Promise<boolean> {
  const { rowCount } = await tx.query(
    `insert into certificates (
       id, order_id, fulfilment_id, artwork_id, artist_id, buyer_id,
       unit_ordinal, inventory_type, edition_position, edition_size,
       title, artist_display_name, medium,
       height_mm, width_mm, depth_mm, materials, year_created,
       ai_assisted, image_path, sold_at, delivered_at, declaration_version
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21::timestamptz, $22::timestamptz, $23
     )
     on conflict on constraint certificates_one_per_unit do nothing`,
    [
      input.id,
      input.orderId,
      input.fulfilmentId,
      input.artworkId,
      input.artistId,
      input.buyerId,
      input.unitOrdinal,
      input.inventoryType,
      input.editionPosition,
      input.editionSize,
      input.title,
      input.artistDisplayName,
      input.medium,
      input.heightMm,
      input.widthMm,
      input.depthMm,
      input.materials,
      input.yearCreated,
      input.aiAssisted,
      input.imagePath,
      input.soldAt,
      input.deliveredAt,
      DECLARATION_VERSION,
    ],
  );
  return rowCount > 0;
}
