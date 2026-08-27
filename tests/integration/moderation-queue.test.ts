/**
 * The admin queue.
 *
 * moderation-admin, "Admin queue": admin-only, listing open reports and
 * pipeline-flagged uploads, sorted by recency, each showing subject, reason,
 * report count and status; each resolvable as dismissed or actioned with a
 * recorded operator note.
 *
 * Two things this file is careful about.
 *
 * The admin-only tests carry a POSITIVE CONTROL. A test that asserts a
 * non-admin gets `not_found` passes just as happily against a queue that is
 * empty, or broken, or returns `not_found` to everyone. So every refusal is
 * paired with the same call made by an admin, asserting the data is really
 * there to be refused. Without that pair the assertion is vacuous.
 *
 * Pipeline-flagged uploads arrive through a port. `upload_events` belongs to
 * the `uploads` module, which has not shipped, and no module writes another
 * module's tables. The test stands up a real table in its own throwaway
 * database and implements the port against it with real SQL, so what is proved
 * is that the queue merges and orders the two sources -- not that a stub
 * returned what it was told to.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import {
  fileReport,
  listQueue,
  readAuditTrail,
  resolveQueueItem,
  verifyAuditChain,
  type FlaggedUploadSource,
  type Mailer,
  type ModerationDeps,
  type OutboundMessage,
} from "@/modules/moderation";
import { setConfig } from "@/shared/config";
import type { Database, Sql } from "@/shared/db";

class FakeMailer implements Mailer {
  readonly sent: OutboundMessage[] = [];
  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

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

async function seedArtist(db: Database, name = "Tamar S."): Promise<string> {
  const id = await seedAccount(db, ["buyer", "artist"], name);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedPublishedArtwork(db: Database, artistId: string, title = "Harbour Light") {
  const { rows } = await db.query<{ id: string }>(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods, is_framed,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, 'published', $2, 'A study in blue.', 90000,
       350, 250, 900, 'Acrylic on board', 4,
       'painting_illustration', array['minimalist']::text[], array['calm']::text[], false,
       $1, now(), false, now()
     ) returning id`,
    [artistId, title],
  );
  return rows[0]!.id;
}

function depsFor(db: Database, extra: Partial<ModerationDeps> = {}): ModerationDeps {
  return { db, auth: new FakeAuthGateway(), mailer: new FakeMailer(), ...extra };
}

/** A real stand-in for `upload_events`, until the uploads module ships. */
async function createFlaggedUploads(db: Database): Promise<FlaggedUploadSource> {
  await db.query(`
    create table stand_in_upload_events (
      id         uuid primary key default gen_random_uuid(),
      artwork_id uuid not null references artworks (id),
      verdict    text not null,
      note       text not null,
      created_at timestamptz not null default now()
    )
  `);
  await db.query("alter table stand_in_upload_events enable row level security");

  return {
    async flaggedForReview(sql: Sql, limit: number) {
      const { rows } = await sql.query<{ artwork_id: string; created_at: Date; note: string }>(
        `select artwork_id, created_at, note
           from stand_in_upload_events
          where verdict = 'needs_review'
          order by created_at desc
          limit $1`,
        [limit],
      );
      return rows.map((row) => ({
        artworkId: row.artwork_id,
        flaggedAt: row.created_at,
        note: row.note,
      }));
    },
  };
}

/**
 * A report that already existed, at a stated age.
 *
 * Used only by the ordering tests. Everything about how a report comes into
 * being -- the reason set, the rate limit, the hashing, the notification -- is
 * tested against the real `fileReport` in moderation-reports.test.ts.
 */
