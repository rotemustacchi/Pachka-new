/**
 * The transport against the real modules and the real database.
 *
 * `tests/unit/mail-transport.test.ts` proves the adapters in isolation. This
 * file proves the three things that can only be shown with Postgres underneath:
 *
 *   1. Delivery does not break the operation that triggered it. `moderation`'s
 *      spec is explicit that a report is still recorded when its notification
 *      fails, and the assertion is a SELECT against `reports` after a transport
 *      that genuinely rejected — not a check that a fake was called.
 *   2. The composition root's `addressBook` resolves an address out of the
 *      tables that hold one, including the private `artist_contact_details`
 *      that only this privileged connection can read, and the anonymous
 *      `notify_requests` list that belongs to nobody with an account.
 *   3. The whole loop actually closes. Every module now RETURNS descriptors and
 *      sends nothing, so a module whose notifications are dropped on the floor
 *      is silently broken in a way no module-level test can see. Each path
 *      below runs module → dispatcher → provider end to end.
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
import { fileReport, recordReportNotification, type ModerationDeps } from "@/modules/moderation";
import {
  captureNotifyRequest,
  confirmNotifyRequest,
  hashSubject,
  unsubscribeNotifyRequest,
} from "@/modules/matchmaker";
import { setConfig } from "@/shared/config";
import {
  createLoggingMailer,
  createResendMailer,
  dispatchNotifications,
  type FetchLike,
  type LoggingMailer,
  type MailTransport,
  type NotificationRequest,
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

function depsFor(db: Database): ModerationDeps {
  return { db, auth: new FakeAuthGateway() };
}

const SITE = "https://pachka.test";

/** The composition root's dispatcher, over a chosen transport. */
function dispatch(db: Database, mailer: MailTransport) {
  return (requests: readonly NotificationRequest[]) =>
    dispatchNotifications(mailer, { addresses: addressBook(db), siteUrl: SITE }, requests);
}

/**
 * File a report and then do what the composition root does with what it got
 * back: dispatch the alert, and write the outcome onto the row.
 *
 * There is no route calling `fileReport` yet — the report action on the artwork
 * page is not built — so this is the wiring that route will need, written down
 * once and exercised by every test below rather than reinvented in each.
 */
