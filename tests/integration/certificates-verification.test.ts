/**
 * The public verification page: what a stranger holding an identifier can see,
 * and — the point of this file — what they cannot.
 *
 * WHY THESE TESTS RENDER THE PAGE INSTEAD OF CALLING THE SERIALIZER
 * ----------------------------------------------------------------
 * `toPublicCertificate()` omits the buyer's name. Asserting that it does would
 * prove nothing about what a visitor receives: the page could compose its own
 * query, select a column the projection excludes, and interpolate it into the
 * markup, and a serializer test would stay green through all of it. That gap is
 * exactly how this class of leak survives a suite that looks thorough.
 *
 * So every privacy assertion below runs `PublicVerificationPage` — the real
 * page, fetch and render in one unit — to static markup, and greps the string a
 * browser would actually be sent. The module is arranged so that this is
 * possible: the fetch lives with the render inside the module rather than in
 * `app/`, precisely so a test can execute the whole composition.
 *
 * The approach is `accounts-data-api.test.ts`'s: test the path the attacker
 * takes, not the application's convenience layer, and carry a positive control
 * so the assertions cannot pass vacuously. That file also supplies the
 * discipline about sentinels — long and unmistakable, because a short one
 * matches a UUID by chance and a flaky privacy test is one somebody skips.
 */
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { asAnon, useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import {
  artworksDepsFor,
  beginCheckout,
  confirmDelivery,
  createManualPaymentProvider,
  markPaymentReceived,
  shipFulfilment,
  transitionFulfilment,
  type OrdersDeps,
} from "@/modules/orders";
import { createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import { recordOperatorReceipt, requestReturn } from "@/modules/shipping";
import {
  ARTIST_DECLARATION_STATEMENT,
  BuyerCertificateDocument,
  PublicVerificationPage,
  VOID_STATEMENT,
  buyerCertificate,
  buyerNamesFromOrders,
  issueCertificatesForFulfilment,
  isCertificateIdentifier,
  newCertificateIdentifier,
  verifyCertificate,
  type CertificatesDeps,
} from "@/modules/certificates";

/**
 * Everything about the buyer that must never reach the public page.
 *
 * Long and unmistakable, for the reason `accounts-data-api.test.ts` gives: the
 * markup contains UUIDs, and a short sentinel matches thirty-two hex characters
 * by chance often enough to make this test flaky — and this is the one test
 * nobody should ever have reason to distrust.
 *
 * SECURITY.md S0-6's own wording asks for a buyer named `Ronit Levi`, so that
 * name appears verbatim inside these values and the finding stays greppable.
 */
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

function ordersDeps(database: TestDatabase): OrdersDeps {
  return { db: database.db, payments: createManualPaymentProvider() };
}

function certsDeps(database: TestDatabase): CertificatesDeps {
  return { db: database.db, buyerNames: buyerNamesFromOrders(ordersDeps(database)) };
}

async function seedArtist(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedPerson(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

interface IssuedSale {
  readonly identifier: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly buyerId: string;
  readonly artistId: string;
  readonly deliveredAt: Date;
  readonly itemSubtotalAgorot: number;
}

/**
 * A complete sale, carried through the real state machine to a live
 * certificate. Every test builds its own; nothing is shared.
 */
async function sellAndCertify(
  database: TestDatabase,
  overrides: Partial<ArtworkInput> = {},
): Promise<IssuedSale> {
  const deps = ordersDeps(database);
  const artistId = await seedArtist(database.db, "יעל שוורץ");
  const buyerId = await seedPerson(database.db, BUYER.displayName);
  const operatorId = await seedPerson(database.db, "מנהלת");

  const draft = await createDraft(artworksDepsFor(deps), artistId, {
    ...CANVAS,
    ...overrides,
  } as ArtworkInput);
  const artworkId = (await publishArtwork(artworksDepsFor(deps), artistId, draft.id)).id;

  const checkout = await beginCheckout(deps, {
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
  await markPaymentReceived(deps, { orderId: checkout.order.id, operatorId });
  await shipFulfilment(deps, {
    fulfilmentId,
    artistId,
    carrierName: "דואר ישראל",
    trackingReference: "RR123456789IL",
    packagingConfirmed: true,
  });
  await confirmDelivery(deps, { fulfilmentId, actorId: operatorId, actorKind: "admin" });

  const issued = await issueCertificatesForFulfilment(certsDeps(database), fulfilmentId);

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
    itemSubtotalAgorot: Number(checkout.items[0]!.lineTotalAgorot),
  };
}

/**
 * The public page, rendered exactly as a visitor receives it.
 *
 * `PublicVerificationPage` is an async component, so awaiting it yields the
 * element tree the framework would render; `renderToStaticMarkup` turns that
 * into the bytes. Both steps are the real ones — no test-only rendering path.
 */
async function renderPublicPage(
  database: TestDatabase,
  identifier: unknown,
  clientIp = "203.0.113.7",
): Promise<string> {
  const element = await PublicVerificationPage({
    deps: certsDeps(database),
    identifier,
    clientIp,
  });
  return renderToStaticMarkup(element);
}

describe("the public verification page does not disclose the buyer", () => {
  const database = useTestDatabase();

  it("renders no buyer name and no buyer detail anywhere in the markup", async () => {
    // `authenticity-certificate`, *Public verification does not name the
    // buyer*, and SECURITY.md S0-6 / SPEC-B. The original spec put the buyer's
    // name on this page, which publishes a purchase record naming a private
    // individual — in Israel a reportable personal-data incident.
    const sale = await sellAndCertify(database);

    const markup = await renderPublicPage(database, sale.identifier);

    // Value by value rather than in a loop, so a failure names what leaked.
    expect(markup).not.toContain(BUYER.fullName);
    expect(markup).not.toContain(BUYER.displayName);
    expect(markup).not.toContain("Ronit Levi");
    expect(markup).not.toContain(BUYER.phone);
    expect(markup).not.toContain(BUYER.line1);
    expect(markup).not.toContain(BUYER.city);
    expect(markup).not.toContain(BUYER.postalCode);

    // "or any other buyer detail" — not merely the name. An account id or an
    // order id on a public page is a join key: it links this certificate to
    // every other record about the same person for anyone who holds one of
    // those other records.
    expect(markup).not.toContain(sale.buyerId);
    expect(markup).not.toContain(sale.orderId);
    expect(markup).not.toContain(sale.fulfilmentId);
  });

  it("still renders the artwork, artist, sale date and declaration", async () => {
    // The positive control. Without it, the test above passes just as well
    // against a page that renders nothing at all, or that 404s on every
    // identifier — and a broken page is not a privacy win.
    const sale = await sellAndCertify(database);

    const markup = await renderPublicPage(database, sale.identifier);

    expect(markup).toContain("קו החוף, שקיעה");
    expect(markup).toContain("יעל שוורץ");
    expect(markup).toContain("100 × 70 ס״מ");
    expect(markup).toContain(sale.identifier);
    expect(markup).toContain(ARTIST_DECLARATION_STATEMENT);
  });

  it("renders the buyer's name on the buyer's own copy, so the sentinel is genuinely findable", async () => {
    // The other half of the control, and the one that makes the absence above
    // meaningful: the name IS in the system, IS reachable, and IS rendered —
    // just not on the public page. Without this, a bug that dropped the name
    // everywhere would read as a privacy success.
    const sale = await sellAndCertify(database);

    const document = await buyerCertificate(certsDeps(database), sale.buyerId, sale.identifier);
    const markup = renderToStaticMarkup(BuyerCertificateDocument({ document }));

    expect(markup).toContain(BUYER.fullName);
    expect(markup).toContain("Ronit Levi");
    // And the buyer's copy is otherwise the same document.
    expect(markup).toContain("קו החוף, שקיעה");
    expect(markup).toContain(ARTIST_DECLARATION_STATEMENT);
  });

  it("refuses the buyer's copy to somebody else, with the same not-found a stranger gets", async () => {
    // The private half has to be private, or the split achieves nothing. A
    // not-found rather than a forbidden: a 403 confirms the identifier names a
    // real certificate (SECURITY.md S1-18 item 3).
    const sale = await sellAndCertify(database);
    const stranger = await seedPerson(database.db, "אורח");

    await expect(
      buyerCertificate(certsDeps(database), stranger, sale.identifier),
    ).rejects.toMatchObject({ kind: "not_found", code: "certificates.not_found" });
  });

  it("cannot be read over the data API by anyone holding the anon key", async () => {
    // SECURITY.md S0-6 item 2: with an anon SELECT policy the attacker skips
    // this page entirely — `GET /rest/v1/certificates?select=*` returns the
    // table in one request, using a key that ships in the browser bundle. No
    // grant at all, so the request dies before any policy is consulted and a
    // future permissive policy cannot resurrect the exposure on its own.
    await sellAndCertify(database);

    await expect(
      asAnon(database.dataApi, (tx) => tx.query("select * from certificates")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("a sale reversed by a completed return", () => {
  const database = useTestDatabase();

  it("shows the certificate as void on the public page, and does not delete it", async () => {
    // `authenticity-certificate`, *Sale reversed by return*. Void rather than
    // deleted: a buyer at resale must be able to tell a voided certificate from
    // one that was never issued, and a missing row makes those identical.
    const sale = await sellAndCertify(database);
    const operatorId = await seedPerson(database.db, "מנהלת המחסן");

    const before = await database.db.one<Record<string, unknown>>(
      "select * from certificates where id = $1",
      [sale.identifier],
    );
    expect(await renderPublicPage(database, sale.identifier)).not.toContain(VOID_STATEMENT);

    // The real return, through shipping's own API and the orders state machine.
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
    await transitionFulfilment(database.db, {
      fulfilmentId: sale.fulfilmentId,
      to: "returned",
      actorId: operatorId,
      actorKind: "admin",
    });

    // The page says so, in words rather than only a colour — this document gets
    // photocopied, screenshotted and read aloud by screen readers.
    const markup = await renderPublicPage(database, sale.identifier);
    expect(markup).toContain(VOID_STATEMENT);
    expect(await verifyCertificate(certsDeps(database), {
      identifier: sale.identifier,
      clientIp: "203.0.113.9",
    })).toMatchObject({ validity: "void" });

    // And the row is byte-identical: validity is derived, never written. The
    // whole row is compared rather than a chosen column, so a new mutable flag
    // added later fails here.
    const after = await database.db.one<Record<string, unknown>>(
      "select * from certificates where id = $1",
      [sale.identifier],
    );
    expect(after).toEqual(before);
  });
});

describe("an identifier that does not resolve", () => {
  const database = useTestDatabase();

  it("returns not-found for a well-formed identifier nobody was issued", async () => {
    // `authenticity-certificate`, *Unknown identifier*.
    await expect(
      verifyCertificate(certsDeps(database), {
        identifier: newCertificateIdentifier(),
        clientIp: "203.0.113.20",
      }),
    ).rejects.toMatchObject({ kind: "not_found", code: "certificates.not_found" });
  });

  it("answers a malformed identifier identically, revealing nothing about the shape", async () => {
    // SECURITY.md S0-6 item 5: the same response for a malformed ID, an unknown
    // ID and a well-formed ID that does not exist. A different answer for a
    // malformed one tells an enumerator that their guesses are at least the
    // right SHAPE, which is most of what they need to stop wasting requests.
    const unknown = await verifyCertificate(certsDeps(database), {
      identifier: newCertificateIdentifier(),
      clientIp: "203.0.113.21",
    }).catch((error: unknown) => error);

    for (const malformed of ["1", "not-a-uuid", "", "../../etc/passwd", 42, null]) {
      const answer = await verifyCertificate(certsDeps(database), {
        identifier: malformed,
        clientIp: "203.0.113.21",
      }).catch((error: unknown) => error);

      expect(answer).toMatchObject({ kind: "not_found", code: "certificates.not_found" });
      // Same wording, not merely the same kind: a distinguishable message is a
      // distinguishable response.
      expect((answer as Error).message).toBe((unknown as Error).message);
    }
  });

  it("does not resolve a v1-shaped identifier, which would be partly predictable", async () => {
    // The identifier is 122 bits of CSPRNG inside a v4 UUID. A v1 carries a
    // timestamp and a MAC address, so accepting one would accept a value an
    // attacker can narrow down.
    expect(isCertificateIdentifier("f47ac10b-58cc-11e4-8f2a-0800200c9a66")).toBe(false);
    expect(isCertificateIdentifier(newCertificateIdentifier())).toBe(true);
  });
});

describe("certificate identifiers are not guessable", () => {
  const database = useTestDatabase();

  it("are version-4 UUIDs whose order does not reproduce the order they were issued in", async () => {
    // SECURITY.md S0-6's own test, phrased as it phrases it: assert each ID
    // matches the UUIDv4 shape and that sorting them does not reproduce
    // insertion order. A sequential identifier would make authorization the
    // only defence against harvesting the platform's sales history, and there
    // is no authorization on a public page.
    const issued: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      issued.push((await sellAndCertify(database)).identifier);
    }

    for (const identifier of issued) {
      expect(isCertificateIdentifier(identifier)).toBe(true);
    }

    expect(new Set(issued).size).toBe(issued.length);
    expect([...issued].sort()).not.toEqual(issued);

    // No shared prefix beyond what chance allows. Consecutive identifiers from
    // a counter, or from a timestamp, share a long leading run; these share
    // essentially nothing.
    const prefixes = new Set(issued.map((id) => id.slice(0, 8)));
    expect(prefixes.size).toBe(issued.length);
  });

  it("does not derive the identifier from the order it certifies", async () => {
    // A derived identifier is guessable by anyone who knows the inputs, and a
    // buyer and an artist each already hold half of them.
    const sale = await sellAndCertify(database);

    expect(sale.identifier).not.toBe(sale.orderId);
    expect(sale.identifier).not.toBe(sale.fulfilmentId);
    expect(sale.identifier).not.toBe(sale.artworkId);
    expect(sale.identifier.slice(0, 8)).not.toBe(sale.orderId.slice(0, 8));
  });
});

describe("enumeration of the identifier space", () => {
  const database = useTestDatabase();

  it("is rate limited per client, and the refusal is a 429 rather than a 409", async () => {
    // `authenticity-certificate`, *Enumeration is refused*, and SECURITY.md's
    // cross-cutting rate-limit table: keyed on IP, because the surface is
    // anonymous and there is no account to key on.
    const deps: CertificatesDeps = {
      db: database.db,
      verificationRateLimit: { windowMinutes: 5, maxPerWindow: 3 },
    };
    const walker = "198.51.100.44";

    // Every one of these fails to resolve — which is exactly what an
    // enumerator's requests look like, and why the limiter counts attempts
    // rather than hits.
    for (let i = 0; i < 3; i += 1) {
      await expect(
        verifyCertificate(deps, { identifier: newCertificateIdentifier(), clientIp: walker }),
      ).rejects.toMatchObject({ kind: "not_found" });
    }

    await expect(
      verifyCertificate(deps, { identifier: newCertificateIdentifier(), clientIp: walker }),
    ).rejects.toMatchObject({ kind: "rate_limited", code: "certificates.rate_limited" });
  });

  it("limits the enumerator without locking out everybody else", async () => {
    // Keyed on the client, not global. A limiter that throttled the whole
    // endpoint would let one attacker take the verification page down for every
    // legitimate holder, which trades a data risk for an availability one.
    const deps: CertificatesDeps = {
      db: database.db,
      buyerNames: buyerNamesFromOrders(ordersDeps(database)),
      verificationRateLimit: { windowMinutes: 5, maxPerWindow: 2 },
    };
    const sale = await sellAndCertify(database);

    for (let i = 0; i < 3; i += 1) {
      await verifyCertificate(deps, {
        identifier: newCertificateIdentifier(),
        clientIp: "198.51.100.66",
      }).catch(() => undefined);
    }

    // A different address, unaffected, still resolving a real certificate.
    await expect(
      verifyCertificate(deps, { identifier: sale.identifier, clientIp: "203.0.113.99" }),
    ).resolves.toMatchObject({ validity: "valid", title: "קו החוף, שקיעה" });
  });

  it("counts a refused attempt, so walking the space cannot be done for free", async () => {
    const deps: CertificatesDeps = {
      db: database.db,
      verificationRateLimit: { windowMinutes: 5, maxPerWindow: 50 },
    };
    const walker = "198.51.100.77";

    await verifyCertificate(deps, {
      identifier: "not-a-uuid-at-all",
      clientIp: walker,
    }).catch(() => undefined);

    const row = await database.db.one<{ count: string }>(
      "select count(*)::text as count from certificate_verification_events",
    );
    expect(Number(row.count)).toBe(1);

    // And the address is stored hashed, not raw: this table must not become a
    // log of every IP that has ever looked at a certificate.
    const stored = await database.db.one<{ subject: string }>(
      "select subject from certificate_verification_events limit 1",
    );
    expect(stored.subject).not.toContain(walker);
    expect(stored.subject).toMatch(/^[0-9a-f]{64}$/);
  });
});
