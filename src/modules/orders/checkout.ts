/**
 * Checkout: the transaction that decides who owns the painting.
 *
 * Everything that could be got wrong about money and inventory is got right
 * here or nowhere, so the order of operations is written down and then followed
 * exactly.
 *
 *   1. Validate the request's SHAPE. No database work for a checkout with no
 *      phone number.
 *   2. Gate on email verification — at RESERVATION time, not at confirmation.
 *      SECURITY.md S1-17: "If the verification check sits at confirm rather than
 *      at reservation, an unverified — therefore disposable and unattributable —
 *      account can lock inventory."
 *   3. Open ONE transaction. Everything below is inside it.
 *   4. Assert the demand source is wired. Fails closed; see `artworks`.
 *   5. Cap the buyer's concurrent holds (S1-17 item 2).
 *   6. For each artwork, IN A FIXED ORDER: lock the row, then derive
 *      availability, then hold the units. Never the reverse (S0-4 item 2).
 *   7. Price from the locked rows. Quote shipping on the same handle.
 *   8. Compare against what the buyer was shown; abort on any difference.
 *   9. Write the order, its fulfilments, its items, its address, its payment.
 *  10. Reconcile each artwork's status under the same locks.
 *
 * WHY THE ARTWORKS ARE LOCKED IN SORTED ORDER
 * -------------------------------------------
 * Two buyers checking out the same two artworks in opposite orders deadlock:
 * each holds the row the other needs. PostgreSQL detects it and kills one
 * transaction with a `deadlock detected` error — which is survivable but reads
 * to the buyer as a random failure, and is entirely avoidable. Sorting the
 * artwork ids before locking gives every checkout in the marketplace the same
 * lock order, so the second one simply waits.
 *
 * WHERE THE MONEY COMES FROM
 * --------------------------
 * SECURITY.md S0-5: "The checkout request body contains only artwork IDs,
 * quantities, and the delivery address. Every monetary figure is derived
 * server-side." The request type below has no field for a price the server
 * would use, and the two figures a client MAY send —
 * `displayedUnitPriceAgorot` and `displayedTotalAgorot` — are compared and then
 * discarded. That is S0-5 item 5's displayed-price binding: "The
 * client-supplied figure is never used as an amount — only compared."
 *
 * The comparison is also how `checkout-orders`' *Price changed since adding*
 * scenario is satisfied at the moment it matters. A cart view flags a change
 * when the buyer looks; this flags it when the buyer confirms, which is the
 * window a TOCTOU attack lives in.
 */
import { AppError, type FieldErrors } from "@/shared/errors";
import { addAgorot, multiplyAgorot, zeroAgorot, type Agorot } from "@/shared/money";
import type { Database, Tx } from "@/shared/db";
import { assertEmailVerified } from "@/modules/accounts";
import {
  lockArtworkForUpdate,
  reconcileAvailability,
  toArtwork,
  ARTWORK_COLUMNS,
  type Artwork,
  type ArtworkRow,
} from "@/modules/artworks";
import { classifyPackage, quoteShipping, type QuoteLine, type ShippingQuote } from "@/modules/shipping";
import { commissionRateBp } from "./config";
import { artworksDepsFor, packedDepthMmFor, type OrdersDeps } from "./deps";
import { orderPlacedNotifications } from "./notifications";
import {
  assertDemandWired,
  assertReservationCapacity,
  holdUnits,
  reservationExpiryFrom,
} from "./reservations";
import type { NotificationRequest } from "./notifications";
import {
  DELIVERY_COLUMNS,
  FULFILMENT_COLUMNS,
  ORDER_COLUMNS,
  ORDER_ITEM_COLUMNS,
  PAYMENT_COLUMNS,
  toDeliveryDetails,
  toFulfilment,
  toOrder,
  toOrderItem,
  toPaymentRecord,
  type DeliveryDetails,
  type DeliveryDetailsRow,
  type Fulfilment,
  type FulfilmentRow,
  type Order,
  type OrderItem,
  type OrderItemRow,
  type OrderRow,
  type PaymentRecord,
  type PaymentRow,
  type Reservation,
} from "./types";

