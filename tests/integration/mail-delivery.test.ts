/**
 * The transport against the real modules and the real database.
 *
 * `tests/unit/mail-transport.test.ts` proves the adapters in isolation. This
 * file proves the two things that can only be shown with Postgres underneath:
 *
 *   1. Delivery does not break the operation that triggered it. `moderation`'s
 *      spec is explicit that a report is still recorded when its notification
 *      fails, and the assertion is a SELECT against `reports` after a transport
 *      that genuinely rejected — not a check that a fake was called.
 *   2. The composition root's `addressBook` resolves an address out of the
 *      tables that hold one, including the private `artist_contact_details`
 *      that only this privileged connection can read.
 *
 * The provider's HTTP endpoint is the only fake here and it is injected as
 * `fetch`, so nothing in this file can reach the network. Where a test wants
 * "mail is not configured", it uses the logging adapter, which is the same
 * object a deployment without `RESEND_API_KEY` actually gets.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asAnon, grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import { fileReport, type ModerationDeps } from "@/modules/moderation";
import { captureNotifyRequest, hashSubject } from "@/modules/matchmaker";
import { setConfig } from "@/shared/config";
import {
  createLoggingMailer,
  createResendMailer,
  dispatchNotifications,
  type FetchLike,
  type LoggingMailer,
  type MailTransport,
} from "@/shared/mail";
import { addressBook } from "@/app/_lib/deps";
import type { Database } from "@/shared/db";

// ---------------------------------------------------------------------------
// The one fake: the provider's HTTP endpoint.
// ---------------------------------------------------------------------------

interface Posted {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

function endpoint(status = 200, errorBody = '{"name":"internal_error"}') {
  const posted: Posted[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as Posted;
    if (status >= 200 && status < 300) posted.push(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (status >= 200 && status < 300 ? "{}" : errorBody),
    };
  };
  return { posted, fetch };
}

function resend(fetch: FetchLike): MailTransport {
  return createResendMailer({ apiKey: "re_test", from: "PACHKA <hello@pachka.test>", fetch });
}

const SILENT = { warn: () => {}, info: () => {} };

function logging(): LoggingMailer {
  return createLoggingMailer({ reason: "no key in tests", log: SILENT });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seedAccount(database: TestDatabase, roles: readonly string[], name: string) {
  const db = database.db;
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  for (const role of roles) {
    if (role === "admin") await grantAdminRole(database, id);
    else await db.query("insert into user_roles (user_id, role) values ($1, $2)", [id, role]);
  }
  return id;
}

async function seedArtist(database: TestDatabase, name = "יעל שוורץ", email: string | null = null) {
  const id = await seedAccount(database, ["buyer", "artist"], name);
  await database.db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [
    id,
    name,
  ]);
  if (email !== null) {
    await database.db.query(
      "insert into artist_contact_details (user_id, email) values ($1, $2)",
      [id, email],
    );
  }
  return id;
}

async function seedPublishedArtwork(db: Database, artistId: string, title = "קו החוף, שקיעה") {
  const { rows } = await db.query<{ id: string }>(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods, is_framed,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, 'published', $2, 'ציור שמן של הנמל הישן.', 125000,
       400, 300, 1200, 'שמן על בד', 5,
       'painting_illustration', array['abstract']::text[], array['calm']::text[], true,
       $1, now(), false, now()
     ) returning id`,
    [artistId, title],
  );
  return rows[0]!.id;
}

function depsWith(db: Database, mailer: ModerationDeps["mailer"]): ModerationDeps {
  return { db, auth: new FakeAuthGateway(), mailer, siteUrl: "https://pachka.test" };
}

// ---------------------------------------------------------------------------
// Delivery must not break the operation that triggered it
// ---------------------------------------------------------------------------

describe("a notification that fails", () => {
  const database = useTestDatabase();

  it("leaves the report recorded, which is what the spec requires", async () => {
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    // A provider that is genuinely refusing, not a fake that pretends to.
    const deps = depsWith(database.db, resend(endpoint(500).fetch));

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "other",
      details: "משהו לא מסתדר עם הרישום הזה.",
      clientId: "198.51.100.9",
    });

    expect(result.reportId).toBeTruthy();

    const { rows } = await database.db.query<{
      id: string;
      status: string;
      notified_at: Date | null;
      notification_error: string | null;
    }>("select id, status, notified_at, notification_error from reports where id = $1", [
      result.reportId,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.notified_at).toBeNull();
    expect(rows[0]!.notification_error).toContain("500");
  });

  it("does not write an address into reports.notification_error", async () => {
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    // The provider quotes the offending address back. The column must not.
    const deps = depsWith(
      database.db,
      resend(endpoint(422, '{"name":"validation_error","message":"Invalid `to`: operator@pachka.test"}').fetch),
    );

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "other",
      details: "בדיקה.",
      clientId: "198.51.100.10",
    });

    const { rows } = await database.db.query<{ notification_error: string | null }>(
      "select notification_error from reports where id = $1",
      [result.reportId],
    );

    expect(rows[0]!.notification_error).not.toContain("operator@pachka.test");
    expect(rows[0]!.notification_error).toContain("validation_error");
  });

  it("still lets an anonymous stranger file the report the transport could not announce", async () => {
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    const deps = depsWith(database.db, resend(endpoint(503).fetch));

    await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "not_original_work",
      clientId: "203.0.113.4",
    });

    // The artwork is untouched and still visible: a failed alert is not a
    // takedown, and it is not an outage either.
    const visible = await asAnon(database.dataApi, (sql) =>
      sql.query("select id from artworks where id = $1 and status = 'published'", [artworkId]),
    );
    expect(visible.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The operator alert, which is the thing that was never arriving
// ---------------------------------------------------------------------------

describe("the operator alert", () => {
  const database = useTestDatabase();

  it("reaches the configured address, carrying the reason and the queue link", async () => {
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    const provider = endpoint();
    const deps = depsWith(database.db, resend(provider.fetch));

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "undeclared_ai",
      details: "נראה כמו תמונה שנוצרה במחולל.",
      clientId: "198.51.100.11",
    });

    expect(provider.posted).toHaveLength(1);
    const sent = provider.posted[0]!;
    expect(sent.to).toEqual(["operator@pachka.test"]);
    expect(sent.subject).toContain(artworkId);
    expect(sent.text).toContain(`https://pachka.test/admin/queue/artwork/${artworkId}`);
    expect(sent.text).toContain("נראה כמו תמונה שנוצרה במחולל.");
    // The reader gets a right-to-left part too, not only the plain one.
    expect(sent.html).toContain('dir="rtl"');

    const { rows } = await database.db.query<{ notified_at: Date | null }>(
      "select notified_at from reports where id = $1",
      [result.reportId],
    );
    expect(rows[0]!.notified_at).not.toBeNull();
  });

  it("is recorded rather than lost when no provider is configured at all", async () => {
    // This is what `appMailer()` returns with no RESEND_API_KEY — the state of
    // every developer machine, and of a deployment nobody has finished wiring.
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    const mailer = logging();

    const result = await fileReport(depsWith(database.db, mailer), {
      subject: { type: "artwork", artworkId },
      reason: "offensive_content",
      clientId: "198.51.100.12",
    });

    expect(mailer.records).toHaveLength(1);
    expect(mailer.records[0]!.to).toBe("operator@pachka.test");
    expect(mailer.records[0]!.body).toContain(artworkId);

    // Recorded as notified, because the message was not dropped: it is in the
    // log, and `mailHealth()` says the transport is unconfigured.
    const { rows } = await database.db.query<{
      notified_at: Date | null;
      notification_error: string | null;
    }>("select notified_at, notification_error from reports where id = $1", [result.reportId]);
    expect(rows[0]!.notified_at).not.toBeNull();
    expect(rows[0]!.notification_error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Notify-me, the other module that owns its own mailer
// ---------------------------------------------------------------------------

describe("the notify-me confirmation", () => {
  const database = useTestDatabase();

  const confirmUrl = (token: string) => `https://pachka.test/match/notify/confirm/${token}`;

  it("carries an absolute confirmation link a mail client can follow", async () => {
    const mailer = logging();

    await captureNotifyRequest(
      { db: database.db, mailer, confirmUrl },
      { email: "Dana@Example.COM", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );

    expect(mailer.records).toHaveLength(1);
    const message = mailer.records[0]!;
    // Normalised by the module, and sent to the normalised form.
    expect(message.to).toBe("dana@example.com");
    expect(message.body).toMatch(/https:\/\/pachka\.test\/match\/notify\/confirm\/[0-9a-f]{64}/);
    expect(message.subject).toContain("פצ׳קה");
  });

  it("stores the subscription even when the provider is down, and says nothing about it", async () => {
    const acknowledgement = await captureNotifyRequest(
      { db: database.db, mailer: resend(endpoint(500).fetch), confirmUrl },
      { email: "noa@example.com", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );

    // Identical to the success case: a provider outage must not become the
    // membership oracle the whole endpoint is built to avoid.
    expect(acknowledgement).toEqual({ acknowledged: true });

    const { rows } = await database.db.query<{ confirmed_at: Date | null }>(
      "select confirmed_at from notify_requests where email = $1",
      ["noa@example.com"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirmed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The composition root's address book
// ---------------------------------------------------------------------------

describe("resolving an address", () => {
  const database = useTestDatabase();

  it("reads an artist's address from the private contact table", async () => {
    const artistId = await seedArtist(database, "דנה כהן", "dana@artists.test");

    expect(await addressBook(database.db).addressFor("artist", artistId)).toBe("dana@artists.test");
  });

  it("returns null for an artist with no contact row, rather than raising", async () => {
    const artistId = await seedArtist(database);

    expect(await addressBook(database.db).addressFor("artist", artistId)).toBeNull();
  });

  it("takes the operator's address from configuration, and has none before it is set", async () => {
    const book = addressBook(database.db);

    // Registered with an empty default and "Must be set before launch".
    expect(await book.addressFor("admin")).toBeNull();

    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    expect(await book.addressFor("admin")).toBe("operator@pachka.test");
  });

  it("has no address for an audience it does not know", async () => {
    expect(await addressBook(database.db).addressFor("nobody", randomUUID())).toBeNull();
  });

  it("delivers an artist notification end to end and reports one with no address", async () => {
    const known = await seedArtist(database, "יעל", "yael@artists.test");
    const unknown = await seedArtist(database, "רון");
    const provider = endpoint();

    const outcomes = await dispatchNotifications(
      resend(provider.fetch),
      { addresses: addressBook(database.db), siteUrl: "https://pachka.test" },
      [
        {
          audience: "artist",
          template: "orders.artist_dispatch_requested",
          recipientId: known,
          data: { orderId: "ord-1", fulfilmentId: "ful-1", itemsSubtotalAgorot: 125_000 },
        },
        {
          audience: "artist",
          template: "orders.artist_dispatch_requested",
          recipientId: unknown,
          data: { orderId: "ord-1", fulfilmentId: "ful-2" },
        },
      ],
    );

    expect(outcomes.map((outcome) => outcome.sent)).toEqual([true, false]);
    expect(outcomes[1]!.error).toBe("No address on file for this recipient");
    expect(provider.posted).toHaveLength(1);
    expect(provider.posted[0]!.to).toEqual(["yael@artists.test"]);
    expect(provider.posted[0]!.text).toContain("₪1,250.00");
  });
});
