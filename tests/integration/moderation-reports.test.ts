/**
 * Public reporting: the one surface where an anonymous stranger writes to this
 * database.
 *
 * moderation-admin, "Public reporting" and "Operator notification". The
 * scenarios below are the spec's, plus the rejections ARCHITECTURE.md's test
 * policy makes mandatory. Two of them are the reason this file exists at all:
 *
 *   - flooding is refused AND the count already recorded is not inflated by the
 *     refused attempts. Both halves are asserted separately, because an
 *     implementation that refuses correctly and still counts the refusals is
 *     the failure the spec is warning about.
 *   - the notification failing leaves the report recorded. Asserted by reading
 *     the report back out of Postgres, not by checking that a fake was called.
 *     ARCHITECTURE.md: "Asserting that a mock was called is not a test."
 *
 * The mailer is faked, and it is the only thing here that is. It is an external
 * boundary in exactly the sense the test policy means -- a separate service
 * that owns delivery -- and the fake exists so that "delivery failed" is
 * something a test can cause on purpose.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asAnon, asUser, useTestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import {
  REPORT_MAX_PER_WINDOW,
  REPORT_REASONS,
  fileReport,
  listQueue,
  openReportCount,
  pruneModerationRateLimitEvents,
  type Mailer,
  type ModerationDeps,
  type OutboundMessage,
} from "@/modules/moderation";
import { setConfig } from "@/shared/config";
import type { Database } from "@/shared/db";

// ---------------------------------------------------------------------------
// The one fake: the mail server.
// ---------------------------------------------------------------------------

class FakeMailer implements Mailer {
  readonly sent: OutboundMessage[] = [];
  /** When set, every send rejects with this message, as a dead SMTP host would. */
  failWith: string | null = null;

  async send(message: OutboundMessage): Promise<void> {
    if (this.failWith !== null) throw new Error(this.failWith);
    this.sent.push(message);
  }
}

// ---------------------------------------------------------------------------
// Seeding. Every test builds its own; the database is thrown away afterwards.
// ---------------------------------------------------------------------------

async function seedAccount(db: Database, roles: readonly string[], name: string): Promise<string> {
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  for (const role of roles) {
    await db.query("insert into user_roles (user_id, role) values ($1, $2)", [id, role]);
  }
  return id;
}

