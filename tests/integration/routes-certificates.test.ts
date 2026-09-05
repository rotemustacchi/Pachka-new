/**
 * /certificates/[certificateId] and /artists — the route half of both.
 *
 * `certificates-verification.test.ts` already proves the module's page keeps
 * the buyer off it. What is untested until here is the ROUTE's own decision:
 * the composition root wires a `buyerNames` port into `CertificatesDeps`,
 * because a buyer's private copy needs it. That wiring is exactly the kind of
 * change that could put a name on a public page, so it is tested with the
 * application's own `certificatesDeps()` rather than a deps object assembled
 * for the test — otherwise the assertion is about a different object than the
 * one production uses.
 *
 * Nothing is mocked. The sale is carried through the real state machine to a
 * real certificate, and the page is rendered to the markup a browser receives.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "@/shared/db";
import { createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import {
  beginCheckout,
  confirmDelivery,
  markPaymentReceived,
  shipFulfilment,
  transitionFulfilment,
} from "@/modules/orders";
import { recordOperatorReceipt, requestReturn } from "@/modules/shipping";
import {
  PublicVerificationPage,
  VOID_STATEMENT,
  issueCertificatesForFulfilment,
} from "@/modules/certificates";
import { isAppError } from "@/shared/errors";
import { artworksDeps, catalogDeps, certificatesDeps, ordersDeps } from "@/app/_lib/deps";
import { ArtistIndex, listPublishedArtists } from "@/app/artists/ArtistIndex";
import { useTestDatabase, type TestDatabase } from "../harness";

/** Everything about the buyer that must never reach the public page. */
const BUYER = {
  displayName: "Ronit Levi PROFILE-SENTINEL",
  fullName: "Ronit Levi DELIVERY-SENTINEL",
  phone: "PHONE-0521234567-SENTINEL",
  line1: "STREET-12-Nahalat-Binyamin-SENTINEL",
  city: "CITY-TelAviv-SENTINEL",
  postalCode: "6100000",
} as const;

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

async function seedArtist(db: Database, name = "יעל שוורץ"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query(
    "insert into artist_profiles (user_id, display_name, city) values ($1, $2, 'תל אביב')",
    [id, name],
  );
  return id;
}