async function seedReportAt(db: Database, artworkId: string, reason: string, ago: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into reports (subject_type, artwork_id, reason, reporter_fingerprint, created_at)
     values ('artwork', $1, $2, encode(sha256($3::bytea), 'hex'), now() - $4::interval)
     returning id`,
    [artworkId, reason, `seed-${artworkId}-${reason}-${ago}`, ago],
  );
  return rows[0]!.id;
}

async function report(deps: ModerationDeps, artworkId: string, reason: string, clientId: string) {
  return fileReport(deps, { subject: { type: "artwork", artworkId }, reason, clientId });
}

// ---------------------------------------------------------------------------

describe("who can see the queue", () => {
  const database = useTestDatabase();

  it("returns not-found to an account without the admin role", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin A.");
    const buyerId = await seedAccount(database.db, ["buyer"], "Buyer B.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "not_original_work", "192.0.2.60");

    await expect(listQueue(deps, buyerId)).rejects.toMatchObject({ kind: "not_found" });

    // POSITIVE CONTROL. Without this the refusal above would pass against a
    // queue that is simply empty or broken.
    const asAdmin = await listQueue(deps, adminId);
    expect(asAdmin).toHaveLength(1);
    expect(asAdmin[0]!.subjectId).toBe(artworkId);
  });

  it("returns not-found to the artist whose work is in the queue", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin C.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "mass_produced", "192.0.2.61");

    await expect(listQueue(deps, artistId)).rejects.toMatchObject({ kind: "not_found" });
    expect(await listQueue(deps, adminId)).toHaveLength(1);
  });

  it("returns not-found to an anonymous caller and to an unknown account", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin D.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.62");

    await expect(listQueue(deps, null)).rejects.toMatchObject({ kind: "not_found" });
    await expect(listQueue(deps, randomUUID())).rejects.toMatchObject({ kind: "not_found" });
    expect(await listQueue(deps, adminId)).toHaveLength(1);
  });

  it("returns not-found to an admin whose own account has been suspended", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin E.");
    const otherAdminId = await seedAccount(database.db, ["admin"], "Admin F.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.63");

    await database.db.query(
      "update account_status set suspended_at = now(), suspended_reason = 'under review' where user_id = $1",
      [adminId],
    );

    await expect(listQueue(deps, adminId)).rejects.toMatchObject({ kind: "not_found" });
    expect(await listQueue(deps, otherAdminId)).toHaveLength(1);
  });

  it("refuses with not-found, never with forbidden", async () => {
    // The distinction is the requirement. A 403 confirms the surface exists and
    // that the caller's account is real; a 404 tells them nothing. This asserts
    // the kind, because that is what `httpStatusFor` turns into the status code.
    const buyerId = await seedAccount(database.db, ["buyer"], "Buyer G.");
    const deps = depsFor(database.db);

    const error = await listQueue(deps, buyerId).catch((caught: { kind: string }) => caught);

    expect(error).toMatchObject({ kind: "not_found" });
    expect(error).not.toMatchObject({ kind: "forbidden" });
  });
});

describe("what the queue shows", () => {
  const database = useTestDatabase();

  it("sorts by recency, newest first", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin H.");
    const artistId = await seedArtist(database.db);
    const older = await seedPublishedArtwork(database.db, artistId, "Older");
    const newer = await seedPublishedArtwork(database.db, artistId, "Newer");
    const deps = depsFor(database.db);

    // Seeded with explicit timestamps rather than filed through `fileReport`
    // and then backdated. Two reasons: a wide, deterministic gap beats relying
    // on two transactions landing in different microseconds, and the
    // immutability trigger correctly refuses to let anything -- including a
    // test -- move a report's `created_at` after it is filed. The filing path
    // is covered in moderation-reports.test.ts; what is under test here is the
    // ordering `listQueue` imposes on rows that already exist.
    await seedReportAt(database.db, older, "other", "1 hour");
    await seedReportAt(database.db, newer, "other", "1 minute");

    const queue = await listQueue(deps, adminId);

    expect(queue.map((item) => item.subjectId)).toEqual([newer, older]);
    expect(queue[0]!.latestAt.getTime()).toBeGreaterThan(queue[1]!.latestAt.getTime());
  });

  it("dates a group by its newest report, not its oldest", async () => {
    // A subject reported months ago and again this morning belongs at the top
    // of the queue, not the bottom.
    const adminId = await seedAccount(database.db, ["admin"], "Admin H2.");
    const artistId = await seedArtist(database.db);
    const stale = await seedPublishedArtwork(database.db, artistId, "Stale");
    const busy = await seedPublishedArtwork(database.db, artistId, "Busy");
    const deps = depsFor(database.db);

    await seedReportAt(database.db, stale, "other", "2 hours");
    await seedReportAt(database.db, busy, "other", "10 hours");
    await seedReportAt(database.db, busy, "mass_produced", "1 minute");

    const queue = await listQueue(deps, adminId);

    expect(queue.map((item) => item.subjectId)).toEqual([busy, stale]);
    expect(queue[0]!.reportCount).toBe(2);
  });

  it("shows an upload the pipeline flagged, alongside the reports", async () => {
    // "An upload is flagged because safety screening was unavailable -> it
    // appears in the admin queue for review."
    const adminId = await seedAccount(database.db, ["admin"], "Admin I.");
    const artistId = await seedArtist(database.db);
    const reported = await seedPublishedArtwork(database.db, artistId, "Reported");
    const flagged = await seedPublishedArtwork(database.db, artistId, "Flagged");
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");

    const uploads = await createFlaggedUploads(database.db);
    const deps = depsFor(database.db, { uploads });

    await report(deps, reported, "offensive_content", "192.0.2.72");
    await database.db.query(
      `insert into stand_in_upload_events (artwork_id, verdict, note)
       values ($1, 'needs_review', 'Safety screening was unavailable')`,
      [flagged],
    );

    const queue = await listQueue(deps, adminId);

    expect(queue).toHaveLength(2);
    const flaggedItem = queue.find((item) => item.kind === "flagged_upload");
    expect(flaggedItem).toMatchObject({
      subjectType: "artwork",
      subjectId: flagged,
      reportCount: 0,
      status: "open",
      flagNote: "Safety screening was unavailable",
    });
    expect(queue.find((item) => item.kind === "report")?.subjectId).toBe(reported);
  });

  it("is empty when nothing is open, rather than failing", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin J.");
    const deps = depsFor(database.db);

    expect(await listQueue(deps, adminId)).toEqual([]);
  });
});

describe("resolving a queue item", () => {
  const database = useTestDatabase();

  it("closes it, leaves the artwork alone, and records the note and the admin", async () => {
    // "An admin dismisses a queue item with a note -> the item closes, the
    // artwork is unaffected, and the note and acting admin are recorded."
    const adminId = await seedAccount(database.db, ["admin"], "Admin K.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "not_original_work", "192.0.2.80");
    await report(deps, artworkId, "mass_produced", "192.0.2.81");

    const result = await resolveQueueItem(deps, {
      actorId: adminId,
      subjectType: "artwork",
      subjectId: artworkId,
      outcome: "dismissed",
      note: "Checked the artist's studio photographs; the work is theirs.",
    });

    // One decision closed the whole group.
    expect(result.resolvedCount).toBe(2);
    expect(await listQueue(deps, adminId)).toEqual([]);

    const rows = await database.db.query<{
      status: string;
      resolved_by: string;
      resolution_note: string;
      resolved_at: Date;
    }>(
      "select status, resolved_by, resolution_note, resolved_at from reports where artwork_id = $1",
      [artworkId],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.status).toBe("dismissed");
      expect(row.resolved_by).toBe(adminId);
      expect(row.resolution_note).toMatch(/studio photographs/);
      expect(row.resolved_at).toBeInstanceOf(Date);
    }

    // The artwork is untouched: still published, still visible.
    const artwork = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(artwork.status).toBe("published");
  });

  it("records an audit entry naming the actor and what was decided", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin L.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "undeclared_ai", "192.0.2.82");

    const result = await resolveQueueItem(deps, {
      actorId: adminId,
      subjectType: "artwork",
      subjectId: artworkId,
      outcome: "actioned",
      note: "Listing corrected by the artist.",
    });

    const trail = await readAuditTrail(database.db, { action: "report_resolution" });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: "report_resolution",
      actor: adminId,
      targetType: "report",
      targetId: artworkId,
      note: "Listing corrected by the artist.",
    });
    expect(trail[0]!.details).toMatchObject({
      subject_type: "artwork",
      outcome: "actioned",
      resolved_count: 1,
    });
    expect(trail[0]!.id).toBe(result.audit.id);
    expect(await verifyAuditChain(database.db)).toMatchObject({ ok: true });
  });

  it("refuses a resolution with no note, and changes nothing", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin M.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.83");

    for (const note of ["", "   "]) {
      await expect(
        resolveQueueItem(deps, {
          actorId: adminId,
          subjectType: "artwork",
          subjectId: artworkId,
          outcome: "dismissed",
          note,
        }),
      ).rejects.toMatchObject({ kind: "validation", code: "moderation.resolution_note_required" });
    }

    expect(await listQueue(deps, adminId)).toHaveLength(1);
    expect(await readAuditTrail(database.db)).toEqual([]);
  });

  it("refuses a non-admin, with not-found, and changes nothing", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin N.");
    const buyerId = await seedAccount(database.db, ["buyer"], "Buyer O.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.84");

    await expect(
      resolveQueueItem(deps, {
        actorId: buyerId,
        subjectType: "artwork",
        subjectId: artworkId,
        outcome: "dismissed",
        note: "Nothing to see here",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const row = await database.db.one<{ status: string }>(
      "select status from reports where artwork_id = $1",
      [artworkId],
    );
    expect(row.status).toBe("open");
    expect(await readAuditTrail(database.db)).toEqual([]);

    // Positive control: the same call, by an admin, works.
    await expect(
      resolveQueueItem(deps, {
        actorId: adminId,
        subjectType: "artwork",
        subjectId: artworkId,
        outcome: "dismissed",
        note: "Reviewed and dismissed",
      }),
    ).resolves.toMatchObject({ resolvedCount: 1 });
  });

  it("refuses a subject with nothing open, so two admins cannot both think they decided it", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin P.");
    const secondAdminId = await seedAccount(database.db, ["admin"], "Admin Q.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.85");

    await resolveQueueItem(deps, {
      actorId: adminId,
      subjectType: "artwork",
      subjectId: artworkId,
      outcome: "dismissed",
      note: "First admin got here first",
    });

    await expect(
      resolveQueueItem(deps, {
        actorId: secondAdminId,
        subjectType: "artwork",
        subjectId: artworkId,
        outcome: "actioned",
        note: "Second admin, same item",
      }),
    ).rejects.toMatchObject({ kind: "not_found", code: "moderation.queue_item_not_found" });

    // The first decision stands, unedited, and only one audit entry exists.
    const row = await database.db.one<{ status: string; resolution_note: string }>(
      "select status, resolution_note from reports where artwork_id = $1",
      [artworkId],
    );
    expect(row.status).toBe("dismissed");
    expect(row.resolution_note).toMatch(/First admin/);
    expect(await readAuditTrail(database.db, { action: "report_resolution" })).toHaveLength(1);
  });

  it("refuses a subject that was never reported", async () => {
    const adminId = await seedAccount(database.db, ["admin"], "Admin R.");
    const deps = depsFor(database.db);

    await expect(
      resolveQueueItem(deps, {
        actorId: adminId,
        subjectType: "artwork",
        subjectId: randomUUID(),
        outcome: "dismissed",
        note: "Nothing here",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("leaves nothing behind when the audit write fails", async () => {
    // Same coupling as every other admin action: the resolution and its audit
    // entry are one transaction. The note is bounded at 2000 characters on
    // admin_audit.note, so an over-long one fails the audit insert after the
    // reports have already been updated.
    const adminId = await seedAccount(database.db, ["admin"], "Admin S.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.86");

    await expect(
      resolveQueueItem(deps, {
        actorId: adminId,
        subjectType: "artwork",
        subjectId: artworkId,
        outcome: "dismissed",
        note: "n".repeat(2001),
      }),
    ).rejects.toThrow();

    // The reports were never closed...
    const row = await database.db.one<{ status: string; resolved_by: string | null }>(
      "select status, resolved_by from reports where artwork_id = $1",
      [artworkId],
    );
    expect(row.status).toBe("open");
    expect(row.resolved_by).toBeNull();

    // ...and the item is still in the queue for somebody to decide.
    expect(await listQueue(deps, adminId)).toHaveLength(1);
    expect(await readAuditTrail(database.db)).toEqual([]);
  });

  it("does not reopen a decided item, even from the privileged connection", async () => {
    // The update policy only admits an OPEN report, so a closed one cannot be
    // quietly re-dismissed with a different note. Asserted here as the
    // observable it protects: the resolution that was recorded is the one that
    // stays recorded.
    const adminId = await seedAccount(database.db, ["admin"], "Admin T.");
    const artistId = await seedArtist(database.db);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    await setConfig(database.db, "moderation.operator_email", "ops@pachka.example");
    const deps = depsFor(database.db);
    await report(deps, artworkId, "other", "192.0.2.87");

    await resolveQueueItem(deps, {
      actorId: adminId,
      subjectType: "artwork",
      subjectId: artworkId,
      outcome: "dismissed",
      note: "The decision of record",
    });

    const before = await database.db.one<{ resolution_note: string; status: string }>(
      "select resolution_note, status from reports where artwork_id = $1",
      [artworkId],
    );

    // A second resolution finds nothing open and refuses.
    await expect(
      resolveQueueItem(deps, {
        actorId: adminId,
        subjectType: "artwork",
        subjectId: artworkId,
        outcome: "actioned",
        note: "A different story",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const after = await database.db.one<{ resolution_note: string; status: string }>(
      "select resolution_note, status from reports where artwork_id = $1",
      [artworkId],
    );
    expect(after).toEqual(before);
  });
});
