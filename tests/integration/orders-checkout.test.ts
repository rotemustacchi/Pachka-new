/**
 * Checkout: where the money is decided, and the cart that leads to it.
 *
 * The tests here are mostly about ONE attack. SECURITY.md S0-5: "Checkout posts
 * a cart. If the request body carries `unitPrice`, `shippingCost`, `total`, or
 * `commissionRate` — even as a 'display value the server will double-check' —
 * the attacker edits it. Buying a ₪4,000 ceramic for ₪1 is one intercepted
 * request."
 *
 * The defence is structural rather than validating: `CheckoutRequest` has no
 * field the server would spend, and the two figures a client MAY send are
 * compared and thrown away. So the tests assert the two things that can be
 * asserted about a structure — that a hostile body is ignored, and that a stale
 * one aborts the whole transaction rather than being quietly re-priced.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import { createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import {
  artworksDepsFor,
  beginCheckout,
  checkoutableLines,
  createManualPaymentProvider,
  previewCheckout,
  revalidateCart,
  validateDelivery,
  type OrdersDeps,
} from "@/modules/orders";

function ordersDeps(database: TestDatabase): OrdersDeps {
  return { db: database.db, payments: createManualPaymentProvider() };
}

async function seedArtist(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedBuyer(db: Database, name = "דנה כהן"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

/**
 * 100 x 70 cm, 1850 g. With the packed-depth fallback that is a parcel of
 * 1000 x 700 x 50 mm, which fits the seeded `large` tier and nothing smaller.
 * Priced at 8900 agorot by `useTestDatabaseWithRates`.
 */
const CANVAS: ArtworkInput = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים.",
  priceAgorot: 125_000,
  heightCm: 100,
  widthCm: 70,
  weightGrams: 1850,
  materials: "אקריליק על בד פשתן",
  leadTimeDays: 5,
  medium: "textile_clothing",
  styles: ["minimalist"],
  moods: ["calm"],
  affirmsOriginality: true,
  aiAssisted: false,
  inventoryType: "unique",
};

/** 30 x 20 cm, 500 g — 300 x 200 x 50 mm, which fits the seeded `small` tier. */
const PRINT: ArtworkInput = {
  ...CANVAS,
  title: "מגדלור",
  priceAgorot: 24_000,
  heightCm: 30,
  widthCm: 20,
  weightGrams: 500,
};

const LARGE_TIER_CENTER_AGOROT = 8900;
const SMALL_TIER_CENTER_AGOROT = 2900;

/**
 * Standard parcels ship free (OPEN-QUESTIONS #22), so the seeded rates are all
 * zero, and a zero proves nothing about who decides the shipping charge or how
 * two parcels add up. Every test here prices the table itself.
 */
function useTestDatabaseWithRates(): TestDatabase {
  const database = useTestDatabase();
  beforeEach(async () => {
    await database.db.query(
      `update shipping_rates r
          set amount_agorot = case t.code when 'small' then $1::bigint when 'large' then $2::bigint else 4900 end
         from shipping_tiers t
        where t.id = r.tier_id`,
      [SMALL_TIER_CENTER_AGOROT, LARGE_TIER_CENTER_AGOROT],
    );
  });
  return database;
}

async function publishFor(
  database: TestDatabase,
  artistId: string,
  input: ArtworkInput,
): Promise<string> {
  const deps = artworksDepsFor(ordersDeps(database));
  const draft = await createDraft(deps, artistId, input);
  return (await publishArtwork(deps, artistId, draft.id)).id;
}

const DELIVERY = {
  fullName: "דנה כהן",
  phone: "0521234567",
  line1: "הרצל 12",
  city: "תל אביב",
  postalCode: "6100000",
  countryCode: "IL",
};

