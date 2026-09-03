/**
 * Who can see what, tested on both surfaces that exist.
 *
 * `checkout-orders`, "Order visibility respects artist anonymity in both
 * directions": an artist sees the buyer's name, phone and address only for
 * their own fulfilment and only after `paid`; the buyer never sees the artist's
 * contact details.
 *
 * TWO SURFACES, TWO SETS OF TESTS
 * -------------------------------
 * `database.db` is the server's own connection — a member of `service_role` —
 * and is what module code runs on. Every policy in the orders migration admits
 * it, so on that surface the MODULE is the control and these tests drive
 * `artistFulfilment` and `buyerOrder`.
 *
 * `database.dataApi` is the authenticator PostgREST connects as, behind `asUser`
 * and `asAnon`. No PACHKA code runs on that path at all: anyone with the anon
 * key can query /rest/v1/<table> directly, and RLS is the only thing in the way
 * (SECURITY.md S0-1). So the same questions are asked again, in SQL, as the
 * artist and as an anonymous visitor.
 *
 * A test that only exercised one of them would pass while the other leaked.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asAnon, asUser, grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import { createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import {
  artistFulfilment,
  artworksDepsFor,
  beginCheckout,
  buyerOrder,
  createManualPaymentProvider,
  listArtistFulfilments,
  markPaymentReceived,
  type CheckoutResult,
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

async function seedBuyer(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

async function seedOperator(database: TestDatabase): Promise<string> {
  const id = randomUUID();
  await database.db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
    id,
  ]);
  await grantAdminRole(database, id);
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
  inventoryType: "unique",
};

/**
 * The buyer's phone number, used as the canary throughout this file.
 *
 * SECURITY.md S1-18's own test says it in these terms: "Seed a fulfilment for A
 * in `awaiting_payment` with buyer phone `0509998888`. As A, fetch it through
 * every available surface. Assert `0509998888` is absent."
 */
const BUYER_PHONE = "0509998888";

const DELIVERY = {
  fullName: "דנה כהן",
  phone: BUYER_PHONE,
  line1: "הרצל 12",
  city: "תל אביב",
  postalCode: "6100000",
  countryCode: "IL",
};

async function publishFor(database: TestDatabase, artistId: string): Promise<string> {
  const deps = artworksDepsFor(ordersDeps(database));
  const draft = await createDraft(deps, artistId, CANVAS);
  return (await publishArtwork(deps, artistId, draft.id)).id;
}

/** Two artists, one buyer, one order spanning both. */
async function twoArtistOrder(database: TestDatabase): Promise<{
  checkout: CheckoutResult;
  yael: string;
  noa: string;
  buyerId: string;
}> {
  const deps = ordersDeps(database);
  const yael = await seedArtist(database.db, "יעל");
  const noa = await seedArtist(database.db, "נועה");
  const buyerId = await seedBuyer(database.db, "דנה כהן");

  const checkout = await beginCheckout(deps, {
    buyerId,
    lines: [
      { artworkId: await publishFor(database, yael) },
      { artworkId: await publishFor(database, noa) },
    ],
    delivery: DELIVERY,
  });

  return { checkout, yael, noa, buyerId };
}

