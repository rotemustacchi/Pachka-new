/**
 * What the transactional emails say, and — more importantly — what they do not.
 *
 * These are pure functions returning `NotificationRequest[]`, so there is
 * nothing to fake and no mailer to assert against. That is the point:
 * ARCHITECTURE.md rejects "asserting that a mock was called", and structuring
 * the module so mail leaves through the caller means every assertion here is
 * about the content of a value.
 *
 * The recurring assertion is a negative one. `checkout-orders` forbids showing
 * the buyer the artist's contact details at any point, and email is the worst
 * place to breach that because it leaves the platform and cannot be un-sent. So
 * each function's payload is searched for the things that must never be in it.
 */
import { describe, expect, it } from "vitest";
import { agorot } from "@/shared/money";
import {
  fulfilmentShippedNotifications,
  orderCancelledNotifications,
  orderDeliveredNotifications,
  orderPlacedNotifications,
  paymentReceivedNotifications,
  ORDER_TEMPLATES,
} from "./notifications";
import type { Fulfilment, Order } from "./types";

const BUYER = "6b1e9d54-0f2a-4c3b-9d8e-7a6b5c4d3e2f";
const YAEL = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const NOA = "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f";

const ORDER: Order = {
  id: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f",
  buyerId: BUYER,
  status: "awaiting_payment",
  subtotalAgorot: agorot(149_000),
  shippingAgorot: agorot(11_800),
  totalAgorot: agorot(160_800),
  commissionRateBp: 1500,
  currency: "ILS",
  shippingZoneCode: "center",
  placedAt: "2026-09-03T09:00:00.000Z",
  updatedAt: "2026-09-03T09:00:00.000Z",
};

function fulfilment(artistId: string, id: string): Fulfilment {
  return {
    id,
    orderId: ORDER.id,
    artistId,
    status: "paid",
    itemsSubtotalAgorot: agorot(125_000),
    shippingAgorot: agorot(8900),
    shippingTierCode: "large",
    shippedAt: null,
    deliveredAt: null,
    createdAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
  };
}

const YAELS = fulfilment(YAEL, "aaaaaaaa-0000-4000-8000-000000000001");
const NOAS = fulfilment(NOA, "aaaaaaaa-0000-4000-8000-000000000002");

describe("order placed", () => {
  it("tells the buyer and the operator, as the spec requires", () => {
    // `checkout-orders`, *Order placed with the manual adapter*: "both buyer and
    // operator receive instructions by email." Two messages, not one.
    const notifications = orderPlacedNotifications({
      order: ORDER,
      fulfilments: [YAELS, NOAS],
      instructions: "העברה בנקאית",
    });

    expect(notifications.map((n) => n.audience)).toEqual(["buyer", "admin"]);
    expect(notifications[0]).toMatchObject({
      template: ORDER_TEMPLATES.orderPlaced,
      recipientId: BUYER,
    });
    // The operator queue has no recipient: it is a queue, not a person.
    expect(notifications[1]?.recipientId).toBeUndefined();
  });

  it("gives the buyer the full cost breakdown", () => {
    // `checkout-orders` requires item prices, shipping and total in ILS before
    // the buyer confirms; the confirmation email carries the same three.
    const [buyerMessage] = orderPlacedNotifications({
      order: ORDER,
      fulfilments: [YAELS],
      instructions: null,
    });

    expect(buyerMessage?.data).toMatchObject({
      subtotalAgorot: 149_000,
      shippingAgorot: 11_800,
      totalAgorot: 160_800,
      currency: "ILS",
    });
  });

  it("tells the buyer how many parcels to expect, not who they are from", () => {
    // The count is a fact about the delivery. The identities are the artists'.
    const [buyerMessage] = orderPlacedNotifications({
      order: ORDER,
      fulfilments: [YAELS, NOAS],
      instructions: null,
    });

    expect(buyerMessage?.data["parcelCount"]).toBe(2);
    const payload = JSON.stringify(buyerMessage?.data);
    expect(payload).not.toContain(YAEL);
    expect(payload).not.toContain(NOA);
  });
});