/**
 * One line of a checkout, as the client is allowed to express it.
 *
 * Three fields, and only one of them is money — which is compared, never used.
 * There is deliberately no `unitPrice`, no `artistId` and no `sizeTierCode`:
 * all three are read from the artwork row server-side, and a field for them
 * here would be a field an attacker fills in.
 */
export interface CheckoutLine {
  readonly artworkId: string;
  /** Defaults to 1. Only an edition can be more. */
  readonly quantity?: number;
  /**
   * The unit price the buyer was shown. INTEGRITY CHECK ONLY (S0-5 item 5).
   * Omit it and the server prices the line without complaint; supply a stale
   * one and the checkout is aborted rather than silently re-priced.
   */
  readonly displayedUnitPriceAgorot?: number;
}

/** `checkout-orders`: full name, phone number, and delivery address, before payment. */
export interface DeliveryInput {
  readonly fullName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly postalCode?: string | null;
  readonly countryCode: string;
}

export interface CheckoutRequest {
  readonly buyerId: string;
  readonly lines: readonly CheckoutLine[];
  readonly delivery: DeliveryInput;
  /** The total the buyer was shown. Compared, never used as an amount. */
  readonly displayedTotalAgorot?: number;
}

export interface CheckoutResult {
  readonly order: Order;
  readonly delivery: DeliveryDetails;
  readonly fulfilments: readonly Fulfilment[];
  readonly items: readonly OrderItem[];
  readonly reservations: readonly Reservation[];
  readonly payment: PaymentRecord;
  /** What the buyer is told to do next; rendered by the manual adapter. */
  readonly paymentInstructions: string | null;
  /**
   * Dispatch these AFTER the transaction has committed. Same contract as
   * `shipping`: nobody is told about something that then rolled back.
   */
  readonly notifications: readonly NotificationRequest[];
}

/** One priced line of a preview. No reservation exists for any of these. */
export interface CheckoutPreviewLine {
  readonly artworkId: string;
  readonly artistId: string;
  readonly title: string | null;
  readonly quantity: number;
  readonly unitPriceAgorot: Agorot;
  readonly lineTotalAgorot: Agorot;
}

/** The breakdown a buyer sees before confirming. Every figure derived server-side. */
export interface CheckoutPreview {
  readonly lines: readonly CheckoutPreviewLine[];
  readonly subtotalAgorot: Agorot;
  readonly shippingAgorot: Agorot;
  readonly totalAgorot: Agorot;
  readonly currency: string;
  readonly zoneCode: string;
  readonly zoneDisplayName: string;
  /** How many parcels this will ship as — one per artist. */
  readonly parcelCount: number;
}

// ---------------------------------------------------------------------------
// Shape validation — before any database work
// ---------------------------------------------------------------------------

const REQUIRED_DELIVERY: ReadonlyArray<{
  readonly field: keyof DeliveryInput;
  readonly message: string;
}> = [
  { field: "fullName", message: "יש להזין שם מלא" },
  { field: "phone", message: "יש להזין מספר טלפון" },
  { field: "line1", message: "יש להזין רחוב ומספר בית" },
  { field: "city", message: "יש להזין עיר" },
  { field: "countryCode", message: "יש לבחור מדינה" },
];

/**
 * `checkout-orders`: "WHEN a buyer attempts to confirm without a phone number or
 * complete address THEN the system blocks the order and identifies the missing
 * fields."
 *
 * Every missing field at once, not one per round trip — the same choice
 * `artworks` makes at publish time, and for the same reason: a person filling in
 * a form should be told everything that is wrong with it.
 */