async function seedArtist(db: Database, name = "Yael K."): Promise<string> {
  const id = await seedAccount(db, ["buyer", "artist"], name);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

/**
 * A complete published artwork.
 *
 * `artworks_published_is_complete` refuses a published row with any mandatory
 * field missing, which is the artworks module doing its job. Seeding the whole
 * thing is the price of testing against the real constraint rather than a
 * relaxed copy of it.
 */
async function seedPublishedArtwork(db: Database, artistId: string, title = "Sunrise over Jaffa") {
  const { rows } = await db.query<{ id: string }>(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods, is_framed,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, 'published', $2, 'An oil study of the old port at first light.', 125000,
       400, 300, 1200, 'Oil on canvas', 5,
       'painting_illustration', array['abstract']::text[], array['calm']::text[], true,
       $1, now(), false, now()
     ) returning id`,
    [artistId, title],
  );
  return rows[0]!.id;
}

function depsFor(db: Database, mailer = new FakeMailer()): { deps: ModerationDeps; mailer: FakeMailer } {
  return { deps: { db, auth: new FakeAuthGateway(), mailer }, mailer };
}

/** The operator address is registered with an empty default and must be set. */
async function setOperatorAddress(db: Database, address = "moderation@pachka.example") {
  await setConfig(db, "moderation.operator_email", address);
}

// ---------------------------------------------------------------------------

describe("an anonymous visitor filing a report", () => {
  const database = useTestDatabase();

  it("records it against the artwork and confirms receipt", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "not_original_work",
      details: "This is a print of a painting I own.",
      clientId: "203.0.113.7",
    });

    expect(result.reportCount).toBe(1);
    expect(result.message).toMatch(/thank you/i);

    const row = await database.db.one<{
      subject_type: string;
      artwork_id: string;
      artist_id: string | null;
      reason: string;
      details: string;
      reporter_id: string | null;
      status: string;
    }>(
      `select subject_type, artwork_id, artist_id, reason, details, reporter_id, status
         from reports where id = $1`,
      [result.reportId],
    );

    expect(row).toMatchObject({
      subject_type: "artwork",
      artwork_id: artworkId,
      artist_id: null,
      reason: "not_original_work",
      details: "This is a print of a painting I own.",
      reporter_id: null,
      status: "open",
    });
  });

  it("can report an artist profile as well as an artwork", async () => {
    const artistId = await seedArtist(database.db);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    const result = await fileReport(deps, {
      subject: { type: "artist", artistId },
      reason: "misleading_listing",
      clientId: "203.0.113.8",
    });

    expect(result.subjectType).toBe("artist");
    expect(result.subjectId).toBe(artistId);

    const row = await database.db.one<{ artist_id: string; artwork_id: string | null }>(
      "select artist_id, artwork_id from reports where id = $1",
      [result.reportId],
    );
    expect(row).toEqual({ artist_id: artistId, artwork_id: null });
  });

  it("accepts every reason in the fixed set, and no others", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    for (const reason of REPORT_REASONS) {
      const result = await fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason,
        // A distinct client per reason, so the rate limiter is not what is
        // being measured here.
        clientId: `198.51.100.${REPORT_REASONS.indexOf(reason)}`,
      });
      expect(result.reportId).toMatch(/^[0-9a-f-]{36}$/);
    }

    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(REPORT_REASONS.length);
  });

  it("never stores the raw client identifier", async () => {
    // SECURITY.md's log-redaction rule puts raw client IPs on the never-stored
    // list, and S3-30 names hashed reporter IPs as a data class this system
    // holds. Unhashed, `reports` becomes a list of everyone who has ever
    // objected to a listing -- which is the list an artist with a grudge wants.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);
    const clientId = "203.0.113.42";

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "offensive_content",
      clientId,
    });

    const row = await database.db.one<{ reporter_fingerprint: string }>(
      "select reporter_fingerprint from reports where id = $1",
      [result.reportId],
    );

    expect(row.reporter_fingerprint).not.toContain(clientId);
    expect(row.reporter_fingerprint).toBe(
      createHash("sha256").update(clientId, "utf8").digest("hex"),
    );

    // And the counters one table over hold the same hash, not the address.
    const counters = await database.db.query<{ subject: string }>(
      "select subject from moderation_rate_limit_events",
    );
    expect(counters.rows).toHaveLength(1);
    expect(counters.rows[0]!.subject).not.toContain(clientId);
  });

  it("records the account when the reporter happens to be signed in", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const buyerId = await seedAccount(database.db, ["buyer"], "Signed-in Buyer");
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "mass_produced",
      reporterId: buyerId,
      clientId: "203.0.113.9",
    });

    const row = await database.db.one<{ reporter_id: string }>(
      "select reporter_id from reports where id = $1",
      [result.reportId],
    );
    expect(row.reporter_id).toBe(buyerId);
  });
});

describe("reports that must be rejected", () => {
  const database = useTestDatabase();

  it("rejects a submission with no reason selected, and writes nothing", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const { deps } = depsFor(database.db);

    for (const reason of [null, undefined, "", "   "]) {
      await expect(
        fileReport(deps, {
          subject: { type: "artwork", artworkId },
          reason,
          clientId: "203.0.113.10",
        }),
      ).rejects.toMatchObject({ kind: "validation", code: "moderation.report_reason_required" });
    }

    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(0);
  });

  it("rejects a reason outside the fixed set", async () => {
    // A reason nobody can render is not a reason. The set is closed server-side
    // as well as in the database, so a crafted request cannot introduce one.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const { deps } = depsFor(database.db);

    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "i_just_do_not_like_it",
        clientId: "203.0.113.11",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "moderation.report_reason_unknown" });

    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(0);
  });

  it("rejects a report against an artwork that does not exist", async () => {
    const { deps } = depsFor(database.db);

    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId: randomUUID() },
        reason: "other",
        clientId: "203.0.113.12",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects a client it cannot identify, because it could not be rate-limited", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const { deps } = depsFor(database.db);

    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        clientId: null,
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "moderation.report_client_required" });

    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(0);
  });

  it("rejects free text longer than the column allows", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const { deps } = depsFor(database.db);

    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        details: "x".repeat(2001),
        clientId: "203.0.113.13",
      }),
    ).rejects.toMatchObject({ kind: "validation" });

    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(0);
  });
});

describe("several reports against one subject", () => {
  const database = useTestDatabase();

  it("group into a single queue item carrying the count", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin A.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    for (const [index, reason] of (
      ["not_original_work", "not_original_work", "mass_produced"] as const
    ).entries()) {
      await fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason,
        clientId: `192.0.2.${index}`,
      });
    }

    const queue = await listQueue(deps, adminId);

    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      kind: "report",
      subjectType: "artwork",
      subjectId: artworkId,
      reportCount: 3,
      status: "open",
    });
    // Commonest reason first, so an operator reads the gist before the detail.
    expect(queue[0]!.reasons.map((r) => [r.reason, r.count])).toEqual([
      ["not_original_work", 2],
      ["mass_produced", 1],
    ]);
  });

  it("keep two different subjects as two separate items", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin B.");
    const artistId = await seedArtist(database.db);
    const first = await seedPublishedArtwork(database.db, artistId, "First");
    const second = await seedPublishedArtwork(database.db, artistId, "Second");
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    await fileReport(deps, {
      subject: { type: "artwork", artworkId: first },
      reason: "other",
      clientId: "192.0.2.20",
    });
    await fileReport(deps, {
      subject: { type: "artwork", artworkId: second },
      reason: "other",
      clientId: "192.0.2.21",
    });

    const queue = await listQueue(deps, adminId);

    expect(queue).toHaveLength(2);
    expect(new Set(queue.map((item) => item.subjectId))).toEqual(new Set([first, second]));
    expect(queue.every((item) => item.reportCount === 1)).toBe(true);
  });
});

describe("report flooding", () => {
  const database = useTestDatabase();

  it("is refused past the limit, and the refusals do not inflate the count", async () => {
    // The requirement in full: "further reports are refused, AND the report
    // count already recorded is not inflated by the refused attempts". An
    // implementation that refuses correctly but still counts is the failure the
    // spec is warning about, so both halves are asserted, separately.
    const adminId = await seedAccount(database.db, ["admin"], "Admin C.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);
    const flooder = "198.51.100.200";

    for (let index = 0; index < REPORT_MAX_PER_WINDOW; index += 1) {
      await fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "offensive_content",
        clientId: flooder,
      });
    }

    const countAtLimit = await openReportCount(database.db, "artwork", artworkId);
    expect(countAtLimit).toBe(REPORT_MAX_PER_WINDOW);

    // Half. Every further attempt is refused, with 429 rather than 409: the
    // identical request succeeds once the window resets, so the client is being
    // told to wait, not that its request disagrees with the world.
    const refusals = 5;
    for (let index = 0; index < refusals; index += 1) {
      await expect(
        fileReport(deps, {
          subject: { type: "artwork", artworkId },
          reason: "offensive_content",
          clientId: flooder,
        }),
      ).rejects.toMatchObject({ kind: "rate_limited", code: "moderation.rate_limited" });
    }

    // The other half, and the one that matters to the artist being reported.
    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(countAtLimit);

    const stored = await database.db.one<{ count: string }>(
      "select count(*)::text as count from reports where artwork_id = $1",
      [artworkId],
    );
    expect(stored.count).toBe(String(REPORT_MAX_PER_WINDOW));

    const queue = await listQueue(deps, adminId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.reportCount).toBe(REPORT_MAX_PER_WINDOW);
  });

  it("counts the refused attempts, so a flooder cannot erase their own evidence", async () => {
    // The counter is written outside the report's transaction on purpose. If it
    // shared that transaction, refusing a report would roll back the row
    // recording the refused attempt, the window would never fill, and the
    // limiter would refuse the same client forever without ever making progress
    // -- or, worse, let it straight back in.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);
    const flooder = "198.51.100.201";

    for (let index = 0; index < REPORT_MAX_PER_WINDOW; index += 1) {
      await fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        clientId: flooder,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await expect(
        fileReport(deps, {
          subject: { type: "artwork", artworkId },
          reason: "other",
          clientId: flooder,
        }),
      ).rejects.toMatchObject({ kind: "rate_limited" });
    }

    const counters = await database.db.one<{ count: string }>(
      "select count(*)::text as count from moderation_rate_limit_events where bucket = 'report'",
    );
    expect(counters.count).toBe(String(REPORT_MAX_PER_WINDOW + 3));
  });

  it("limits one client without silencing everybody else", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    for (let index = 0; index < REPORT_MAX_PER_WINDOW; index += 1) {
      await fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        clientId: "198.51.100.202",
      });
    }

    // A different visitor, who has reported nothing, is unaffected.
    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "misleading_listing",
        clientId: "198.51.100.203",
      }),
    ).resolves.toMatchObject({ reportCount: REPORT_MAX_PER_WINDOW + 1 });
  });

  it("lets the client back in once its window has been swept", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);
    const client = "198.51.100.204";

    for (let index = 0; index < REPORT_MAX_PER_WINDOW; index += 1) {
      await fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        clientId: client,
      });
    }
    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        clientId: client,
      }),
    ).rejects.toMatchObject({ kind: "rate_limited" });

    // No sleeping: the window is cleared by the sweep the way time would clear
    // it, which is the observable the limiter actually depends on.
    const pruned = await pruneModerationRateLimitEvents(database.db, 0);
    expect(pruned).toBe(REPORT_MAX_PER_WINDOW + 1);

    await expect(
      fileReport(deps, {
        subject: { type: "artwork", artworkId },
        reason: "other",
        clientId: client,
      }),
    ).resolves.toMatchObject({ reportId: expect.any(String) });
  });
});

describe("notifying the operator", () => {
  const database = useTestDatabase();

  it("emails the configured address with the subject, the reason, and a link", async () => {
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db, "ops@pachka.example");
    const { deps, mailer } = depsFor(database.db);

    const result = await fileReport(
      { ...deps, siteUrl: "https://pachka.example" },
      {
        subject: { type: "artwork", artworkId },
        reason: "undeclared_ai",
        details: "The brushwork is generated.",
        clientId: "203.0.113.30",
      },
    );

    expect(result.notified).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0]!;
    expect(message.to).toBe("ops@pachka.example");
    expect(message.body).toContain(artworkId);
    expect(message.body).toContain("Undeclared AI generation");
    expect(message.body).toContain(`https://pachka.example/admin/queue/artwork/${artworkId}`);

    const row = await database.db.one<{ notified_at: Date | null; notification_error: string | null }>(
      "select notified_at, notification_error from reports where id = $1",
      [result.reportId],
    );
    expect(row.notified_at).not.toBeNull();
    expect(row.notification_error).toBeNull();
  });

  it("still records the report when the email cannot be sent", async () => {
    // The spec scenario, and the assertion is on the report row rather than on
    // the mailer: what has to survive a dead SMTP host is the queue item, not
    // the call.
    const adminId = await seedAccount(database.db, ["admin"], "Admin D.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps, mailer } = depsFor(database.db);
    mailer.failWith = "smtp: connection refused";

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "offensive_content",
      clientId: "203.0.113.31",
    });

    // The report exists, is open, and is in the queue.
    expect(result.notified).toBe(false);
    expect(result.reportCount).toBe(1);

    const row = await database.db.one<{
      status: string;
      notified_at: Date | null;
      notification_error: string | null;
    }>("select status, notified_at, notification_error from reports where id = $1", [
      result.reportId,
    ]);
    expect(row.status).toBe("open");
    expect(row.notified_at).toBeNull();
    // "and the failure is logged" -- on the row, so an operator can ask which
    // reports they were never told about, and a test can assert it.
    expect(row.notification_error).toContain("connection refused");

    const queue = await listQueue(deps, adminId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.subjectId).toBe(artworkId);
  });

  it("records an unset operator address as the operational failure it is", async () => {
    // `moderation.operator_email` ships with an empty default and "Must be set
    // before launch". Silently reporting success would hide that until the
    // first report nobody answered.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const { deps, mailer } = depsFor(database.db);

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "other",
      clientId: "203.0.113.32",
    });

    expect(result.notified).toBe(false);
    expect(result.notificationError).toMatch(/operator_email/);
    expect(mailer.sent).toEqual([]);

    const row = await database.db.one<{ status: string }>(
      "select status from reports where id = $1",
      [result.reportId],
    );
    expect(row.status).toBe("open");
  });
});