describe("the server decides the money", () => {
  const database = useTestDatabaseWithRates();

  it("ignores a client-supplied price and charges the artwork's own", async () => {
    // SECURITY.md S0-5's first test, in the shape this module's types allow it
    // to be written: `displayedUnitPriceAgorot` is the ONLY money field a client
    // can put in the body, so a hostile body is one that lies in it.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, { ...CANVAS, priceAgorot: 400_000 });

    // Truthful client, hostile total: the price matches, but the buyer claims
    // the whole order costs one agora.
    await expect(
      beginCheckout(deps, {
        buyerId,
        lines: [{ artworkId, displayedUnitPriceAgorot: 400_000 }],
        delivery: DELIVERY,
        displayedTotalAgorot: 1,
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "orders.total_changed" });

    // And with no claims at all, the server prices it from the row.
    const result = await beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId }],
      delivery: DELIVERY,
    });

    expect(result.order.subtotalAgorot).toBe(400_000);
    expect(result.order.shippingAgorot).toBe(LARGE_TIER_CENTER_AGOROT);
    expect(result.order.totalAgorot).toBe(400_000 + LARGE_TIER_CENTER_AGOROT);
    expect(result.items[0]?.unitPriceAgorot).toBe(400_000);

    // Straight from the row, not from the returned object: an in-memory value
    // that never reached the database would pass the assertions above.
    const stored = await database.db.one<{ total_agorot: string; commission_rate_bp: number }>(
      "select total_agorot, commission_rate_bp from orders where id = $1",
      [result.order.id],
    );
    expect(stored.total_agorot).toBe(String(400_000 + LARGE_TIER_CENTER_AGOROT));
  });

  it("snapshots the commission rate from app_config, not from the request", async () => {
    // SECURITY.md S0-5 item 3: "an artist checking out through their own device
    // sets it to 0 — or an attacker sets it to 10000 and the artist is paid
    // nothing." There is no request field for it, so the assertion is that the
    // stored value is the configured one.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, CANVAS);

    const result = await beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId }],
      delivery: DELIVERY,
    });

    // The registry's default: 1500 bp = 15%.
    expect(result.order.commissionRateBp).toBe(1500);
  });

  it("aborts entirely when the price changed since the buyer looked", async () => {
    // The TOCTOU case. SECURITY.md S0-5: "Begin checkout. In a second
    // connection, update the artwork price between the cart view and the
    // confirm... Assert the order is rejected with a price-changed error and
    // that NO order row and NO reservation row survive."
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, { ...CANVAS, priceAgorot: 50_000 });

    // The buyer sees 50,000 and starts filling in the form. The artist
    // re-prices in the meantime.
    await database.db.query("update artworks set price_agorot = 500000 where id = $1", [artworkId]);

    await expect(
      beginCheckout(deps, {
        buyerId,
        lines: [{ artworkId, displayedUnitPriceAgorot: 50_000 }],
        delivery: DELIVERY,
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "orders.price_changed" });

    // Nothing survives the rollback — not the order, not the hold, not the
    // payment row. The whole point of doing the comparison inside the
    // transaction rather than before it.
    const orders = await database.db.one<{ count: string }>(
      "select count(*)::text as count from orders",
    );
    const holds = await database.db.one<{ count: string }>(
      "select count(*)::text as count from reservations",
    );
    const payments = await database.db.one<{ count: string }>(
      "select count(*)::text as count from payments",
    );
    expect([orders.count, holds.count, payments.count]).toEqual(["0", "0", "0"]);
  });
});

describe("delivery details", () => {
  const database = useTestDatabaseWithRates();

  it("names every missing field at once and creates nothing", async () => {
    // `checkout-orders`: "the system blocks the order and identifies the missing
    // fields" — plural, so one round trip rather than five.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, CANVAS);

    const attempt = beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId }],
      delivery: { ...DELIVERY, phone: "", line1: "", city: "" },
    });

    await expect(attempt).rejects.toMatchObject({
      kind: "validation",
      code: "orders.delivery_incomplete",
    });
    await attempt.catch((error: unknown) => {
      const fields = (error as { fields?: Record<string, string[]> }).fields ?? {};
      expect(Object.keys(fields).sort()).toEqual(["city", "line1", "phone"]);
    });

    const holds = await database.db.one<{ count: string }>(
      "select count(*)::text as count from reservations",
    );
    expect(holds.count).toBe("0");
  });

  it("rejects a phone number too short to call", () => {
    expect(() => validateDelivery({ ...DELIVERY, phone: "052" })).toThrowError(
      expect.objectContaining({ code: "orders.delivery_incomplete" }),
    );
  });

  it("keeps the optional lines optional", () => {
    const details = validateDelivery({ ...DELIVERY, line2: "  ", postalCode: undefined });
    expect(details.line2).toBeNull();
    expect(details.postalCode).toBeNull();
  });
});