describe("an artist and another artist's fulfilment", () => {
  const database = useTestDatabase();

  it("returns not-found rather than forbidden", async () => {
    // `checkout-orders`, *Artist views another artist's fulfilment*. SECURITY.md
    // S1-18 item 3 gives the reason not-found is the right answer: "a 403
    // confirms the resource exists", which would let an artist enumerate a
    // competitor's sales one identifier at a time.
    const deps = ordersDeps(database);
    const { checkout, yael, noa } = await twoArtistOrder(database);

    const noasFulfilment = checkout.fulfilments.find((f) => f.artistId === noa)!;

    await expect(artistFulfilment(deps, yael, noasFulfilment.id)).rejects.toMatchObject({
      kind: "not_found",
      code: "orders.fulfilment_not_found",
    });

    // Their own is fine, so the rejection above is about ownership rather than
    // about the fulfilment being unreadable for some other reason.
    const own = checkout.fulfilments.find((f) => f.artistId === yael)!;
    await expect(artistFulfilment(deps, yael, own.id)).resolves.toMatchObject({
      fulfilment: { id: own.id, artistId: yael },
    });
  });

  it("lists only the artist's own fulfilments", async () => {
    const deps = ordersDeps(database);
    const { yael, noa } = await twoArtistOrder(database);

    const yaels = await listArtistFulfilments(deps, yael);
    expect(yaels).toHaveLength(1);
    expect(yaels[0]?.artistId).toBe(yael);

    const noas = await listArtistFulfilments(deps, noa);
    expect(noas).toHaveLength(1);
    expect(noas[0]?.artistId).toBe(noa);
  });

  it("shows an artist only their own lines and not the other artist's price", async () => {
    // Two competitors on one marketplace. What the other one charges is not
    // this artist's to read, and the item scope is what withholds it.
    const deps = ordersDeps(database);
    const { checkout, yael } = await twoArtistOrder(database);

    const view = await artistFulfilment(
      deps,
      yael,
      checkout.fulfilments.find((f) => f.artistId === yael)!.id,
    );

    expect(view.items).toHaveLength(1);
    expect(view.items.every((item) => item.artistId === yael)).toBe(true);
  });

  it("hides the other artist's rows on the raw data API too", async () => {
    // The module is not the only path. This is the same question asked of RLS,
    // as the artist, on the connection PostgREST uses.
    const { checkout, yael, noa } = await twoArtistOrder(database);
    const noasFulfilment = checkout.fulfilments.find((f) => f.artistId === noa)!;

    const visible = await asUser(database.dataApi, yael, async (tx) => {
      const { rows } = await tx.query<{ id: string; artist_id: string }>(
        "select id, artist_id from fulfilments",
      );
      return rows;
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.artist_id).toBe(yael);
    expect(visible.map((row) => row.id)).not.toContain(noasFulfilment.id);

    // And the items, which carry the prices.
    const items = await asUser(database.dataApi, yael, async (tx) => {
      const { rows } = await tx.query<{ artist_id: string }>("select artist_id from order_items");
      return rows;
    });
    expect(items.every((row) => row.artist_id === yael)).toBe(true);
  });

  it("does not let an artist see reservations at all", async () => {
    // SECURITY.md S1-18 item 4: "`reservations` is readable only by its own
    // buyer and admins. Otherwise an artist watches who is about to buy, and a
    // competitor watches demand."
    const { yael } = await twoArtistOrder(database);

    const rows = await asUser(database.dataApi, yael, async (tx) => {
      const result = await tx.query("select id from reservations");
      return result.rows;
    });
    expect(rows).toEqual([]);
  });
});

describe("the buyer's contact details reaching the artist", () => {
  const database = useTestDatabase();

  it("are withheld while the order is awaiting payment", async () => {
    // `checkout-orders`, *Artist views an unpaid order*: "the system withholds
    // the buyer's contact details."
    const deps = ordersDeps(database);
    const { checkout, yael } = await twoArtistOrder(database);
    const fulfilmentId = checkout.fulfilments.find((f) => f.artistId === yael)!.id;

    const view = await artistFulfilment(deps, yael, fulfilmentId);

    expect(view.fulfilment.status).toBe("awaiting_payment");
    expect(view.buyer).toBeNull();
    // The canary: the number does not appear anywhere in the response, not just
    // in the field it was expected in.
    expect(JSON.stringify(view)).not.toContain(BUYER_PHONE);
  });

  it("are withheld on the raw data API while awaiting payment", async () => {
    // The column-timing rule that RLS "cannot express" (S1-18) — expressible
    // only because the columns live in their own table.
    const { yael } = await twoArtistOrder(database);

    const rows = await asUser(database.dataApi, yael, async (tx) => {
      const result = await tx.query<{ phone: string }>(
        "select phone from order_shipping_details",
      );
      return result.rows;
    });
    expect(rows).toEqual([]);
  });

  it("are released once the fulfilment is paid, and only then", async () => {
    // `checkout-orders`, *Artist views a paid fulfilment*: "they see the buyer's
    // name, phone, and delivery address for that fulfilment only."
    const deps = ordersDeps(database);
    const { checkout, yael } = await twoArtistOrder(database);
    const operatorId = await seedOperator(database);
    const fulfilmentId = checkout.fulfilments.find((f) => f.artistId === yael)!.id;

    expect((await artistFulfilment(deps, yael, fulfilmentId)).buyer).toBeNull();

    await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });

    const view = await artistFulfilment(deps, yael, fulfilmentId);
    expect(view.buyer).toMatchObject({
      fullName: DELIVERY.fullName,
      phone: BUYER_PHONE,
      line1: DELIVERY.line1,
      city: DELIVERY.city,
    });

    // And on the data API, where the policy is the only control.
    const rows = await asUser(database.dataApi, yael, async (tx) => {
      const result = await tx.query<{ phone: string }>(
        "select phone from order_shipping_details",
      );
      return result.rows;
    });
    expect(rows.map((row) => row.phone)).toEqual([BUYER_PHONE]);
  });

  it("stay hidden from an artist whose own fulfilment was cancelled", async () => {
    // A cancelled fulfilment may have passed through `paid`. There is no reason
    // for an artist to hold a stranger's home address for a parcel they will
    // never send, so the disclosing set is a positive list that excludes it.
    const deps = ordersDeps(database);
    const { checkout, yael } = await twoArtistOrder(database);
    const fulfilmentId = checkout.fulfilments.find((f) => f.artistId === yael)!.id;

    await database.db.query("update fulfilments set status = 'cancelled' where id = $1", [
      fulfilmentId,
    ]);

    const view = await artistFulfilment(deps, yael, fulfilmentId);
    expect(view.buyer).toBeNull();

    const rows = await asUser(database.dataApi, yael, async (tx) => {
      const result = await tx.query("select phone from order_shipping_details");
      return result.rows;
    });
    expect(rows).toEqual([]);
  });
});

