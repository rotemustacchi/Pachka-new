/**
 * The orders domain types, and the one place a database row becomes one.
 *
 * Two rules this file exists to keep, both borrowed from `artworks/types.ts`
 * because they are the same two rules and a second answer would be a bug:
 *
 * 1. Every money column is `bigint`, which node-postgres hands back as a STRING
 *    so that values above 2^53 survive the trip (see shared/db/client.ts).
 *    `shared/money`'s `fromDbValue` is the only sanctioned way to turn that
 *    string into money. It is called here so no other file in this module is
 *    tempted to reach for `Number()` -- which is SECURITY.md S2-27 exactly.
 *
 * 2. Mapping is explicit, key by key, with no spread. A spread would make the
 *    shape of a domain object depend on the shape of whatever query produced
 *    it, which is how a buyer's phone number reaches an artist's React Server
 *    Component props and gets serialised into the flight payload embedded in
 *    the HTML (SECURITY.md S1-8). In this module that is not a hypothetical:
 *    `order_shipping_details` is the buyer's name, phone and street address.
 */
import { fromDbValue, type Agorot } from "@/shared/money";

/**
 * `checkout-orders`, "Order state machine": an order occupies exactly one of
 * seven states. The permitted edges live in `state-machine.ts`.
 */
export const ORDER_STATUSES = [
  "awaiting_payment",
  "paid",
  "shipped",
  "delivered",
  "return_requested",
  "returned",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * A fulfilment uses the SAME vocabulary as the order it belongs to.
 *
 * Deliberately not a narrower set. SECURITY.md S1-18 item 2 writes the buyer
 * -details policy predicate in terms of a fulfilment's status being past
 * `awaiting_payment`, and a second vocabulary would make that clause quietly
 * mean something else. It is also what lets one order show "one item shipped
 * and one still awaiting dispatch" (`checkout-orders`) without inventing a
 * parallel state machine to reason about.
 */
export type FulfilmentStatus = OrderStatus;

/** Who moved an order. `system` is the sweep and the aggregate recompute -- no account. */
export const ACTOR_KINDS = ["buyer", "artist", "admin", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const PAYMENT_STATUSES = [
  "pending",
  "authorized",
  "captured",
  "refunded",
  "failed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Why a reservation stopped holding its unit. Never null on a released row. */
export const RELEASE_REASONS = ["expired", "cancelled", "returned", "superseded"] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export interface Order {
  readonly id: string;
  readonly buyerId: string;
  readonly status: OrderStatus;
  readonly subtotalAgorot: Agorot;
  readonly shippingAgorot: Agorot;
  readonly totalAgorot: Agorot;
  /**
   * Basis points, snapshotted at placement. Kept on the order so `payouts` can
   * compute a split against the rate that applied when the sale happened, not
   * the rate that applies when the payout runs (SECURITY.md S0-5 item 3).
   */
  readonly commissionRateBp: number;
  readonly currency: string;
  readonly shippingZoneCode: string | null;
  readonly placedAt: string;
  readonly updatedAt: string;
}

export interface OrderRow {
  readonly id: string;
  readonly buyer_id: string;
  readonly status: string;
  readonly subtotal_agorot: string;
  readonly shipping_agorot: string;
  readonly total_agorot: string;
  readonly commission_rate_bp: number;
  readonly currency: string;
  readonly shipping_zone_code: string | null;
  readonly placed_at: Date | string;
  readonly updated_at: Date | string;
}

/**
 * The column list every order query uses.
 *
 * Exported so the query and the mapper cannot drift, and so `select *` never
 * appears against this table -- the reason `artworks` gives, and one that gets
 * sharper here: a column added to `orders` next quarter is a column on a row a
 * buyer can read over the data API.
 */
export const ORDER_COLUMNS = [
  "id",
  "buyer_id",
  "status",
  "subtotal_agorot",
  "shipping_agorot",
  "total_agorot",
  "commission_rate_bp",
  "currency",
  "shipping_zone_code",
  "placed_at",
  "updated_at",
].join(", ");

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    buyerId: row.buyer_id,
    status: row.status as OrderStatus,
    subtotalAgorot: fromDbValue(row.subtotal_agorot),
    shippingAgorot: fromDbValue(row.shipping_agorot),
    totalAgorot: fromDbValue(row.total_agorot),
    commissionRateBp: row.commission_rate_bp,
    currency: row.currency,
    shippingZoneCode: row.shipping_zone_code,
    placedAt: iso(row.placed_at),
    updatedAt: iso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

export interface Fulfilment {
  readonly id: string;
  readonly orderId: string;
  readonly artistId: string;
  readonly status: FulfilmentStatus;
  readonly itemsSubtotalAgorot: Agorot;
  /** One parcel's shipping, not a per-item sum -- see `shipping/quote.ts`. */
  readonly shippingAgorot: Agorot;
  readonly shippingTierCode: string | null;
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FulfilmentRow {
  readonly id: string;
  readonly order_id: string;
  readonly artist_id: string;
  readonly status: string;
  readonly items_subtotal_agorot: string;
  readonly shipping_agorot: string;
  readonly shipping_tier_code: string | null;
  readonly shipped_at: Date | string | null;
  readonly delivered_at: Date | string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export const FULFILMENT_COLUMNS = [
  "id",
  "order_id",
  "artist_id",
  "status",
  "items_subtotal_agorot",
  "shipping_agorot",
  "shipping_tier_code",
  "shipped_at",
  "delivered_at",
  "created_at",
  "updated_at",
].join(", ");

export function toFulfilment(row: FulfilmentRow): Fulfilment {
  return {
    id: row.id,
    orderId: row.order_id,
    artistId: row.artist_id,
    status: row.status as FulfilmentStatus,
    itemsSubtotalAgorot: fromDbValue(row.items_subtotal_agorot),
    shippingAgorot: fromDbValue(row.shipping_agorot),
    shippingTierCode: row.shipping_tier_code,
    shippedAt: isoOrNull(row.shipped_at),
    deliveredAt: isoOrNull(row.delivered_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Order item
// ---------------------------------------------------------------------------

export interface OrderItem {
  readonly id: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly artistId: string;
  readonly quantity: number;
  /** Read from the artwork row under the reservation lock. Never from the client. */
  readonly unitPriceAgorot: Agorot;
  readonly lineTotalAgorot: Agorot;
  readonly titleSnapshot: string | null;
  readonly createdAt: string;
}

export interface OrderItemRow {
  readonly id: string;
  readonly order_id: string;
  readonly fulfilment_id: string;
  readonly artwork_id: string;
  readonly artist_id: string;
  readonly quantity: number;
  readonly unit_price_agorot: string;
  readonly line_total_agorot: string;
  readonly title_snapshot: string | null;
  readonly created_at: Date | string;
}

export const ORDER_ITEM_COLUMNS = [
  "id",
  "order_id",
  "fulfilment_id",
  "artwork_id",
  "artist_id",
  "quantity",
  "unit_price_agorot",
  "line_total_agorot",
  "title_snapshot",
  "created_at",
].join(", ");

export function toOrderItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    fulfilmentId: row.fulfilment_id,
    artworkId: row.artwork_id,
    artistId: row.artist_id,
    quantity: row.quantity,
    unitPriceAgorot: fromDbValue(row.unit_price_agorot),
    lineTotalAgorot: fromDbValue(row.line_total_agorot),
    titleSnapshot: row.title_snapshot,
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

/** One held or sold UNIT. Not a row with a quantity -- see the migration, O2. */
export interface Reservation {
  readonly id: string;
  readonly artworkId: string;
  readonly buyerId: string;
  readonly orderId: string | null;
  readonly unitIndex: number;
  readonly expiresAt: string;
  readonly confirmedAt: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: ReleaseReason | null;
  readonly createdAt: string;
}

export interface ReservationRow {
  readonly id: string;
  readonly artwork_id: string;
  readonly buyer_id: string;
  readonly order_id: string | null;
  readonly unit_index: number;
  readonly expires_at: Date | string;
  readonly confirmed_at: Date | string | null;
  readonly released_at: Date | string | null;
  readonly release_reason: string | null;
  readonly created_at: Date | string;
}

export const RESERVATION_COLUMNS = [
  "id",
  "artwork_id",
  "buyer_id",
  "order_id",
  "unit_index",
  "expires_at",
  "confirmed_at",
  "released_at",
  "release_reason",
  "created_at",
].join(", ");

export function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    artworkId: row.artwork_id,
    buyerId: row.buyer_id,
    orderId: row.order_id,
    unitIndex: row.unit_index,
    expiresAt: iso(row.expires_at),
    confirmedAt: isoOrNull(row.confirmed_at),
    releasedAt: isoOrNull(row.released_at),
    releaseReason: row.release_reason as ReleaseReason | null,
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Delivery details
// ---------------------------------------------------------------------------

/**
 * The buyer's contact and delivery details.
 *
 * This is the most sensitive shape in the module. It reaches an artist ONLY
 * through `artistFulfilment()`, only for their own fulfilment, and only once
 * that fulfilment is past `awaiting_payment` -- enforced twice, once by the RLS
 * policy on `order_shipping_details` and once in `views.ts`. Neither is
 * decorative: RLS is what protects the PostgREST data API, and the module check
 * is what protects the server's own privileged connection, which RLS admits.
 */
export interface DeliveryDetails {
  readonly fullName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postalCode: string | null;
  readonly countryCode: string;
}

export interface DeliveryDetailsRow {
  readonly full_name: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postal_code: string | null;
  readonly country_code: string;
}

export const DELIVERY_COLUMNS = [
  "full_name",
  "phone",
  "line1",
  "line2",
  "city",
  "postal_code",
  "country_code",
].join(", ");

export function toDeliveryDetails(row: DeliveryDetailsRow): DeliveryDetails {
  return {
    fullName: row.full_name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    postalCode: row.postal_code,
    countryCode: row.country_code,
  };
}

// ---------------------------------------------------------------------------
// Transition record
// ---------------------------------------------------------------------------

export interface OrderTransitionRecord {
  readonly id: string;
  readonly orderId: string;
  /** Null for an order-level move; set when one artist's fulfilment moved. */
  readonly fulfilmentId: string | null;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly actorId: string | null;
  readonly actorKind: ActorKind;
  readonly reason: string | null;
  readonly occurredAt: string;
}

export interface OrderTransitionRow {
  readonly id: string;
  readonly order_id: string;
  readonly fulfilment_id: string | null;
  readonly from_status: string;
  readonly to_status: string;
  readonly actor_id: string | null;
  readonly actor_kind: string;
  readonly reason: string | null;
  readonly occurred_at: Date | string;
}

export const TRANSITION_COLUMNS = [
  "id",
  "order_id",
  "fulfilment_id",
  "from_status",
  "to_status",
  "actor_id",
  "actor_kind",
  "reason",
  "occurred_at",
].join(", ");

export function toTransitionRecord(row: OrderTransitionRow): OrderTransitionRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    fulfilmentId: row.fulfilment_id,
    from: row.from_status as OrderStatus,
    to: row.to_status as OrderStatus,
    actorId: row.actor_id,
    actorKind: row.actor_kind as ActorKind,
    reason: row.reason,
    occurredAt: iso(row.occurred_at),
  };
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

export interface PaymentRecord {
  readonly id: string;
  readonly orderId: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly status: PaymentStatus;
  readonly amountAgorot: Agorot;
  readonly currency: string;
  readonly settledBy: string | null;
  readonly authorizedAt: string | null;
  readonly capturedAt: string | null;
  readonly refundedAt: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PaymentRow {
  readonly id: string;
  readonly order_id: string;
  readonly provider: string;
  readonly provider_reference: string;
  readonly status: string;
  readonly amount_agorot: string;
  readonly currency: string;
  readonly settled_by: string | null;
  readonly authorized_at: Date | string | null;
  readonly captured_at: Date | string | null;
  readonly refunded_at: Date | string | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

export const PAYMENT_COLUMNS = [
  "id",
  "order_id",
  "provider",
  "provider_reference",
  "status",
  "amount_agorot",
  "currency",
  "settled_by",
  "authorized_at",
  "captured_at",
  "refunded_at",
  "failure_reason",
  "created_at",
  "updated_at",
].join(", ");

export function toPaymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerReference: row.provider_reference,
    status: row.status as PaymentStatus,
    amountAgorot: fromDbValue(row.amount_agorot),
    currency: row.currency,
    settledBy: row.settled_by,
    authorizedAt: isoOrNull(row.authorized_at),
    capturedAt: isoOrNull(row.captured_at),
    refundedAt: isoOrNull(row.refunded_at),
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