describe("an order spanning two artists", () => {
  const database = useTestDatabaseWithRates();

  it("splits into one fulfilment per artist, each priced as its own parcel", async () => {
    // `checkout-orders`: "the system creates two fulfilment records, each
    // visible only to its own artist, under one buyer-facing order."
    const deps = ordersDeps(database);
    const yael = await seedArtist(database.db, "יעל");
    const noa = await seedArtist(database.db, "נועה");
    const buyerId = await seedBuyer(database.db);

    const canvas = await publishFor(database, yael, CANVAS);
    const print = await publishFor(database, noa, PRINT);

    const result = await beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId: canvas }, { artworkId: print }],
      delivery: DELIVERY,
    });

    expect(result.fulfilments).toHaveLength(2);
    expect(result.fulfilments.map((f) => f.artistId).sort()).toEqual([yael, noa].sort());

    // Two artists, two parcels, two charges.
    expect(result.order.shippingAgorot).toBe(
      LARGE_TIER_CENTER_AGOROT + SMALL_TIER_CENTER_AGOROT,
    );
    expect(result.order.subtotalAgorot).toBe(125_000 + 24_000);

    const byArtist = new Map(result.fulfilments.map((f) => [f.artistId, f]));
    expect(byArtist.get(yael)?.shippingAgorot).toBe(LARGE_TIER_CENTER_AGOROT);
    expect(byArtist.get(yael)?.itemsSubtotalAgorot).toBe(125_000);
    expect(byArtist.get(noa)?.shippingAgorot).toBe(SMALL_TIER_CENTER_AGOROT);
    expect(byArtist.get(noa)?.itemsSubtotalAgorot).toBe(24_000);

    // Every item hangs off its own artist's fulfilment, which is what makes the
    // per-artist read in `views.ts` able to scope by fulfilment at all.
    for (const item of result.items) {
      expect(item.fulfilmentId).toBe(byArtist.get(item.artistId)?.id);
    }
  });

  it("charges one parcel when both pieces come from the same artist", async () => {
    // `shipping-and-returns`: shipping is charged "per fulfilment using the
    // largest applicable size tier, not the sum of the individual tiers". Two
    // pieces from one artist travel in one box, so summing would charge the
    // buyer twice for a box posted once.
    const deps = ordersDeps(database);
    const yael = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);

    const canvas = await publishFor(database, yael, CANVAS);
    const print = await publishFor(database, yael, PRINT);

    const result = await beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId: canvas }, { artworkId: print }],
      delivery: DELIVERY,
    });

    expect(result.fulfilments).toHaveLength(1);
    // The larger tier alone, stated as a number rather than recomputed, so a
    // change in the rule fails this test instead of moving with it.
    expect(result.order.shippingAgorot).toBe(LARGE_TIER_CENTER_AGOROT);
  });
});