describe("payment received", () => {
  it("tells the buyer and asks each artist to dispatch, separately", () => {
    // `checkout-orders`, *Operator confirms payment received*: "the artist is
    // notified to dispatch". One message per artist, because each dispatches
    // their own parcel and neither should learn what the other is sending.
    const notifications = paymentReceivedNotifications({
      order: { ...ORDER, status: "paid" },
      fulfilments: [YAELS, NOAS],
    });

    expect(notifications).toHaveLength(3);
    expect(notifications[0]?.audience).toBe("buyer");

    const artistMessages = notifications.filter((n) => n.audience === "artist");
    expect(artistMessages.map((n) => n.recipientId)).toEqual([YAEL, NOA]);
    expect(artistMessages.every((n) => n.template === ORDER_TEMPLATES.artistDispatchRequested)).toBe(
      true,
    );
  });

  it("does not put one artist's fulfilment in the other artist's message", () => {
    const notifications = paymentReceivedNotifications({
      order: { ...ORDER, status: "paid" },
      fulfilments: [YAELS, NOAS],
    });

    const toYael = notifications.find((n) => n.recipientId === YAEL);
    expect(JSON.stringify(toYael?.data)).not.toContain(NOAS.id);
    expect(toYael?.data["fulfilmentId"]).toBe(YAELS.id);
  });

  it("carries ids rather than the buyer's address", () => {
    // The artist follows the id into `artistFulfilment()`, which is where the
    // state and ownership checks live. A template that had the address pasted
    // into it would have checked nothing.
    const notifications = paymentReceivedNotifications({
      order: { ...ORDER, status: "paid" },
      fulfilments: [YAELS],
    });

    const toArtist = notifications.find((n) => n.audience === "artist");
    expect(Object.keys(toArtist?.data ?? {}).sort()).toEqual([
      "fulfilmentId",
      "itemsSubtotalAgorot",
      "orderId",
      "shippingTierCode",
    ]);
  });
});

describe("shipped and delivered", () => {
  it("tells the buyer which parcel moved, not which artist posted it", () => {
    const [message] = fulfilmentShippedNotifications({
      order: { ...ORDER, status: "shipped" },
      fulfilment: { ...YAELS, status: "shipped" },
      carrierName: "דואר ישראל",
      trackingReference: "RR123456789IL",
    });

    expect(message).toMatchObject({
      audience: "buyer",
      recipientId: BUYER,
      template: ORDER_TEMPLATES.fulfilmentShipped,
    });
    expect(message?.data).toMatchObject({
      carrierName: "דואר ישראל",
      trackingReference: "RR123456789IL",
    });
    expect(JSON.stringify(message?.data)).not.toContain(YAEL);
  });

  it("tells the artists as well as the buyer when the order arrives", () => {
    // `delivered` starts the payout clock (`artist-payouts`), so an artist
    // should not have to poll a dashboard to learn the money is on its way.
    const notifications = orderDeliveredNotifications({
      order: { ...ORDER, status: "delivered" },
      fulfilments: [YAELS, NOAS],
    });

    expect(notifications.map((n) => n.audience)).toEqual(["buyer", "artist", "artist"]);
    expect(notifications.every((n) => n.template === ORDER_TEMPLATES.orderDelivered)).toBe(true);
  });
});

describe("cancellation", () => {
  it("tells the artist as well as the buyer", () => {
    // An artist who saw "sold" and then saw the piece listed again, with no
    // message in between, would reasonably conclude PACHKA had lost their sale.
    const notifications = orderCancelledNotifications({
      order: { ...ORDER, status: "cancelled" },
      fulfilments: [YAELS],
      reason: "שינתה את דעתה",
    });

    expect(notifications.map((n) => n.audience)).toEqual(["buyer", "artist"]);
    expect(notifications[0]?.data["reason"]).toBe("שינתה את דעתה");
  });

  it("does not repeat the cancellation reason to the artist", () => {
    // The buyer's reason is the buyer's. "Changed her mind" is not something an
    // artist needs, and it is a sentence a person wrote about themselves.
    const notifications = orderCancelledNotifications({
      order: { ...ORDER, status: "cancelled" },
      fulfilments: [YAELS],
      reason: "שינתה את דעתה",
    });

    const toArtist = notifications.find((n) => n.audience === "artist");
    expect(JSON.stringify(toArtist?.data)).not.toContain("שינתה את דעתה");
  });
});

describe("the template identifiers", () => {
  it("are namespaced and unique, so a mail layer can switch on them exhaustively", () => {
    const templates = Object.values(ORDER_TEMPLATES);
    expect(new Set(templates).size).toBe(templates.length);
    expect(templates.every((template) => template.startsWith("orders."))).toBe(true);
  });
});
