/**
 * When a certificate comes into existence, what it says, and why it cannot be
 * changed afterwards.
 *
 * Every test here drives the REAL sale: `beginCheckout` → `markPaymentReceived`
 * → `shipFulfilment` → `confirmDelivery`, through the `orders` public API,
 * against real Postgres. Nothing is mocked — ARCHITECTURE.md's test policy
 * permits fakes only at external boundaries, and there is no external boundary
 * on this path. A test that inserted a `fulfilments` row with
 * `status = 'delivered'` directly would prove that the issuing SQL runs; it
 * would not prove that a delivery in this system produces a certificate, which
 * is the requirement.
 *
 * The public verification page, buyer privacy and the void state live in
 * `certificates-verification.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import {
  artworksDepsFor,
  beginCheckout,
  confirmDelivery,
  createManualPaymentProvider,
  markPaymentReceived,
  shipFulfilment,
  type OrdersDeps,
} from "@/modules/orders";
import { attachImage, createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import {
  ARTIST_DECLARATION_STATEMENT,
  AI_ASSISTANCE_STATEMENT,
  DECLARATION_VERSION,
  UNIQUE_WORK_STATEMENT,
  CERTIFICATE_TEMPLATES,
  certificatesForFulfilment,
  issueCertificatesForFulfilment,
  orderCertificates,
  toPublicCertificate,
  type CertificatesDeps,
} from "@/modules/certificates";

function ordersDeps(database: TestDatabase): OrdersDeps {
  return { db: database.db, payments: createManualPaymentProvider() };
}

function certsDeps(database: TestDatabase): CertificatesDeps {
  return { db: database.db };
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

async function seedOperator(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

/**
 * `textile_clothing` for the same reason the accounts fixture gives: it is the
 * one medium the publish constraint does not additionally require a depth or a
 * framing answer for, so the fixture stays as small as the constraint allows.
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

const DELIVERY = {
  fullName: "דנה כהן",
  phone: "0521234567",
  line1: "הרצל 12",
  city: "תל אביב",
  postalCode: "6100000",
  countryCode: "IL",
};

async function publishFor(
  database: TestDatabase,
  artistId: string,
  overrides: Partial<ArtworkInput> = {},
): Promise<string> {
  const deps = artworksDepsFor(ordersDeps(database));
  const draft = await createDraft(deps, artistId, { ...CANVAS, ...overrides } as ArtworkInput);
  return (await publishArtwork(deps, artistId, draft.id)).id;
}

interface Sale {
  readonly orderId: string;
  readonly buyerId: string;
  readonly artistId: string;
  readonly fulfilmentIds: readonly string[];
}

/** Checkout and pay, stopping short of dispatch. */
async function placeAndPay(
  database: TestDatabase,
  lines: readonly { artworkId: string; quantity?: number }[],
  buyerId: string,
  artistId: string,
): Promise<Sale> {
  const deps = ordersDeps(database);
  const checkout = await beginCheckout(deps, { buyerId, lines, delivery: DELIVERY });
  await markPaymentReceived(deps, {
    orderId: checkout.order.id,
    operatorId: await seedOperator(database.db),
  });
  return {
    orderId: checkout.order.id,
    buyerId,
    artistId,
    fulfilmentIds: checkout.fulfilments.map((f) => f.id),
  };
}

/** Carry every parcel of a paid order all the way to delivered. */
async function deliverAll(database: TestDatabase, sale: Sale): Promise<void> {
  const deps = ordersDeps(database);
  const { rows } = await database.db.query<{ id: string; artist_id: string }>(
    "select id, artist_id from fulfilments where order_id = $1 order by created_at, id",
    [sale.orderId],
  );
  const operatorId = await seedOperator(database.db);

  for (const fulfilment of rows) {
    await shipFulfilment(deps, {
      fulfilmentId: fulfilment.id,
      artistId: fulfilment.artist_id,
      carrierName: "דואר ישראל",
      trackingReference: `RR${fulfilment.id.replace(/\D/g, "").slice(0, 9).padEnd(9, "0")}IL`,
      packagingConfirmed: true,
    });
    await confirmDelivery(deps, {
      fulfilmentId: fulfilment.id,
      actorId: operatorId,
      actorKind: "admin",
    });
  }
}

async function certificateCount(db: Database, orderId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    "select count(*)::text as count from certificates where order_id = $1",
    [orderId],
  );
  return Number(row.count);
}