describe("reports through the data API", () => {
  const database = useTestDatabase();

  it("cannot be filed by an anonymous visitor, which is what makes the limit real", async () => {
    // If `anon` held an INSERT grant, every rate limit above would be bypassed
    // by posting straight to /rest/v1/reports with the key from the browser
    // bundle. This is the assertion that the flood control cannot be walked
    // around rather than merely implemented.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);

    await expect(
      asAnon(database.db, (tx) =>
        tx.query(
          `insert into reports (subject_type, artwork_id, reason, reporter_fingerprint)
           values ('artwork', $1, 'other', repeat('a', 64))`,
          [artworkId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    expect(await openReportCount(database.db, "artwork", artworkId)).toBe(0);
  });

  it("cannot be read by the artist they are filed against", async () => {
    // SECURITY.md's matrix is explicit: "Artists must not read reports against
    // them." An artist who can read their own reports can correlate the timing
    // against their own visitor logs, and an anonymous reporter stops being
    // anonymous.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "not_original_work",
      clientId: "203.0.113.40",
    });

    const rows = await asUser(
      database.db,
      artistId,
      async (tx) => (await tx.query("select * from reports")).rows,
      // Everything the artist can put in their own token, which they rewrite at
      // will with supabase.auth.updateUser (SECURITY.md S0-2).
      { user_metadata: { role: "admin" }, role: "admin", is_admin: true },
    );

    expect(rows).toEqual([]);
  });

  it("is readable by an admin, so the check above is not vacuous", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin E.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "not_original_work",
      clientId: "203.0.113.41",
    });

    const rows = await asUser(
      database.db,
      adminId,
      async (tx) => (await tx.query("select * from reports")).rows,
    );

    expect(rows).toHaveLength(1);
  });

  it("cannot have its substance rewritten after the fact", async () => {
    // A takedown is justified by the report that prompted it, so a reason that
    // can be edited afterwards justifies nothing. The trigger refuses even the
    // privileged connection the application itself runs on.
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setOperatorAddress(database.db);
    const { deps } = depsFor(database.db);

    const result = await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "other",
      details: "what the reporter actually wrote",
      clientId: "203.0.113.42",
    });

    await expect(
      database.db.query("update reports set reason = 'not_original_work' where id = $1", [
        result.reportId,
      ]),
    ).rejects.toThrow(/fixed when it is filed/i);

    await expect(
      database.db.query("update reports set details = 'something more damning' where id = $1", [
        result.reportId,
      ]),
    ).rejects.toThrow(/fixed when it is filed/i);

    // Backdating is refused too, which matters more than it first looks: the
    // queue orders by `created_at`, so a movable one would let an item be
    // pushed off the bottom of an operator's screen.
    await expect(
      database.db.query(
        "update reports set created_at = now() - interval '1 year' where id = $1",
        [result.reportId],
      ),
    ).rejects.toThrow(/fixed when it is filed/i);

    // And the reporter cannot be swapped for somebody else.
    await expect(
      database.db.query("update reports set reporter_fingerprint = repeat('b', 64) where id = $1", [
        result.reportId,
      ]),
    ).rejects.toThrow(/fixed when it is filed/i);

    const row = await database.db.one<{ reason: string; details: string }>(
      "select reason, details from reports where id = $1",
      [result.reportId],
    );
    expect(row).toEqual({ reason: "other", details: "what the reporter actually wrote" });
  });
});