async function seedPerson(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

interface Sale {
  readonly identifier: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly buyerId: string;
  readonly artistId: string;
  readonly deliveredAt: Date;
  readonly itemSubtotalAgorot: number;
}

/** A complete sale, through the real state machine, to a live certificate. */
async function sellAndCertify(database: TestDatabase): Promise<Sale> {
  const orders = ordersDeps(database.db);
  const artistId = await seedArtist(database.db);
  const buyerId = await seedPerson(database.db, BUYER.displayName);
  const operatorId = await seedPerson(database.db, "מנהלת");

  const draft = await createDraft(artworksDeps(database.db), artistId, CANVAS);
  const artworkId = (await publishArtwork(artworksDeps(database.db), artistId, draft.id)).id;

  const checkout = await beginCheckout(orders, {
    buyerId,
    lines: [{ artworkId }],
    delivery: {
      fullName: BUYER.fullName,
      phone: BUYER.phone,
      line1: BUYER.line1,
      city: BUYER.city,
      postalCode: BUYER.postalCode,
      countryCode: "IL",
    },
  });

  const fulfilmentId = checkout.fulfilments[0]!.id;
  await markPaymentReceived(orders, { orderId: checkout.order.id, operatorId });
  await shipFulfilment(orders, {
    fulfilmentId,
    artistId,
    carrierName: "דואר ישראל",
    trackingReference: "RR123456789IL",
    packagingConfirmed: true,
  });
  await confirmDelivery(orders, { fulfilmentId, actorId: operatorId, actorKind: "admin" });

  const issued = await issueCertificatesForFulfilment(certificatesDeps(database.db), fulfilmentId);

  const row = await database.db.one<{ delivered_at: Date }>(
    "select delivered_at from fulfilments where id = $1",
    [fulfilmentId],
  );

  return {
    identifier: issued.certificates[0]!.id,
    orderId: checkout.order.id,
    fulfilmentId,
    artworkId,
    buyerId,
    artistId,
    deliveredAt: row.delivered_at,
    // Snapshotted server-side by `orders`; never a figure from a request body.
    itemSubtotalAgorot: Number(checkout.items[0]!.lineTotalAgorot),
  };
}

/** Exactly what `/certificates/[certificateId]/page.tsx` renders. */
async function serve(database: TestDatabase, identifier: unknown): Promise<string> {
  const element = await PublicVerificationPage({
    // The application's own wiring, buyer-name port and all.
    deps: certificatesDeps(database.db),
    identifier,
    clientIp: `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
  });
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------

describe("the certificate route", () => {
  const database = useTestDatabase();

  it("discloses no buyer detail, even with the buyer-name port wired into its deps", async () => {
    const sale = await sellAndCertify(database);

    const markup = await serve(database, sale.identifier);

    // Value by value rather than in a loop, so a failure names what leaked.
    expect(markup).not.toContain(BUYER.fullName);
    expect(markup).not.toContain(BUYER.displayName);
    expect(markup).not.toContain("Ronit Levi");
    expect(markup).not.toContain(BUYER.phone);
    expect(markup).not.toContain(BUYER.line1);
    expect(markup).not.toContain(BUYER.city);
    expect(markup).not.toContain(BUYER.postalCode);
    // Not an account id and not an order id either — a purchase record is what
    // must not become public, not merely a name.
    expect(markup).not.toContain(sale.buyerId);
    expect(markup).not.toContain(sale.orderId);
  });

  it("still renders the certificate, so the assertions above cannot pass vacuously", async () => {
    const sale = await sellAndCertify(database);

    const markup = await serve(database, sale.identifier);

    expect(markup).toContain(sale.identifier);
    expect(markup).toContain(CANVAS.title ?? "");
    expect(markup).toContain("יעל שוורץ"); // the artist, who is public
  });

  it("renders a void certificate as void rather than as missing", async () => {
    const sale = await sellAndCertify(database);
    const operatorId = await seedPerson(database.db, "מנהלת שנייה");

    // A real return, through shipping's own API and the orders state machine.
    const opened = await requestReturn(database.db, {
      orderId: sale.orderId,
      fulfilmentId: sale.fulfilmentId,
      artworkId: sale.artworkId,
      buyerId: sale.buyerId,
      artistId: sale.artistId,
      deliveredAt: sale.deliveredAt,
      itemSubtotalAgorot: sale.itemSubtotalAgorot,
    });
    await transitionFulfilment(database.db, {
      fulfilmentId: sale.fulfilmentId,
      to: "return_requested",
      actorId: sale.buyerId,
      actorKind: "buyer",
    });
    await recordOperatorReceipt(database.db, {
      returnId: opened.returnCase.id,
      operatorId,
      condition: "intact",
    });

    const markup = await serve(database, sale.identifier);

    // Someone holding a voided certificate is told the truth. Answering
    // not-found would be a worse answer and would make that response mean two
    // different things.
    expect(markup).toContain(VOID_STATEMENT);
    expect(markup).toContain(sale.identifier);
  });

  it("answers unknown, malformed and never-issued identifiers identically", async () => {
    const unknown = await serve(database, randomUUID()).catch((error: unknown) => error);
    const malformed = await serve(database, "definitely-not-an-identifier").catch(
      (error: unknown) => error,
    );
    const notAString = await serve(database, { toString: () => "x" }).catch(
      (error: unknown) => error,
    );

    // All three become the same 404 in the route. Three different answers would
    // let a prober learn which shape was right.
    expect(isAppError(unknown) && unknown.kind).toBe("not_found");
    expect(isAppError(malformed) && malformed.kind).toBe("not_found");
    expect(isAppError(notAString) && notAString.kind).toBe("not_found");
  });
});

describe("the artist index", () => {
  const database = useTestDatabase();

  it("invites an artist in rather than looking broken, on the day PACHKA opens", async () => {
    const artists = await listPublishedArtists(catalogDeps(database.db));

    expect(artists).toEqual([]);
    expect(renderToStaticMarkup(ArtistIndex({ artists }))).toContain("עוד אין כאן אמנים");
  });

  it("lists an artist exactly when they have published work, so the link resolves", async () => {
    const withWork = await seedArtist(database.db, "יעל שוורץ");
    await seedArtist(database.db, "אמן ללא יצירות");

    const draft = await createDraft(artworksDeps(database.db), withWork, CANVAS);
    await publishArtwork(artworksDeps(database.db), withWork, draft.id);

    const artists = await listPublishedArtists(catalogDeps(database.db));
    const markup = renderToStaticMarkup(ArtistIndex({ artists }));

    // The membership rule is the catalog's, which is also the rule
    // `/artists/<id>` resolves on — so this index cannot link to a 404.
    expect(artists.map((artist) => artist.displayName)).toEqual(["יעל שוורץ"]);
    expect(markup).toContain(`/artists/${withWork}`);
    expect(markup).not.toContain("אמן ללא יצירות");
  });

  it("lists an artist once however many pieces they have published", async () => {
    const artist = await seedArtist(database.db);
    for (const title of ["קו החוף, שקיעה", "קווים מס׳ 7", "מעגלים, פופ"]) {
      const draft = await createDraft(artworksDeps(database.db), artist, { ...CANVAS, title });
      await publishArtwork(artworksDeps(database.db), artist, draft.id);
    }

    const artists = await listPublishedArtists(catalogDeps(database.db));

    expect(artists).toHaveLength(1);
  });
});