describe("the cart", () => {
  const database = useTestDatabaseWithRates();

  it("marks a line unavailable once someone else has bought it, and excludes it from the total", async () => {
    // `checkout-orders`, *Artwork sells while in another buyer's cart*: the line
    // "is marked unavailable, is excluded from the total, and cannot be checked
    // out".
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const firstBuyer = await seedBuyer(database.db, "ראשונה");
    const secondBuyer = await seedBuyer(database.db, "שנייה");

    const canvas = await publishFor(database, artistId, CANVAS);
    const print = await publishFor(database, artistId, PRINT);

    // Both are in the second buyer's cart while the first buyer takes the canvas.
    await beginCheckout(deps, {
      buyerId: firstBuyer,
      lines: [{ artworkId: canvas }],
      delivery: DELIVERY,
    });

    const cart = await revalidateCart(database.db, [
      { artworkId: canvas },
      { artworkId: print },
    ]);

    const canvasLine = cart.lines.find((line) => line.artworkId === canvas);
    const printLine = cart.lines.find((line) => line.artworkId === print);

    expect(canvasLine?.available).toBe(false);
    expect(canvasLine?.unavailableReason).toBe("sold");
    expect(printLine?.available).toBe(true);

    // Excluded from the total: the print only.
    expect(cart.subtotalAgorot).toBe(24_000);
    expect(cart.unavailableArtworkIds).toEqual([canvas]);

    // And cannot be checked out: it is simply not among the lines offered.
    expect(checkoutableLines(cart).map((line) => line.artworkId)).toEqual([print]);

    // The second buyer, who has nothing else to buy either way, is still
    // refused if they try the sold one directly.
    await expect(
      beginCheckout(deps, {
        buyerId: secondBuyer,
        lines: [{ artworkId: canvas }],
        delivery: DELIVERY,
      }),
    ).rejects.toMatchObject({ code: "orders.artwork_unavailable" });
  });

  it("shows the current price and flags that it changed", async () => {
    // `checkout-orders`, *Price changed since adding*.
    const artistId = await seedArtist(database.db, "יעל");
    const artworkId = await publishFor(database, artistId, { ...CANVAS, priceAgorot: 125_000 });

    await database.db.query("update artworks set price_agorot = 149000 where id = $1", [artworkId]);

    const cart = await revalidateCart(database.db, [
      { artworkId, priceWhenAddedAgorot: 125_000 },
    ]);

    const line = cart.lines[0];
    expect(line?.priceChanged).toBe(true);
    expect(line?.unitPriceAgorot).toBe(149_000);
    expect(line?.priceWhenAddedAgorot).toBe(125_000);
    expect(cart.changedArtworkIds).toEqual([artworkId]);
    // The CURRENT price is what the total uses. The remembered one is never
    // spent, here or at checkout.
    expect(cart.subtotalAgorot).toBe(149_000);
  });

  it("does not flag a price that has not moved", async () => {
    const artistId = await seedArtist(database.db, "יעל");
    const artworkId = await publishFor(database, artistId, { ...CANVAS, priceAgorot: 125_000 });

    const cart = await revalidateCart(database.db, [
      { artworkId, priceWhenAddedAgorot: 125_000 },
    ]);

    expect(cart.lines[0]?.priceChanged).toBe(false);
    expect(cart.changedArtworkIds).toEqual([]);
  });

  it("reserves nothing", async () => {
    // `checkout-orders`: "Adding an artwork to a cart SHALL NOT reserve it." A
    // cart that took a hold would be SECURITY.md S1-17's inventory hostage with
    // no attacker required.
    const artistId = await seedArtist(database.db, "יעל");
    const artworkId = await publishFor(database, artistId, CANVAS);

    await revalidateCart(database.db, [{ artworkId }]);
    await revalidateCart(database.db, [{ artworkId }]);

    const holds = await database.db.one<{ count: string }>(
      "select count(*)::text as count from reservations",
    );
    expect(holds.count).toBe("0");
  });

  it("drops a removed artwork from the cart entirely rather than marking it", async () => {
    // Moderation takedown is one-way and terminal for every role
    // (ARCHITECTURE.md), and catalog-browse requires a removed artwork to read
    // as not-found. Leaving it in the cart as "unavailable" would keep the
    // takedown visible to whoever was holding it.
    const artistId = await seedArtist(database.db, "יעל");
    const artworkId = await publishFor(database, artistId, CANVAS);
    await database.db.query("update artworks set status = 'removed' where id = $1", [artworkId]);

    const cart = await revalidateCart(database.db, [{ artworkId }]);
    expect(cart.lines).toEqual([]);
    expect(cart.checkoutable).toBe(false);
  });
});

