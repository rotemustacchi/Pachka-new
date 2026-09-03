/**
 * Who is allowed to see what, and the two read paths that enforce it.
 *
 * `checkout-orders`, "Order visibility respects artist anonymity in both
 * directions":
 *
 *   The system SHALL show an artist only the buyer's name, phone number, and
 *   delivery address for their own fulfilment, and only after the order reaches
 *   `paid`. The system SHALL NOT show the buyer the artist's contact details at
 *   any point.
 *
 * TWO LAYERS, AND WHY NEITHER IS ENOUGH ALONE
 * -------------------------------------------
 * The RLS policies in the migration are the first layer, and they are what
 * protects the PostgREST data API — reachable by anyone holding the anon key,
 * which legitimately ships in the browser bundle (SECURITY.md S0-1). No
 * serializer sits on that path, so the policy is the only thing there.
 *
 * The checks in this file are the second layer, and they are what protects the
 * server's own connection. That connection is a member of `service_role`, and
 * every policy in the migration admits it — deliberately, because the server has
 * to be able to write an order for a buyer it is acting on behalf of. So on this
 * path RLS grants everything and the module is the control. A route that read
 * `fulfilments` directly instead of calling `artistFulfilment` would get every
 * artist's rows and no error.
 *
 * Neither layer is decorative and neither is a duplicate of the other. They
 * cover different callers.
 *
 * NOT-FOUND, NOT FORBIDDEN
 * ------------------------
 * `checkout-orders`: "WHEN an artist requests a fulfilment belonging to a
 * different artist THEN the system returns a not-found response." SECURITY.md
 * S1-18 item 3 gives the reason: "a 403 confirms the resource exists." An
 * artist who could tell "not yours" from "does not exist" could enumerate their
 * competitors' sales one identifier at a time — which is also S3-29's concern,
 * and is why these ids are UUIDs.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { OrdersDeps } from "./deps";
import { orderHistory } from "./transition";
import {
  DELIVERY_COLUMNS,
  FULFILMENT_COLUMNS,
  ORDER_COLUMNS,
  ORDER_ITEM_COLUMNS,
  toDeliveryDetails,
  toFulfilment,
  toOrder,
  toOrderItem,
  type DeliveryDetails,
  type DeliveryDetailsRow,
  type Fulfilment,
  type FulfilmentRow,
  type Order,
  type OrderItem,
  type OrderItemRow,
  type OrderRow,
  type OrderTransitionRecord,
} from "./types";

// ---------------------------------------------------------------------------
// The buyer's view
// ---------------------------------------------------------------------------

/**
 * One parcel, as the BUYER sees it.
 *
 * Note what this is not: it is not a `Fulfilment`. A buyer is told how many
 * parcels are coming and where each one has got to, which is the whole of
 * `checkout-orders`' *One fulfilment ships before the other* scenario — "the
 * buyer's order shows one item shipped and one still awaiting dispatch".
 *
 * `artistId` is present and is not a leak: an artist profile is a public page
 * (`accounts.toPublicArtist`), and the spec forbids showing the buyer the
 * artist's CONTACT details, not the artist's existence. What must never appear
 * is an email, a phone number or a street address, and there is no field here
 * that could carry one — which is the protection, rather than a rule someone
 * has to remember.
 */
export interface BuyerParcel {
  readonly fulfilmentId: string;
  readonly artistId: string;
  readonly status: Fulfilment["status"];
  readonly shippedAt: string | null;
  readonly deliveredAt: string | null;
  readonly items: readonly OrderItem[];
}

export interface BuyerOrderDetail {
  readonly order: Order;
  /** The buyer's own address back to them. Their data, so no gate. */
  readonly delivery: DeliveryDetails;
  readonly parcels: readonly BuyerParcel[];
  readonly history: readonly OrderTransitionRecord[];
}

async function itemsFor(db: Sql, orderId: string): Promise<OrderItem[]> {
  const { rows } = await db.query<OrderItemRow>(
    `select ${ORDER_ITEM_COLUMNS} from order_items where order_id = $1 order by created_at, id`,
    [orderId],
  );
  return rows.map(toOrderItem);
}

/**
 * The buyer's order tracking view.
 *
 * Scoped by `buyer_id` in the WHERE clause rather than fetched and then checked.
 * The difference matters: a fetch-then-check leaves a window where the row is in
 * memory, and every such window is one refactor away from being returned by
 * accident.
 */
export async function buyerOrder(
  deps: OrdersDeps,
  buyerId: string,
  orderId: string,
): Promise<BuyerOrderDetail> {
  const orderRow = await deps.db.maybeOne<OrderRow>(
    `select ${ORDER_COLUMNS} from orders where id = $1 and buyer_id = $2`,
    [orderId, buyerId],
  );
  if (orderRow === null) {
    throw AppError.notFound("Order not found", {
      code: "orders.not_found",
      details: { orderId },
    });
  }
  const order = toOrder(orderRow);

  const deliveryRow = await deps.db.one<DeliveryDetailsRow>(
    `select ${DELIVERY_COLUMNS} from order_shipping_details where order_id = $1`,
    [order.id],
  );

  const { rows: fulfilmentRows } = await deps.db.query<FulfilmentRow>(
    `select ${FULFILMENT_COLUMNS} from fulfilments where order_id = $1 order by created_at, id`,
    [order.id],
  );

  const items = await itemsFor(deps.db, order.id);
  const byFulfilment = new Map<string, OrderItem[]>();
  for (const item of items) {
    const bucket = byFulfilment.get(item.fulfilmentId);
    if (bucket) bucket.push(item);
    else byFulfilment.set(item.fulfilmentId, [item]);
  }

  const parcels: BuyerParcel[] = fulfilmentRows.map((row) => {
    const fulfilment = toFulfilment(row);
    return {
      fulfilmentId: fulfilment.id,
      artistId: fulfilment.artistId,
      status: fulfilment.status,
      shippedAt: fulfilment.shippedAt,
      deliveredAt: fulfilment.deliveredAt,
      items: byFulfilment.get(fulfilment.id) ?? [],
    };
  });

  return {
    order,
    delivery: toDeliveryDetails(deliveryRow),
    parcels,
    history: await orderHistory(deps.db, order.id),
  };
}