describe("the buyer's view", () => {
  const database = useTestDatabase();

  it("shows the whole order and the buyer's own address back to them", async () => {
    const deps = ordersDeps(database);
    const { checkout, buyerId } = await twoArtistOrder(database);

    const view = await buyerOrder(deps, buyerId, checkout.order.id);

    expect(view.order.id).toBe(checkout.order.id);
    expect(view.parcels).toHaveLength(2);
    // Their own data, so no gate.
    expect(view.delivery.phone).toBe(BUYER_PHONE);
  });

  it("carries no artist contact details of any kind", async () => {
    // `checkout-orders`: "The system SHALL NOT show the buyer the artist's
    // contact details at any point." The seeded artist contact row is the thing
    // that must not appear, so it is created and then looked for.
    const deps = ordersDeps(database);
    const { checkout, buyerId, yael } = await twoArtistOrder(database);

    await database.db.query(
      `insert into artist_contact_details (user_id, email, phone, street_address)
       values ($1, 'yael@example.com', '0501112222', 'שדרות רוטשילד 5, תל אביב')`,
      [yael],
    );

    const serialised = JSON.stringify(await buyerOrder(deps, buyerId, checkout.order.id));

    expect(serialised).not.toContain("yael@example.com");
    expect(serialised).not.toContain("0501112222");
    expect(serialised).not.toContain("שדרות רוטשילד");
  });

  it("cannot read another buyer's order", async () => {
    const deps = ordersDeps(database);
    const { checkout } = await twoArtistOrder(database);
    const stranger = await seedBuyer(database.db, "זרה");

    await expect(buyerOrder(deps, stranger, checkout.order.id)).rejects.toMatchObject({
      kind: "not_found",
      code: "orders.not_found",
    });
  });

  it("cannot read another buyer's rows on the data API either", async () => {
    const { checkout } = await twoArtistOrder(database);
    const stranger = await seedBuyer(database.db, "זרה");

    const rows = await asUser(database.dataApi, stranger, async (tx) => {
      const orders = await tx.query<{ id: string }>("select id from orders");
      const details = await tx.query("select phone from order_shipping_details");
      return { orders: orders.rows, details: details.rows };
    });

    expect(rows.orders.map((row) => row.id)).not.toContain(checkout.order.id);
    expect(rows.details).toEqual([]);
  });
});

describe("an anonymous visitor", () => {
  const database = useTestDatabase();

  it("sees nothing at all from any table in this module", async () => {
    // The RLS matrix gives anon "none" on every table here, and the grants are
    // revoked as well as the policies absent — a policy no grant lets you reach
    // is not a defence you can rely on having.
    await twoArtistOrder(database);

    const tables = [
      "orders",
      "order_shipping_details",
      "fulfilments",
      "order_items",
      "order_transitions",
      "reservations",
      "payments",
    ];

    for (const table of tables) {
      await expect(
        asAnon(database.dataApi, (tx) => tx.query(`select * from ${table}`)),
        `anon could read ${table}`,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe("no authenticated role can write anything in this module", () => {
  const database = useTestDatabase();

  it("refuses a buyer amending their own order's total", async () => {
    // SECURITY.md S0-5 item 3: "`orders` has no UPDATE policy for
    // `authenticated` — neither buyer nor artist can amend a placed order."
    const { checkout, buyerId } = await twoArtistOrder(database);

    await expect(
      asUser(database.dataApi, buyerId, (tx) =>
        tx.query("update orders set total_agorot = 1 where id = $1", [checkout.order.id]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    const stored = await database.db.one<{ total_agorot: string }>(
      "select total_agorot from orders where id = $1",
      [checkout.order.id],
    );
    expect(stored.total_agorot).toBe(String(checkout.order.totalAgorot));
  });

  it("refuses a buyer confirming their own reservation", async () => {
    // The double sale by a different road: a buyer who could set `confirmed_at`
    // would own a painting they never paid for.
    const { buyerId } = await twoArtistOrder(database);

    await expect(
      asUser(database.dataApi, buyerId, (tx) =>
        tx.query("update reservations set confirmed_at = now()"),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("refuses a buyer inserting a reservation outside the lock", async () => {
    const { checkout, buyerId } = await twoArtistOrder(database);
    const artworkId = checkout.items[0]!.artworkId;

    await expect(
      asUser(database.dataApi, buyerId, (tx) =>
        tx.query(
          `insert into reservations (artwork_id, buyer_id, unit_index, expires_at)
           values ($1, $2, 5, now() + interval '1 hour')`,
          [artworkId, buyerId],
        ),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("refuses an artist stamping their own fulfilment shipped", async () => {
    // An artist who could UPDATE `fulfilments` could reach `delivered`, which is
    // the payout clock (SECURITY.md S1-10, SPEC-D).
    const { checkout, yael } = await twoArtistOrder(database);
    const fulfilmentId = checkout.fulfilments.find((f) => f.artistId === yael)!.id;

    await expect(
      asUser(database.dataApi, yael, (tx) =>
        tx.query("update fulfilments set status = 'shipped' where id = $1", [fulfilmentId]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});