describe("checkout request shape", () => {
  const database = useTestDatabaseWithRates();

  it("refuses the same artwork twice in one order", async () => {
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, CANVAS);

    await expect(
      beginCheckout(deps, {
        buyerId,
        lines: [{ artworkId }, { artworkId }],
        delivery: DELIVERY,
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "orders.duplicate_line" });
  });

  it("refuses an empty checkout", async () => {
    const deps = ordersDeps(database);
    const buyerId = await seedBuyer(database.db);

    await expect(
      beginCheckout(deps, { buyerId, lines: [], delivery: DELIVERY }),
    ).rejects.toMatchObject({ kind: "validation", code: "orders.empty_checkout" });
  });

  it("refuses an address in no shipping zone, holding nothing", async () => {
    // `shipping-and-returns`: an address matching no zone blocks checkout. The
    // assertion that matters is the second one — a refused quote must not leave
    // the inventory held.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, CANVAS);

    await expect(
      beginCheckout(deps, {
        buyerId,
        lines: [{ artworkId }],
        delivery: { ...DELIVERY, city: "עיירה שאינה קיימת", postalCode: "0000000" },
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "shipping.address_outside_zones" });

    const holds = await database.db.one<{ count: string }>(
      "select count(*)::text as count from reservations",
    );
    expect(holds.count).toBe("0");
  });
});

describe("the cost breakdown before confirming", () => {
  const database = useTestDatabaseWithRates();

  it("shows item prices, shipping and total in ILS without reserving anything", async () => {
    // `checkout-orders`, *Cost breakdown before confirmation*: "the system
    // displays item prices, shipping cost, and the total in ILS before any
    // payment action". The second assertion is the one that makes this function
    // worth having: a preview that reserved would let any browsing visitor take
    // the catalog off the market just by asking what postage costs.
    const deps = ordersDeps(database);
    const yael = await seedArtist(database.db, "יעל");
    const noa = await seedArtist(database.db, "נועה");

    const preview = await previewCheckout(deps, {
      lines: [
        { artworkId: await publishFor(database, yael, CANVAS) },
        { artworkId: await publishFor(database, noa, PRINT) },
      ],
      delivery: DELIVERY,
    });

    expect(preview.subtotalAgorot).toBe(125_000 + 24_000);
    expect(preview.shippingAgorot).toBe(LARGE_TIER_CENTER_AGOROT + SMALL_TIER_CENTER_AGOROT);
    expect(preview.totalAgorot).toBe(125_000 + 24_000 + LARGE_TIER_CENTER_AGOROT + SMALL_TIER_CENTER_AGOROT);
    expect(preview.currency).toBe("ILS");
    expect(preview.parcelCount).toBe(2);
    expect(preview.zoneCode).toBe("center");

    const holds = await database.db.one<{ count: string }>(
      "select count(*)::text as count from reservations",
    );
    const orders = await database.db.one<{ count: string }>(
      "select count(*)::text as count from orders",
    );
    expect([holds.count, orders.count]).toEqual(["0", "0"]);
  });

  it("agrees exactly with what the checkout then charges", async () => {
    // The preview's total is what the client sends back as
    // `displayedTotalAgorot`. If the two derivations could disagree, that
    // integrity check would reject every honest buyer.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const buyerId = await seedBuyer(database.db);
    const artworkId = await publishFor(database, artistId, CANVAS);

    const preview = await previewCheckout(deps, {
      lines: [{ artworkId }],
      delivery: DELIVERY,
    });

    const result = await beginCheckout(deps, {
      buyerId,
      lines: [{ artworkId }],
      delivery: DELIVERY,
      displayedTotalAgorot: preview.totalAgorot,
    });

    expect(result.order.subtotalAgorot).toBe(preview.subtotalAgorot);
    expect(result.order.shippingAgorot).toBe(preview.shippingAgorot);
    expect(result.order.totalAgorot).toBe(preview.totalAgorot);
  });

  it("blocks the preview on incomplete delivery details, naming the fields", async () => {
    // `checkout-orders`, *Incomplete delivery details*. Caught at the preview
    // too, so the buyer is told before they get as far as confirming.
    const deps = ordersDeps(database);
    const artistId = await seedArtist(database.db, "יעל");
    const artworkId = await publishFor(database, artistId, CANVAS);

    await expect(
      previewCheckout(deps, {
        lines: [{ artworkId }],
        delivery: { ...DELIVERY, phone: "", city: "" },
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "orders.delivery_incomplete" });
  });
});
