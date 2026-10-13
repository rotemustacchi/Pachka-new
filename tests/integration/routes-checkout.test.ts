/**
 * /checkout and /orders/[orderId] — what those two routes actually do.
 *
 * The thing worth testing hardest here is the one thing that cannot be allowed
 * to be wrong: no amount, zone or size tier is ever taken from the client. So
 * these tests do what an attacker would — send a price, send a total, edit the
 * cart cookie — and assert the server prices the order from its own rows and
 * refuses rather than silently re-pricing.
 *
 * The rest is the manual payment story. PACHKA launches with an adapter that
 * records a payment as pending settlement and waits for a person to see a bank
 * transfer arrive, so `awaiting_payment` is where every new order sits. A buyer
 * who is not told that plainly will assume the order failed.
 *
 * Nothing is mocked, including payment: `createManualPaymentProvider` is the
 * adapter production runs and it reaches no network, so the suite drives the
 * same object a buyer does.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "@/shared/db";
import { createDraft, publishArtwork, unlistArtwork, type ArtworkInput } from "@/modules/artworks";
import {
  beginCheckout,
  previewCheckout,
  revalidateCart,
  type DeliveryInput,
  type OrdersDeps,
} from "@/modules/orders";
import { isAppError } from "@/shared/errors";
import { artworksDeps, certificatesDeps, ordersDeps } from "@/app/_lib/deps";
import { parseCart, serialiseCart, withLine, withoutLine } from "@/app/_cart/cart";
import { CartSummary } from "@/app/checkout/CartSummary";
import { OrderScreen } from "@/app/orders/[orderId]/OrderScreen";
import { useTestDatabase, type TestDatabase } from "../harness";

async function seedArtist(db: Database, name = "יעל שוורץ"): Promise<string> {
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
};

async function publish(
  database: TestDatabase,
  artistId: string,
  overrides: Partial<ArtworkInput> = {},
): Promise<string> {
  const deps = artworksDeps(database.db);
  const draft = await createDraft(deps, artistId, { ...CANVAS, ...overrides });
  await publishArtwork(deps, artistId, draft.id);
  return draft.id;
}

const DELIVERY: DeliveryInput = {
  fullName: "דנה כהן",
  phone: "050-1234567",
  line1: "הרצל 12",
  city: "תל אביב",
  countryCode: "IL",
};

function deps(database: TestDatabase): OrdersDeps {
  return ordersDeps(database.db);
}

// ---------------------------------------------------------------------------

describe("what the checkout believes from the client", () => {
  const database = useTestDatabase();

  it("prices the order from its own rows, whatever the client claims a line costs", async () => {
    const artist = await seedArtist(database.db);
    const artwork = await publish(database, artist);

    const honest = await previewCheckout(deps(database), {
      lines: [{ artworkId: artwork }],
      delivery: DELIVERY,
    });

    // The same order, with the client insisting the piece costs one agora.
    const lied = await previewCheckout(deps(database), {
      lines: [{ artworkId: artwork, displayedUnitPriceAgorot: 1 }],
      delivery: DELIVERY,
    });

    expect(honest.subtotalAgorot).toBe(125_000);
    // Identical: the claimed figure is not an input to the price.
    expect(lied.subtotalAgorot).toBe(honest.subtotalAgorot);
    expect(lied.totalAgorot).toBe(honest.totalAgorot);
  });

  it("aborts rather than re-pricing when the total the buyer saw is not the total it derives", async () => {
    const artist = await seedArtist(database.db);
    const buyer = await seedBuyer(database.db);
    const artwork = await publish(database, artist);

    const error = await beginCheckout(deps(database), {
      buyerId: buyer,
      lines: [{ artworkId: artwork }],
      delivery: DELIVERY,
      displayedTotalAgorot: 1,
    }).catch((caught: unknown) => caught);

    // Refused, not silently charged at either figure — and the refusal is the
    // TOCTOU window closing, not a formatting complaint.
    expect(isAppError(error) && error.code).toBe("orders.total_changed");
  });

  it("takes the shipping zone from the address, and there is no field to override it with", async () => {
    const artist = await seedArtist(database.db);
    const artwork = await publish(database, artist);

    const preview = await previewCheckout(deps(database), {
      lines: [{ artworkId: artwork }],
      delivery: DELIVERY,
    });

    // A real zone, resolved from "תל אביב" against the seeded table, with the
    // seeded rate behind it: standard parcels ship free (OPEN-QUESTIONS #22).
    // `CheckoutRequest` carries no zone and no tier.
    expect(preview.zoneCode).not.toBe("");
    expect(preview.shippingAgorot).toBe(0);
    expect(preview.totalAgorot).toBe(preview.subtotalAgorot + preview.shippingAgorot);
  });

  it("identifies every missing delivery field at once rather than one per round trip", async () => {
    const artist = await seedArtist(database.db);
    const artwork = await publish(database, artist);

    const error = await previewCheckout(deps(database), {
      lines: [{ artworkId: artwork }],
      delivery: { fullName: "", phone: "", line1: "", city: "", countryCode: "IL" },
    }).catch((caught: unknown) => caught);

    expect(isAppError(error) && error.kind).toBe("validation");
    expect(Object.keys((isAppError(error) && error.fields) || {})).toEqual(
      expect.arrayContaining(["fullName", "phone", "line1", "city"]),
    );
  });
});

describe("the cart cookie", () => {
  const database = useTestDatabase();

  it("drops anything malformed instead of erroring, because a mangled cookie is not a 500", () => {
    expect(parseCart(undefined)).toEqual([]);
    expect(parseCart("not json at all")).toEqual([]);
    expect(parseCart('{"artworkId":"x"}')).toEqual([]); // not an array
    expect(parseCart('[{"artworkId":"not-a-uuid"}]')).toEqual([]);
    expect(parseCart('[{"artworkId":"' + randomUUID() + '","quantity":-4}]')[0]?.quantity).toBe(1);
  });

  it("keeps the same artwork on one line however often it is added", () => {
    const id = randomUUID();
    const once = withLine([], { artworkId: id, quantity: 1, priceWhenAddedAgorot: 125_000 });
    const twice = withLine(once, { artworkId: id, quantity: 1, priceWhenAddedAgorot: 999 });

    expect(twice).toHaveLength(1);
    expect(twice[0]?.quantity).toBe(2);
    // The comparison price stays as it was when the line was FIRST added —
    // refreshing it would quietly erase the change it exists to report.
    expect(twice[0]?.priceWhenAddedAgorot).toBe(125_000);
    expect(withoutLine(twice, id)).toEqual([]);
  });

  it("never lets a price in the cookie become an amount", async () => {
    const artist = await seedArtist(database.db);
    const artwork = await publish(database, artist);

    // A cookie edited to claim the piece was added at one agora.
    const tampered = parseCart(
      serialiseCart([{ artworkId: artwork, quantity: 1, priceWhenAddedAgorot: 1 }]),
    );
    const cart = await revalidateCart(database.db, tampered);

    // The line is priced from the artwork row. The tampered figure only makes
    // the cart say the price changed, which is the whole blast radius.
    expect(cart.subtotalAgorot).toBe(125_000);
    expect(cart.lines[0]?.unitPriceAgorot).toBe(125_000);
    expect(cart.lines[0]?.priceChanged).toBe(true);
  });

  it("marks a line that has become unavailable and leaves it out of the total", async () => {
    const artist = await seedArtist(database.db);
    const available = await publish(database, artist);
    const withdrawn = await publish(database, artist, { title: "מעגלים, פופ" });
    await unlistArtwork(artworksDeps(database.db), artist, withdrawn);

    const cart = await revalidateCart(database.db, [
      { artworkId: available },
      { artworkId: withdrawn },
    ]);
    const markup = renderToStaticMarkup(CartSummary({ cart }));

    expect(cart.unavailableArtworkIds).toEqual([withdrawn]);
    // Excluded from the total, marked on the page, and still visible so the
    // buyer knows what happened to it.
    expect(cart.subtotalAgorot).toBe(125_000);
    expect(markup).toContain("הוסרה מהמכירה");
    expect(markup).toContain("מעגלים, פופ");
  });
});

describe("the order page", () => {
  const database = useTestDatabase();

  async function placeOrder(buyerId: string): Promise<string> {
    const artist = await seedArtist(database.db);
    const artwork = await publish(database, artist);
    const result = await beginCheckout(deps(database), {
      buyerId,
      lines: [{ artworkId: artwork }],
      delivery: DELIVERY,
    });
    return result.order.id;
  }

  async function serve(buyerId: string, orderId: string): Promise<string> {
    const screen = await OrderScreen({
      orders: ordersDeps(database.db),
      certificates: certificatesDeps(database.db),
      buyerId,
      orderId,
    });
    return renderToStaticMarkup(screen);
  }

  it("tells the buyer what happens next, because nothing has been paid yet", async () => {
    const buyer = await seedBuyer(database.db);
    const orderId = await placeOrder(buyer);

    const markup = await serve(buyer, orderId);

    // The manual adapter records the payment as pending settlement, so this
    // state is where the order lives until a person sees the transfer.
    expect(markup).toContain("ממתינה לתשלום");
    expect(markup).toContain("התשלום יבוצע בהעברה בנקאית");
    expect(markup).toContain(orderId);
  });

  it("withholds the certificate and says why, rather than showing a gap", async () => {
    const buyer = await seedBuyer(database.db);
    const orderId = await placeOrder(buyer);

    const markup = await serve(buyer, orderId);

    // "No certificate" with no explanation reads as a bug to the person waiting.
    expect(markup).toContain("תעודות מקוריות");
    expect(markup).toMatch(/התעודה תונפק/);
  });

  it("answers not-found for somebody else's order, not forbidden", async () => {
    const buyer = await seedBuyer(database.db);
    const stranger = await seedBuyer(database.db, "רון לוי");
    const orderId = await placeOrder(buyer);

    const error = await serve(stranger, orderId).catch((caught: unknown) => caught);

    // A 403 would confirm the id exists, which is exactly what a prober wants.
    expect(isAppError(error) && error.kind).toBe("not_found");
  });

  it("shows the buyer their own delivery address and no artist contact detail", async () => {
    const buyer = await seedBuyer(database.db);
    const orderId = await placeOrder(buyer);

    const markup = await serve(buyer, orderId);

    // Their own address is their own data, so there is no gate on it.
    expect(markup).toContain("הרצל 12");
    // `BuyerOrderDetail` has no field an artist's email or phone could travel
    // in, which is the protection — not a rule someone has to remember.
    expect(markup).not.toContain("@");
  });
});