describe("a certificate is withheld until the work is delivered", () => {
  const database = useTestDatabase();

  it("does not exist for an order that is paid but not yet delivered", async () => {
    // `authenticity-certificate`, *Certificate withheld before delivery*: "WHEN
    // a buyer views an order that is paid but not yet delivered THEN no
    // certificate is available."
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);

    // The row that would carry it does not exist. Asserted against the table
    // rather than against a read function, so a read that filtered correctly
    // over a table full of premature rows could not pass this.
    expect(await certificateCount(database.db, sale.orderId)).toBe(0);

    // And the buyer's order view says so, with the reason.
    const view = await orderCertificates(certsDeps(database), buyerId, sale.orderId);
    expect(view).toHaveLength(1);
    expect(view[0]!.certificates).toEqual([]);
    expect(view[0]!.withheld).toBe("not_delivered");
  });

  it("refuses to be issued for an undelivered fulfilment even when asked directly", async () => {
    // The read path withholding is not enough on its own: if the write path
    // would mint a row on request, anything that called it early — a retried
    // webhook, an admin tool — would create a certificate for a parcel still
    // in a van.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);

    await expect(
      issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!),
    ).rejects.toMatchObject({ kind: "conflict", code: "certificates.not_delivered" });

    expect(await certificateCount(database.db, sale.orderId)).toBe(0);
  });

  it("appears once the parcel is delivered, so the withholding is not just an outage", async () => {
    // The positive control for the two tests above. Without it they would both
    // pass just as well against a module that never issues anything at all.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);

    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    expect(await certificateCount(database.db, sale.orderId)).toBe(1);

    const view = await orderCertificates(certsDeps(database), buyerId, sale.orderId);
    expect(view[0]!.withheld).toBeNull();
    expect(view[0]!.certificates).toHaveLength(1);
  });
});

describe("one certificate per artwork unit sold", () => {
  const database = useTestDatabase();

  it("produces two certificates for an order containing two artworks", async () => {
    // `authenticity-certificate`, *Order containing two artworks*: "WHEN an
    // order containing two artworks is fully delivered THEN the system
    // generates two separate certificates."
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const first = await publishFor(database, artistId, { title: "קו החוף, שקיעה" });
    const second = await publishFor(database, artistId, { title: "רוח מזרחית" });

    const sale = await placeAndPay(
      database,
      [{ artworkId: first }, { artworkId: second }],
      buyerId,
      artistId,
    );
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const records = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);

    expect(records).toHaveLength(2);
    // SEPARATE certificates: two distinct identifiers, one per artwork, not one
    // document listing both.
    expect(new Set(records.map((r) => r.id)).size).toBe(2);
    expect(new Set(records.map((r) => r.artworkId))).toEqual(new Set([first, second]));
    expect(records.map((r) => r.title).sort()).toEqual(["קו החוף, שקיעה", "רוח מזרחית"]);
  });

  it("produces one certificate per unit of an edition bought together", async () => {
    // "One certificate SHALL be generated per artwork UNIT sold." A line for
    // three units of an edition is three documents, because three different
    // objects leave the studio.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId, {
      inventoryType: "edition",
      stock: 10,
    } as Partial<ArtworkInput>);

    const sale = await placeAndPay(database, [{ artworkId, quantity: 3 }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const records = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);
    expect(records).toHaveLength(3);

    // `authenticity-certificate`, *Edition artwork certificate*: "it states the
    // edition position and total." Three consecutive positions out of ten, and
    // no two the same.
    expect(records.map((r) => r.edition?.position).sort()).toEqual([1, 2, 3]);
    expect(records.every((r) => r.edition?.size === 10)).toBe(true);

    const third = records.find((r) => r.edition?.position === 3)!;
    expect(toPublicCertificate(third, "valid").editionStatement).toBe("עותק 3 מתוך 10");
  });

  it("describes a one-of-a-kind work as one of a kind", async () => {
    // `authenticity-certificate`, *Unique artwork certificate*.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const [record] = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);

    expect(record!.edition).toBeNull();
    expect(toPublicCertificate(record!, "valid").editionStatement).toBe(UNIQUE_WORK_STATEMENT);
  });

  it("issues nothing on a second call, so a retried hook cannot mint duplicates", async () => {
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);

    const first = await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);
    const second = await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    expect(first.issuedCount).toBe(1);
    expect(second.issuedCount).toBe(0);
    expect(await certificateCount(database.db, sale.orderId)).toBe(1);
    // The same document, not a replacement with a new identifier.
    expect(second.certificates[0]!.id).toBe(first.certificates[0]!.id);
  });
});