/** Every order this buyer has placed, newest first. */
export async function listBuyerOrders(
  deps: OrdersDeps,
  buyerId: string,
): Promise<readonly Order[]> {
  const { rows } = await deps.db.query<OrderRow>(
    `select ${ORDER_COLUMNS} from orders where buyer_id = $1 order by placed_at desc`,
    [buyerId],
  );
  return rows.map(toOrder);
}

// ---------------------------------------------------------------------------
// The artist's view
// ---------------------------------------------------------------------------

/**
 * The states in which an artist may see who they are shipping to.
 *
 * `checkout-orders`: "only after the order reaches `paid`". Stated as a positive
 * list rather than as "anything but `awaiting_payment`" so that a state added
 * later defaults to withholding — the same choice the RLS policy makes, in the
 * same words, because the two must not be able to drift apart.
 *
 * `cancelled` is absent deliberately. A cancelled fulfilment may have passed
 * through `paid`, and there is no reason for an artist to hold a stranger's home
 * address for a parcel they will never send.
 */
const DISCLOSING_STATES: ReadonlySet<Fulfilment["status"]> = new Set([
  "paid",
  "shipped",
  "delivered",
  "return_requested",
  "returned",
]);

export interface ArtistFulfilmentDetail {
  readonly fulfilment: Fulfilment;
  /** Only this artist's lines. Another artist's prices are not theirs to read. */
  readonly items: readonly OrderItem[];
  /** The order, for the reference number and the placement date. */
  readonly orderId: string;
  readonly orderStatus: Order["status"];
  readonly placedAt: string;
  /**
   * `null` until the fulfilment is paid. Not an error and not an empty string:
   * the artist legitimately has a fulfilment they cannot yet see the address
   * for, and the view says so by structure.
   *
   * `checkout-orders`, *Artist views an unpaid order*: "the system withholds the
   * buyer's contact details."
   */
  readonly buyer: DeliveryDetails | null;
}

/**
 * One artist's fulfilment, or not-found.
 *
 * The `artist_id = $2` in the WHERE clause is the whole of the cross-artist
 * rule. A different artist's id matches no row, `maybeOne` returns null, and the
 * caller gets `not_found` — never `forbidden`, which would confirm the
 * fulfilment exists.
 */
export async function artistFulfilment(
  deps: OrdersDeps,
  artistId: string,
  fulfilmentId: string,
): Promise<ArtistFulfilmentDetail> {
  const row = await deps.db.maybeOne<FulfilmentRow>(
    `select ${FULFILMENT_COLUMNS} from fulfilments where id = $1 and artist_id = $2`,
    [fulfilmentId, artistId],
  );
  if (row === null) {
    throw AppError.notFound("Fulfilment not found", {
      code: "orders.fulfilment_not_found",
      details: { fulfilmentId },
    });
  }
  const fulfilment = toFulfilment(row);

  const order = toOrder(
    await deps.db.one<OrderRow>(`select ${ORDER_COLUMNS} from orders where id = $1`, [
      fulfilment.orderId,
    ]),
  );

  // Scoped to the fulfilment, not to the order. On a two-artist order this is
  // what stops each artist reading the other's line prices, which are
  // commercially sensitive between competitors on one marketplace.
  const { rows: itemRows } = await deps.db.query<OrderItemRow>(
    `select ${ORDER_ITEM_COLUMNS} from order_items
      where fulfilment_id = $1 and artist_id = $2
      order by created_at, id`,
    [fulfilment.id, artistId],
  );

  // THE TIMING GATE. The query is not even issued until the state permits it, so
  // the buyer's phone number is never in this process's memory for a fulfilment
  // that has not been paid for.
  let buyer: DeliveryDetails | null = null;
  if (DISCLOSING_STATES.has(fulfilment.status)) {
    const deliveryRow = await deps.db.maybeOne<DeliveryDetailsRow>(
      `select ${DELIVERY_COLUMNS} from order_shipping_details where order_id = $1`,
      [fulfilment.orderId],
    );
    buyer = deliveryRow === null ? null : toDeliveryDetails(deliveryRow);
  }

  return {
    fulfilment,
    items: itemRows.map(toOrderItem),
    orderId: order.id,
    orderStatus: order.status,
    placedAt: order.placedAt,
    buyer,
  };
}

/** Every fulfilment owed by this artist, newest first. No buyer details in a list view. */
export async function listArtistFulfilments(
  deps: OrdersDeps,
  artistId: string,
): Promise<readonly Fulfilment[]> {
  const { rows } = await deps.db.query<FulfilmentRow>(
    `select ${FULFILMENT_COLUMNS} from fulfilments where artist_id = $1 order by created_at desc`,
    [artistId],
  );
  return rows.map(toFulfilment);
}