export function validateDelivery(input: DeliveryInput): DeliveryDetails {
  const fields: Record<string, string[]> = {};

  for (const { field, message } of REQUIRED_DELIVERY) {
    const value = input[field];
    if (typeof value !== "string" || value.trim() === "") {
      (fields[field] ??= []).push(message);
    }
  }

  // A phone number is what an artist uses to arrange a handover and what a
  // courier calls. Checked for shape rather than merely presence, because an
  // address that reaches a parcel with an unusable number is a delivery
  // failure the buyer will not hear about until it has already happened.
  const digits = (input.phone ?? "").replace(/\D/g, "");
  if (fields["phone"] === undefined && digits.length < 9) {
    (fields["phone"] ??= []).push("מספר הטלפון אינו תקין");
  }

  if (typeof input.countryCode === "string" && !/^[A-Z]{2}$/.test(input.countryCode)) {
    (fields["countryCode"] ??= []).push("יש לבחור מדינה");
  }

  if (Object.keys(fields).length > 0) {
    throw AppError.fieldsInvalid(fields as FieldErrors, { code: "orders.delivery_incomplete" });
  }

  return {
    fullName: input.fullName.trim(),
    phone: input.phone.trim(),
    line1: input.line1.trim(),
    line2: input.line2?.trim() || null,
    city: input.city.trim(),
    postalCode: input.postalCode?.trim() || null,
    countryCode: input.countryCode,
  };
}

interface NormalisedLine {
  readonly artworkId: string;
  readonly quantity: number;
  readonly displayedUnitPriceAgorot: number | null;
}