describe("what the certificate records", () => {
  const database = useTestDatabase();

  it("carries the title, artist, medium, dimensions, year, sale date and image", async () => {
    // Task 10.3's content list, minus the buyer's name and the identifier,
    // which are covered in the verification suite.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId, { yearCreated: 2024 });
    await attachImage(artworksDepsFor(ordersDeps(database)), artistId, artworkId, {
      originalPath: `${artworkId}/original.jpg`,
      displayPath: `${artworkId}/display.jpg`,
      altText: "ים בשקיעה",
    });

    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const [record] = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);
    const view = toPublicCertificate(record!, "valid");

    expect(view.title).toBe("קו החוף, שקיעה");
    expect(view.artistDisplayName).toBe("יעל שוורץ");
    expect(view.mediumLabel).toBeTruthy();
    expect(view.dimensions).toBe("100 × 70 ס״מ");
    expect(view.materials).toBe("אקריליק על בד פשתן");
    expect(view.yearCreated).toBe(2024);
    expect(view.imagePath).toBe(`${artworkId}/display.jpg`);

    // The sale date is when the order was placed, not when it was delivered.
    const placedAt = await database.db.one<{ placed_at: Date }>(
      "select placed_at from orders where id = $1",
      [sale.orderId],
    );
    expect(new Date(view.saleDate).getTime()).toBe(placedAt.placed_at.getTime());
  });

  it("states that the contents are the artist's declaration and unverified by PACHKA", async () => {
    // `authenticity-certificate`, *Disclaimer present*. This is the liability
    // boundary: PACHKA is putting its name on a document about an object it has
    // never seen.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const [record] = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);
    const view = toPublicCertificate(record!, "valid");

    expect(view.declaration).toContain(ARTIST_DECLARATION_STATEMENT);
    // The three things PACHKA specifically does not vouch for are each named,
    // because a vague "not responsible" would disclaim none of them usefully.
    expect(ARTIST_DECLARATION_STATEMENT).toContain("האותנטיות");
    expect(ARTIST_DECLARATION_STATEMENT).toContain("המקוריות");
    expect(ARTIST_DECLARATION_STATEMENT).toContain("PACHKA");

    // The wording is versioned onto the row, so what an issued certificate said
    // survives the next revision of the text.
    expect(record!.declarationVersion).toBe(DECLARATION_VERSION);
  });

  it("states the AI declaration where the artist declared AI assistance", async () => {
    // `authenticity-certificate`, *AI-assisted work*.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const assisted = await publishFor(database, artistId, { aiAssisted: true });
    const sale = await placeAndPay(database, [{ artworkId: assisted }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const [record] = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);
    expect(record!.aiAssisted).toBe(true);
    expect(toPublicCertificate(record!, "valid").declaration).toContain(AI_ASSISTANCE_STATEMENT);
  });

  it("does not claim AI assistance on a work the artist declared unassisted", async () => {
    // The negative control for the test above: a module that appended the AI
    // sentence unconditionally would pass that one and fail this.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId, { aiAssisted: false });
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    const [record] = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);
    const view = toPublicCertificate(record!, "valid");

    expect(view.declaration).not.toContain(AI_ASSISTANCE_STATEMENT);
    // But the disclaimer is still there. It is unconditional.
    expect(view.declaration).toContain(ARTIST_DECLARATION_STATEMENT);
  });

  it("keeps its wording when the artist edits the listing afterwards", async () => {
    // "A generated certificate SHALL NOT be modifiable" is worth nothing if the
    // document reads its title from a table the artist can still edit. This is
    // why every artwork fact is snapshotted onto the row.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);
    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    await database.db.query("update artworks set title = $2 where id = $1", [
      artworkId,
      "שם אחר לגמרי",
    ]);

    const [record] = await certificatesForFulfilment(database.db, sale.fulfilmentIds[0]!);
    expect(record!.title).toBe("קו החוף, שקיעה");
  });
});