async function fileAndAnnounce(
  db: Database,
  mailer: MailTransport,
  input: Parameters<typeof fileReport>[1],
) {
  const result = await fileReport(depsFor(db), input);
  const outcomes = await dispatch(db, mailer)(result.notifications);
  await recordReportNotification(db, result.reportId, outcomes[0]!);
  return { ...result, outcomes };
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
    // A provider that is genuinely refusing, not a fake that pretends to.
    const result = await fileAndAnnounce(database.db, resend(endpoint(500).fetch), {
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
    const result = await fileAndAnnounce(
      database.db,
      resend(endpoint(422, '{"name":"validation_error","message":"Invalid `to`: operator@pachka.test"}').fetch),
      {
        subject: { type: "artwork", artworkId },
        reason: "other",
        details: "בדיקה.",
        clientId: "198.51.100.10",
      },
    );

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
    await fileAndAnnounce(database.db, resend(endpoint(503).fetch), {
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

    const result = await fileAndAnnounce(database.db, resend(provider.fetch), {
      subject: { type: "artwork", artworkId },
      reason: "undeclared_ai",
      details: "נראה כמו תמונה שנוצרה במחולל.",
      clientId: "198.51.100.11",
    });

    expect(provider.posted).toHaveLength(1);
    const sent = provider.posted[0]!;
    expect(sent.to).toEqual(["operator@pachka.test"]);
    expect(sent.subject).toContain(artworkId);
    expect(sent.text).toContain(`${SITE}/admin/queue/artwork/${artworkId}`);
    expect(sent.text).toContain("נראה כמו תמונה שנוצרה במחולל.");
    // The reader gets a right-to-left part too, not only the plain one.
    expect(sent.html).toContain('dir="rtl"');

    const { rows } = await database.db.query<{ notified_at: Date | null }>(
      "select notified_at from reports where id = $1",
      [result.reportId],
    );
    expect(rows[0]!.notified_at).not.toBeNull();
  });

  it("records an unset operator address as the operational failure it is", async () => {
    // `moderation.operator_email` ships with an empty default and "Must be set
    // before launch", so it is deliberately NOT set here. The module used to
    // detect this itself; the address book detects it now, because that is
    // where the configuration is read — and it says which key, rather than the
    // generic "no address on file", so an operator reading the column knows
    // what to go and set.
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const provider = endpoint();

    const result = await fileAndAnnounce(database.db, resend(provider.fetch), {
      subject: { type: "artwork", artworkId },
      reason: "other",
      clientId: "198.51.100.13",
    });

    expect(result.outcomes[0]!.sent).toBe(false);
    expect(result.outcomes[0]!.error).toMatch(/operator_email/);
    expect(provider.posted).toEqual([]);

    const row = await database.db.one<{
      status: string;
      notified_at: Date | null;
      notification_error: string | null;
    }>("select status, notified_at, notification_error from reports where id = $1", [
      result.reportId,
    ]);
    // The report is filed and open regardless. An unconfigured operator address
    // is not a reason to lose a stranger's complaint.
    expect(row.status).toBe("open");
    expect(row.notified_at).toBeNull();
    expect(row.notification_error).toMatch(/operator_email/);
  });

  it("is recorded rather than lost when no provider is configured at all", async () => {
    // This is what `appMailer()` returns with no RESEND_API_KEY — the state of
    // every developer machine, and of a deployment nobody has finished wiring.
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    const mailer = logging();

    const result = await fileAndAnnounce(database.db, mailer, {
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
// Notify-me, which used to own its own mailer and now owns none
// ---------------------------------------------------------------------------

describe("the notify-me confirmation", () => {
  const database = useTestDatabase();

  it("carries an absolute confirmation link a mail client can follow", async () => {
    const mailer = logging();

    const result = await captureNotifyRequest(
      { db: database.db },
      { email: "Dana@Example.COM", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );
    await dispatch(database.db, mailer)(result.notifications);

    expect(mailer.records).toHaveLength(1);
    const message = mailer.records[0]!;
    // Normalised by the module, stored normalised, and resolved back out of
    // `notify_requests` by the address book — the module never handed the
    // address to anything.
    expect(message.to).toBe("dana@example.com");
    expect(message.body).toMatch(/https:\/\/pachka\.test\/match\/notify\/confirm\/[0-9a-f]{64}/);
    expect(message.subject).toContain("פצ׳קה");
  });

  it("sends a link that actually confirms the subscription it was issued for", async () => {
    // The confirm route takes the token out of the URL and calls
    // `confirmNotifyRequest`. This is the whole round trip: the token the
    // module put in the descriptor, through the URL the mail layer built, back
    // into the row it belongs to.
    const mailer = logging();

    const result = await captureNotifyRequest(
      { db: database.db },
      { email: "roni@example.com", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );
    await dispatch(database.db, mailer)(result.notifications);

    const link = /https:\/\/pachka\.test\/match\/notify\/confirm\/([0-9a-f]{64})/.exec(
      mailer.records[0]!.body,
    );
    expect(link).not.toBeNull();

    await confirmNotifyRequest(database.db, link![1]!);

    const row = await database.db.one<{ confirmed_at: Date | null }>(
      "select confirmed_at from notify_requests where email = $1",
      ["roni@example.com"],
    );
    expect(row.confirmed_at).not.toBeNull();
  });

  it("stores the subscription even when the provider is down, and says nothing about it", async () => {
    const acknowledgement = await captureNotifyRequest(
      { db: database.db },
      { email: "noa@example.com", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );
    // The route dispatches without looking. `dispatchNotifications` never
    // throws, so a dead provider cannot become a status a caller could read.
    const outcomes = await dispatch(database.db, resend(endpoint(500).fetch))(
      acknowledgement.notifications,
    );

    expect(acknowledgement.acknowledged).toBe(true);
    expect(outcomes[0]!.sent).toBe(false);

    const { rows } = await database.db.query<{ confirmed_at: Date | null }>(
      "select confirmed_at from notify_requests where email = $1",
      ["noa@example.com"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirmed_at).toBeNull();
  });

  it("acknowledges a second submission identically, and does not mail twice", async () => {
    // SECURITY.md S2-21 item 3: one confirmation per address per window. The
    // second capture produces NO descriptor, so the visitor-facing value is the
    // same and the mailbox sees one message, not two.
    const mailer = logging();
    const submit = () =>
      captureNotifyRequest(
        { db: database.db },
        { email: "avi@example.com", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
      );

    const first = await submit();
    await dispatch(database.db, mailer)(first.notifications);
    const second = await submit();
    await dispatch(database.db, mailer)(second.notifications);

    expect(first.acknowledged).toBe(true);
    expect(second.acknowledged).toBe(true);
    expect(second.notifications).toEqual([]);
    expect(mailer.records).toHaveLength(1);
  });

  it("does not write to an address that unsubscribed before the message went out", async () => {
    // The descriptor carries a subscription id, not an address, and the address
    // book reads `notify_requests` at dispatch time. So a row deleted in
    // between resolves to nothing and nothing is sent — which the old design,
    // holding the address in a closure, could not do.
    const provider = endpoint();
    const result = await captureNotifyRequest(
      { db: database.db },
      { email: "gone@example.com", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );

    const row = await database.db.one<{ unsubscribe_token: string }>(
      "select unsubscribe_token from notify_requests where email = $1",
      ["gone@example.com"],
    );
    expect(await unsubscribeNotifyRequest(database.db, row.unsubscribe_token)).toBe(1);

    const outcomes = await dispatch(database.db, resend(provider.fetch))(result.notifications);

    expect(outcomes[0]!.sent).toBe(false);
    expect(outcomes[0]!.error).toBe("That subscription no longer exists");
    expect(provider.posted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The composition root's address book
// ---------------------------------------------------------------------------

describe("resolving an address", () => {
  const database = useTestDatabase();

  it("reads an artist's address from the private contact table", async () => {
    const artistId = await seedArtist(database, "דנה כהן", "dana@artists.test");

    expect(await addressBook(database.db).addressFor("artist", artistId)).toEqual({
      address: "dana@artists.test",
    });
  });

  it("says WHY an artist has no address, rather than raising or shrugging", async () => {
    // The reason is recorded verbatim as the delivery error, and this one is
    // ordinary: an artist who has not filled in a contact row. It reads
    // differently from an unset operator address on purpose, because one of
    // those is somebody's paperwork and the other is a launch blocker.
    const artistId = await seedArtist(database);

    expect(await addressBook(database.db).addressFor("artist", artistId)).toEqual({
      address: null,
      reason: "The artist has no contact address on file",
    });
  });

  it("takes the operator's address from configuration, and names the key before it is set", async () => {
    const book = addressBook(database.db);

    // Registered with an empty default and "Must be set before launch".
    expect(await book.addressFor("admin")).toEqual({
      address: null,
      reason: "No operator address is configured (moderation.operator_email)",
    });

    await setConfig(database.db, "moderation.operator_email", "operator@pachka.test");
    expect(await book.addressFor("admin")).toEqual({ address: "operator@pachka.test" });
  });

  it("reads a notify-me subscriber out of the anonymous list, by row id", async () => {
    // The one audience with no account behind it. The id is the subscription's,
    // and the address never travelled in the descriptor to get here.
    const captured = await captureNotifyRequest(
      { db: database.db },
      { email: "sub@example.com", matchQueryId: null, clientFingerprint: hashSubject(randomUUID()) },
    );
    const recipientId = captured.notifications[0]!.recipientId!;

    expect(await addressBook(database.db).addressFor("subscriber", recipientId)).toEqual({
      address: "sub@example.com",
    });
  });

  it("has no address for an audience it does not know", async () => {
    expect(await addressBook(database.db).addressFor("nobody", randomUUID())).toEqual({
      address: null,
      reason: 'No address book for audience "nobody"',
    });
  });

  it("delivers an artist notification end to end and reports one with no address", async () => {
    const known = await seedArtist(database, "יעל", "yael@artists.test");
    const unknown = await seedArtist(database, "רון");
    const provider = endpoint();

    const outcomes = await dispatchNotifications(
      resend(provider.fetch),
      { addresses: addressBook(database.db), siteUrl: SITE },
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
    expect(outcomes[1]!.error).toBe("The artist has no contact address on file");
    expect(provider.posted).toHaveLength(1);
    expect(provider.posted[0]!.to).toEqual(["yael@artists.test"]);
    expect(provider.posted[0]!.text).toContain("₪1,250.00");
  });
});