function normaliseLines(lines: readonly CheckoutLine[]): NormalisedLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw AppError.validation("A checkout needs at least one artwork.", {
      code: "orders.empty_checkout",
    });
  }

  const seen = new Set<string>();
  const normalised: NormalisedLine[] = [];

  for (const line of lines) {
    if (typeof line.artworkId !== "string" || line.artworkId === "") {
      throw AppError.validation("Every checkout line needs an artwork.", {
        code: "orders.line_missing_artwork",
      });
    }
    // One line per artwork. Two lines for one piece would make the item count
    // and the reservation count disagree, and the table's unique constraint
    // would reject the second insert halfway through the order anyway.
    if (seen.has(line.artworkId)) {
      throw AppError.validation("An artwork appears more than once in this checkout.", {
        code: "orders.duplicate_line",
        details: { artworkId: line.artworkId },
      });
    }
    seen.add(line.artworkId);

    const quantity = line.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw AppError.validation(`Quantity must be a whole number of at least 1, got ${quantity}.`, {
        code: "orders.invalid_quantity",
        details: { artworkId: line.artworkId, quantity },
      });
    }

    normalised.push({
      artworkId: line.artworkId,
      quantity,
      displayedUnitPriceAgorot: line.displayedUnitPriceAgorot ?? null,
    });
  }

  // THE LOCK ORDER. See the file header: a fixed global order is what keeps two
  // buyers with overlapping carts from deadlocking each other.
  return normalised.sort((a, b) => (a.artworkId < b.artworkId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

interface PricedLine {
  readonly artwork: Artwork;
  readonly quantity: number;
  readonly unitPriceAgorot: Agorot;
  readonly lineTotalAgorot: Agorot;
}

/**
 * The artwork's price, read from the row already locked in this transaction.
 *
 * A published artwork always has a price — the publish check constraint sees to
 * that — so a null here is a database that disagrees with itself rather than a
 * buyer error, and it is refused rather than defaulted to zero.
 */
function priceOf(artwork: Artwork): Agorot {
  if (artwork.priceAgorot === null) {
    throw AppError.conflict("This piece is not currently for sale.", {
      code: "orders.artwork_not_priced",
      details: { artworkId: artwork.id },
    });
  }
  return artwork.priceAgorot;
}

/**
 * The parcel this artwork travels in, for `shipping.classifyPackage`.
 *
 * `artworks` stores dimensions as whole MILLIMETRES already, so nothing is
 * converted here — `millimetresFromCentimetres` is for a caller holding the
 * centimetres an artist typed, and this caller is holding the stored row.
 *
 * Depth is the one gap: `artworks` requires it only for three-dimensional media,
 * so a painting legitimately has none, and `fitsTier` needs three positive
 * edges. See `DEFAULT_FLAT_ARTWORK_PACKED_DEPTH_MM` for why the fallback errs
 * upward.
 */
function parcelFor(artwork: Artwork, packedDepthMm: number) {
  if (artwork.heightMm === null || artwork.widthMm === null || artwork.weightGrams === null) {
    throw AppError.conflict(
      "This piece is missing the measurements needed to work out delivery.",
      { code: "orders.artwork_not_measurable", details: { artworkId: artwork.id } },
    );
  }
  return {
    lengthMm: artwork.heightMm,
    widthMm: artwork.widthMm,
    heightMm: artwork.depthMm ?? packedDepthMm,
    weightGrams: artwork.weightGrams,
  };
}

/**
 * The cost breakdown, WITHOUT reserving anything.
 *
 * `checkout-orders`, "Checkout collects delivery and contact details": the
 * system "SHALL present a full cost breakdown of item prices, shipping, and
 * total in ILS before the buyer confirms", and the scenario is emphatic that it
 * happens "before any payment action".
 *
 * `revalidateCart` cannot answer that on its own, because shipping is not
 * knowable until there is an address: the zone comes from the city and the tier
 * from the artworks. And `beginCheckout` answers it only by taking the
 * inventory first, which is the wrong order — a buyer who wanted to see the
 * postage before deciding would have had to hold the piece to find out, and a
 * buyer who then walked away would have taken it off the market for the whole
 * TTL. That is SECURITY.md S1-17's inventory hostage, handed to every browsing
 * visitor as a feature.
 *
 * So this is the same derivation, read-only:
 *
 *   • no `FOR UPDATE`, no transaction, no reservation row;
 *   • prices and tiers still read SERVER-SIDE from the artwork rows, so the
 *     preview cannot be talked into quoting a cheaper zone or a smaller parcel
 *     than the real thing will (SECURITY.md S0-5 item 4);
 *   • the total it returns is exactly what `beginCheckout` will derive, which is
 *     what makes it usable as the `displayedTotalAgorot` integrity check —
 *     a figure that changed in between aborts the checkout instead of
 *     surprising the buyer.
 *
 * It is a quote, not a promise. Between this call and the confirm, the piece can
 * sell and the price can move; both are caught under the lock, where they must
 * be.
 */
export async function previewCheckout(
  deps: OrdersDeps,
  request: Omit<CheckoutRequest, "buyerId"> & { readonly buyerId?: string },
): Promise<CheckoutPreview> {
  const delivery = validateDelivery(request.delivery);
  const lines = normaliseLines(request.lines);
  const packedDepthMm = packedDepthMmFor(deps);

  const priced: Array<{ artwork: Artwork; quantity: number; unitPriceAgorot: Agorot; lineTotalAgorot: Agorot }> = [];
  const quoteLines: QuoteLine[] = [];

  for (const line of lines) {
    const row = await deps.db.maybeOne<ArtworkRow>(
      `select ${ARTWORK_COLUMNS} from artworks where id = $1`,
      [line.artworkId],
    );
    if (row === null) {
      throw AppError.notFound("Artwork not found", {
        code: "orders.artwork_not_found",
        details: { artworkId: line.artworkId },
      });
    }

    const artwork = toArtwork(row);
    const unitPriceAgorot = priceOf(artwork);
    const classification = await classifyPackage(deps.db, parcelFor(artwork, packedDepthMm));

    priced.push({
      artwork,
      quantity: line.quantity,
      unitPriceAgorot,
      lineTotalAgorot: multiplyAgorot(unitPriceAgorot, line.quantity),
    });
    quoteLines.push({
      artworkId: artwork.id,
      artistId: artwork.artistId,
      sizeTierCode: classification.tierCode,
      requiresShippingQuote: classification.requiresShippingQuote,
    });
  }

  const subtotalAgorot = priced.reduce(
    (sum, line) => addAgorot(sum, line.lineTotalAgorot),
    zeroAgorot,
  );

  const quote = await quoteShipping(deps.db, {
    address: {
      countryCode: delivery.countryCode,
      city: delivery.city,
      postalCode: delivery.postalCode,
    },
    lines: quoteLines,
  });

  return {
    lines: priced.map((line) => ({
      artworkId: line.artwork.id,
      artistId: line.artwork.artistId,
      title: line.artwork.title,
      quantity: line.quantity,
      unitPriceAgorot: line.unitPriceAgorot,
      lineTotalAgorot: line.lineTotalAgorot,
    })),
    subtotalAgorot,
    shippingAgorot: quote.totalAgorot,
    totalAgorot: addAgorot(subtotalAgorot, quote.totalAgorot),
    currency: "ILS",
    zoneCode: quote.zoneCode,
    zoneDisplayName: quote.zoneDisplayName,
    parcelCount: quote.fulfilments.length,
  };
}

export async function beginCheckout(
  deps: OrdersDeps,
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  // 1. Shape first. A checkout with no phone number costs no database work.
  const delivery = validateDelivery(request.delivery);
  const lines = normaliseLines(request.lines);

  // 2. The verification gate, at RESERVATION time. `accounts` owns the rule and
  // exposes it precisely so this module does not read `account_status` itself.
  await assertEmailVerified(deps.db, request.buyerId, "order");

  // 3. One transaction, one connection, for everything that follows.
  const outcome = await deps.db.withTransaction(async (tx) => {
    // 4. Fail closed if `artworks` is still holding the zero-demand placeholder.
    await assertDemandWired(deps, tx);

    // 5. The inventory-hostage cap (SECURITY.md S1-17).
    const units = lines.reduce((sum, line) => sum + line.quantity, 0);
    await assertReservationCapacity(deps, tx, request.buyerId, units);

    const expiresAt = await reservationExpiryFrom(tx);
    const packedDepthMm = packedDepthMmFor(deps);

    // 6-7. Lock, derive, hold, price — artwork by artwork, in sorted order.
    const priced: PricedLine[] = [];
    const quoteLines: QuoteLine[] = [];
    const heldUnits: Array<{ line: NormalisedLine; artwork: Artwork }> = [];

    for (const line of lines) {
      const artwork = await lockArtworkForUpdate(tx, line.artworkId);
      if (artwork === null) {
        throw AppError.notFound("Artwork not found", {
          code: "orders.artwork_not_found",
          details: { artworkId: line.artworkId },
        });
      }

      const unitPriceAgorot = priceOf(artwork);

      // THE DISPLAYED-PRICE BINDING (S0-5 item 5). Compared under the lock, so
      // "the price when the buyer looked" is checked against "the price right
      // now", with no window in between for it to change again.
      if (
        line.displayedUnitPriceAgorot !== null &&
        line.displayedUnitPriceAgorot !== unitPriceAgorot
      ) {
        throw AppError.validation(
          "The price of one of these pieces changed while you were checking out. " +
            "Please review your cart and confirm again.",
          {
            code: "orders.price_changed",
            details: {
              artworkId: artwork.id,
              displayedAgorot: line.displayedUnitPriceAgorot,
              currentAgorot: unitPriceAgorot,
            },
          },
        );
      }

      const parcel = parcelFor(artwork, packedDepthMm);
      const classification = await classifyPackage(tx, parcel);

      priced.push({
        artwork,
        quantity: line.quantity,
        unitPriceAgorot,
        lineTotalAgorot: multiplyAgorot(unitPriceAgorot, line.quantity),
      });
      quoteLines.push({
        artworkId: artwork.id,
        artistId: artwork.artistId,
        sizeTierCode: classification.tierCode,
        requiresShippingQuote: classification.requiresShippingQuote,
      });
      heldUnits.push({ line, artwork });
    }

    const subtotal = priced.reduce(
      (sum, line) => addAgorot(sum, line.lineTotalAgorot),
      zeroAgorot,
    );

    // Quoted on `tx`, so the rate table is read against the same snapshot as
    // the prices and the stock (`shipping/quote.ts`; SECURITY.md S0-5 item 2).
    // The address is passed straight through: shipping resolves the zone, and
    // the client never names one.
    const quote: ShippingQuote = await quoteShipping(tx, {
      address: {
        countryCode: delivery.countryCode,
        city: delivery.city,
        postalCode: delivery.postalCode,
      },
      lines: quoteLines,
    });

    const total = addAgorot(subtotal, quote.totalAgorot);

    // 8. The total the buyer was shown. Aborts the whole transaction — no order
    // row and no reservation row survive, which is what S0-5's TOCTOU test
    // asserts.
    if (
      request.displayedTotalAgorot !== undefined &&
      request.displayedTotalAgorot !== total
    ) {
      throw AppError.validation(
        "The total changed while you were checking out. Please review your cart and confirm again.",
        {
          code: "orders.total_changed",
          details: { displayedAgorot: request.displayedTotalAgorot, currentAgorot: total },
        },
      );
    }

    // 9. Write it all down.
    const rateBp = await commissionRateBp(tx);

    const orderRow = await tx.one<OrderRow>(
      `insert into orders
         (buyer_id, status, subtotal_agorot, shipping_agorot, total_agorot,
          commission_rate_bp, shipping_zone_code)
       values ($1, 'awaiting_payment', $2, $3, $4, $5, $6)
       returning ${ORDER_COLUMNS}`,
      [
        request.buyerId,
        String(subtotal),
        String(quote.totalAgorot),
        String(total),
        rateBp,
        quote.zoneCode,
      ],
    );
    const order = toOrder(orderRow);

    const deliveryRow = await tx.one<DeliveryDetailsRow>(
      `insert into order_shipping_details
         (order_id, full_name, phone, line1, line2, city, postal_code, country_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${DELIVERY_COLUMNS}`,
      [
        order.id,
        delivery.fullName,
        delivery.phone,
        delivery.line1,
        delivery.line2,
        delivery.city,
        delivery.postalCode,
        delivery.countryCode,
      ],
    );

    // ONE FULFILMENT PER ARTIST. `checkout-orders`: "Where a single order
    // contains artworks from more than one artist, the system SHALL create a
    // separate fulfilment record per artist. Each fulfilment SHALL be shipped,
    // tracked, and paid out independently, while the buyer sees one order."
    // The shipping figures come from the quote, which already charged one
    // parcel per artist at the largest applicable tier.
    const quoteByArtist = new Map(quote.fulfilments.map((f) => [f.artistId, f] as const));
    const subtotalByArtist = new Map<string, Agorot>();
    for (const line of priced) {
      const running = subtotalByArtist.get(line.artwork.artistId) ?? zeroAgorot;
      subtotalByArtist.set(line.artwork.artistId, addAgorot(running, line.lineTotalAgorot));
    }

    const fulfilments: Fulfilment[] = [];
    const fulfilmentByArtist = new Map<string, Fulfilment>();
    for (const artistId of [...subtotalByArtist.keys()].sort()) {
      const artistQuote = quoteByArtist.get(artistId);
      if (!artistQuote) {
        // Unreachable: `quoteShipping` groups by the artist ids it was given.
        // Loud rather than defaulting to zero shipping, which would be the
        // platform quietly paying for the parcel.
        throw AppError.conflict("Delivery could not be priced for one of these artists.", {
          code: "orders.missing_artist_quote",
          details: { artistId },
        });
      }

      const row = await tx.one<FulfilmentRow>(
        `insert into fulfilments
           (order_id, artist_id, status, items_subtotal_agorot, shipping_agorot, shipping_tier_code)
         values ($1, $2, 'awaiting_payment', $3, $4, $5)
         returning ${FULFILMENT_COLUMNS}`,
        [
          order.id,
          artistId,
          String(subtotalByArtist.get(artistId) ?? zeroAgorot),
          String(artistQuote.amountAgorot),
          artistQuote.tierCode,
        ],
      );
      const fulfilment = toFulfilment(row);
      fulfilments.push(fulfilment);
      fulfilmentByArtist.set(artistId, fulfilment);
    }

    const items: OrderItem[] = [];
    for (const line of priced) {
      const fulfilment = fulfilmentByArtist.get(line.artwork.artistId);
      if (!fulfilment) throw new Error("unreachable: every artist has a fulfilment");

      const row = await tx.one<OrderItemRow>(
        `insert into order_items
           (order_id, fulfilment_id, artwork_id, artist_id, quantity,
            unit_price_agorot, line_total_agorot, title_snapshot)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${ORDER_ITEM_COLUMNS}`,
        [
          order.id,
          fulfilment.id,
          line.artwork.id,
          line.artwork.artistId,
          line.quantity,
          String(line.unitPriceAgorot),
          String(line.lineTotalAgorot),
          line.artwork.title,
        ],
      );
      items.push(toOrderItem(row));
    }

    // The holds. Taken AFTER the order exists so each row carries its order id,
    // and still under the same locks taken at step 6 — nothing has committed
    // and nothing has released.
    const reservations: Reservation[] = [];
    for (const { line, artwork } of heldUnits) {
      reservations.push(
        ...(await holdUnits(tx, {
          artwork,
          buyerId: request.buyerId,
          orderId: order.id,
          quantity: line.quantity,
          expiresAt,
        })),
      );
    }

    // The payment. `checkout-orders`: "the order is created in
    // `awaiting_payment`, inventory stays reserved, and both buyer and operator
    // receive instructions by email."
    const authorised = await deps.payments.authorize({
      orderId: order.id,
      amountAgorot: total,
      currency: order.currency,
      buyerReference: order.id,
    });

    const paymentRow = await tx.one<PaymentRow>(
      `insert into payments
         (order_id, provider, provider_reference, status, amount_agorot, authorized_at)
       values ($1, $2, $3, $4, $5, case when $4 = 'authorized' then now() else null end)
       returning ${PAYMENT_COLUMNS}`,
      [
        order.id,
        deps.payments.name,
        authorised.reference,
        authorised.status,
        String(total),
      ],
    );

    // 10. An artwork whose last unit is now held is `sold`, under the same
    // locks. `reconcileAvailability` re-derives rather than decrementing a
    // counter, because there is no counter (ARCHITECTURE.md).
    const artworksDeps = artworksDepsFor(deps, deps.db);
    for (const { artwork } of heldUnits) {
      await reconcileAvailability(artworksDeps, artwork.id, tx);
    }

    return {
      order,
      delivery: toDeliveryDetails(deliveryRow),
      fulfilments,
      items,
      reservations,
      payment: toPaymentRecord(paymentRow),
      paymentInstructions: authorised.instructions ?? null,
    };
  });

  return {
    ...outcome,
    notifications: orderPlacedNotifications({
      order: outcome.order,
      fulfilments: outcome.fulfilments,
      instructions: outcome.paymentInstructions,
    }),
  };
}

/**
 * `beginCheckout`'s dependency on a `Database` rather than a `Tx` is deliberate
 * and worth one sentence: this function OPENS the transaction, and a caller who
 * could pass one in could nest checkout inside larger work — where the artwork
 * locks would be held for the whole of that work, and a failure anywhere in it
 * would roll back a completed sale.
 */
export type CheckoutDatabase = Database;
export type CheckoutTransaction = Tx;