describe("an issued certificate is immutable", () => {
  const database = useTestDatabase();

  async function issueOne(database: TestDatabase): Promise<string> {
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);
    const result = await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);
    return result.certificates[0]!.id;
  }

  it("refuses an UPDATE from the server's own connection, and leaves the row alone", async () => {
    // Not "there is no code path that updates it" — that is a claim about the
    // code as it stands today. The DATABASE refuses, so a future code path
    // cannot quietly acquire the ability.
    //
    // The error is `permission denied` rather than the trigger's message, and
    // that is the stronger of the two answers: there is no UPDATE grant on this
    // table for any role, so the statement is rejected before a trigger is
    // reached at all. The trigger is the backstop for the one identity that
    // gets past grants and RLS both — the table owner, which is what a future
    // backfill script runs as — and is asserted structurally below, because no
    // role this harness can connect as is able to reach it.
    const id = await issueOne(database);

    await expect(
      database.db.query("update certificates set title = 'forged' where id = $1", [id]),
    ).rejects.toThrow(/permission denied|immutable/i);

    const row = await database.db.one<{ title: string }>(
      "select title from certificates where id = $1",
      [id],
    );
    expect(row.title).toBe("קו החוף, שקיעה");
  });

  it("refuses a DELETE, so a reversed sale cannot be erased", async () => {
    // The record of what was issued has to survive the reversal: a buyer at
    // resale must be able to tell a void certificate from one that never
    // existed, and deleting the row makes those two cases identical.
    const id = await issueOne(database);

    await expect(
      database.db.query("delete from certificates where id = $1", [id]),
    ).rejects.toThrow(/permission denied|immutable/i);

    expect(
      await database.db.one<{ present: boolean }>(
        "select exists (select 1 from certificates where id = $1) as present",
        [id],
      ),
    ).toEqual({ present: true });
  });

  it("has no UPDATE or DELETE grant for any role, and no policy that could admit one", async () => {
    // The structural half. A grant added later would make the two tests above
    // start passing for the wrong reason — they would fall through to the
    // trigger and still throw — so the absence is asserted directly.
    const { rows: grants } = await database.db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'certificates'
          and privilege_type in ('UPDATE', 'DELETE')`,
    );
    expect(grants).toEqual([]);

    const { rows: policies } = await database.db.query<{ polname: string }>(
      `select p.polname
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relname = 'certificates' and p.polcmd in ('w', 'd')`,
    );
    expect(policies).toEqual([]);
  });

  it("carries a trigger that refuses modification even by the table owner", async () => {
    // The backstop, asserted in the catalog because no role available to this
    // harness can provoke it — the app role is refused by the grant first, and
    // the owner connection is behind `withPrivilegedConnection`, whose reasons
    // are a closed union this module has no business extending.
    //
    // It matters in production specifically: there, the service role BYPASSES
    // row-level security, so policies are not what stops an errant write.
    const row = await database.db.one<{ tgname: string; on_update: boolean; on_delete: boolean }>(
      `select t.tgname,
              (t.tgtype & 16) <> 0 as on_update,
              (t.tgtype & 8)  <> 0 as on_delete
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'certificates' and not t.tgisinternal`,
    );

    expect(row.tgname).toBe("certificates_immutable");
    expect(row.on_update).toBe(true);
    expect(row.on_delete).toBe(true);
  });
});

describe("telling the buyer their certificate is ready", () => {
  const database = useTestDatabase();

  it("returns one buyer notification carrying the identifiers, and sends nothing itself", async () => {
    // `authenticity-certificate`: the certificate is available "from their order
    // view and by emailed link". The message is RETURNED, not sent — the same
    // contract `orders` and `shipping` use, so nobody is emailed about a
    // transaction that then rolled back.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const first = await publishFor(database, artistId, { title: "קו החוף, שקיעה" });
    const second = await publishFor(database, artistId, { title: "רוח מזרחית" });

    const sale = await placeAndPay(
      database,
      [{ artworkId: first }, { artworkId: second }],
      buyerId,
      artistId,
    );
    await deliverAll(database, sale);

    const issued = await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    // One message for the parcel, not one per certificate: two emails about one
    // delivery is how a marketplace teaches people to ignore its mail.
    expect(issued.notifications).toHaveLength(1);
    expect(issued.notifications[0]).toMatchObject({
      audience: "buyer",
      template: CERTIFICATE_TEMPLATES.certificateIssued,
      recipientId: buyerId,
    });
    expect(issued.notifications[0]!.data.identifiers).toEqual(issued.newlyIssued);
    expect(issued.newlyIssued).toHaveLength(2);

    // No buyer name and no assembled URL in the payload. The mail layer resolves
    // the address from `recipientId` and builds the link from the identifier —
    // a template handed a finished URL is one that can be pointed elsewhere by
    // whatever built it.
    const payload = JSON.stringify(issued.notifications[0]!.data);
    expect(payload).not.toContain("דנה כהן");
    expect(payload).not.toContain("http");
  });

  it("says nothing on a repeat call, so a self-heal does not re-email the buyer", async () => {
    // `orderCertificates()` issues anything a delivered fulfilment is owed on
    // every page view. Without this, opening the order twice would send two
    // emails about the same document.
    const artistId = await seedArtist(database.db, "יעל שוורץ");
    const buyerId = await seedBuyer(database.db, "דנה כהן");
    const artworkId = await publishFor(database, artistId);
    const sale = await placeAndPay(database, [{ artworkId }], buyerId, artistId);
    await deliverAll(database, sale);

    await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);
    const again = await issueCertificatesForFulfilment(certsDeps(database), sale.fulfilmentIds[0]!);

    expect(again.newlyIssued).toEqual([]);
    expect(again.notifications).toEqual([]);
    // The certificate is still there and still readable — silence, not absence.
    expect(again.certificates).toHaveLength(1);
  });
});
