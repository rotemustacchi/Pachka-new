/**
 * The admin routes: who is let in, and what a refusal says.
 *
 * The refusal is the interesting half. moderation-admin requires a non-admin to
 * get a NOT-FOUND, never a forbidden, and this file's job is to prove the
 * routing layer does not soften that on the way out -- neither by rephrasing
 * the message nor by answering a malformed submission differently from a
 * well-formed one. Both would be leaks: a distinguishable answer tells a prober
 * that the surface is there and that their account is real.
 *
 * Every refusal is paired with the same call made by an admin, which is what
 * keeps the assertion from passing vacuously against a surface that refuses
 * everyone or has no data to refuse.
 *
 * Nothing is mocked except Supabase Auth, which is an external boundary and the
 * only fake ARCHITECTURE.md's test policy allows.
 */
import { describe, expect, it } from "vitest";
import { grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import type { Database } from "@/shared/db";
import {
  fileReport,
  isAccountSuspended,
  listQueue,
  readAuditTrail,
  type ModerationDeps,
} from "@/modules/moderation";
import { setRate, upsertTier, upsertZone } from "@/modules/shipping";
import { adminOrNotFound } from "@/app/admin/access";
import {
  reinstateFromForm,
  resolveFromForm,
  suspendFromForm,
  takeDownFromForm,
} from "@/app/admin/queue-forms";
import { setRateFromForm } from "@/app/admin/shipping/rate-forms";

/** Next's not-found, as it arrives at the routing layer. */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

/** The module's refusal, verbatim. Every surface must say exactly this. */
const REFUSAL = "Not found";

function depsFor(db: Database): ModerationDeps {
  return { db, auth: new FakeAuthGateway() };
}

async function seedAccount(
  database: TestDatabase,
  roles: readonly string[],
  name: string,
): Promise<string> {
  const db = database.db;
  const { rows } = await db.query<{ user_id: string }>(
    "insert into profiles (user_id, display_name) values (gen_random_uuid(), $1) returning user_id",
    [name],
  );
  const id = rows[0]!.user_id;
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  for (const role of roles) {
    // `admin` is not grantable through the application (SECURITY.md S0-2), so
    // it is seeded the way an operator would grant it: with database
    // credentials, out of band.
    if (role === "admin") await grantAdminRole(database, id);
    else await db.query("insert into user_roles (user_id, role) values ($1, $2)", [id, role]);
  }
  return id;
}

async function seedArtist(database: TestDatabase, name = "Tamar S."): Promise<string> {
  const id = await seedAccount(database, ["buyer", "artist"], name);
  await database.db.query(
    "insert into artist_profiles (user_id, display_name) values ($1, $2)",
    [id, name],
  );
  return id;
}

async function seedPublishedArtwork(db: Database, artistId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into artworks (
       artist_id, status, title, description, price_agorot,
       height_mm, width_mm, weight_grams, materials, lead_time_days,
       medium, styles, moods, is_framed,
       originality_declared_by, originality_declared_at, ai_assisted, published_at
     ) values (
       $1, 'published', 'Harbour Light', 'A study in blue.', 90000,
       350, 250, 900, 'Acrylic on board', 4,
       'painting_illustration', array['minimalist']::text[], array['calm']::text[], false,
       $1, now(), false, now()
     ) returning id`,
    [artistId],
  );
  return rows[0]!.id;
}

function formOf(values: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe("who reaches an admin page", () => {
  const database = useTestDatabase();

  it("lets an admin in", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");

    await expect(adminOrNotFound(database.db, adminId)).resolves.toEqual({ userId: adminId });
  });

  it("answers not-found for a buyer, an artist, and nobody at all", async () => {
    const buyerId = await seedAccount(database, ["buyer"], "Buyer B.");
    const artistId = await seedArtist(database, "Artist C.");

    for (const caller of [buyerId, artistId, null, undefined]) {
      await expect(adminOrNotFound(database.db, caller)).rejects.toMatchObject({
        digest: NOT_FOUND_DIGEST,
      });
    }
  });

  it("answers not-found for an admin whose own account is suspended", async () => {
    // SECURITY.md S1-13: a live token belonging to a suspended account
    // authorises nothing, and the admin's own account is where that matters
    // most.
    const adminId = await seedAccount(database, ["admin"], "Admin D.");
    await database.db.query(
      "update account_status set suspended_at = now(), suspended_reason = 'under review' where user_id = $1",
      [adminId],
    );

    await expect(adminOrNotFound(database.db, adminId)).rejects.toMatchObject({
      digest: NOT_FOUND_DIGEST,
    });
  });
});

describe("a non-admin submitting an admin form", () => {
  const database = useTestDatabase();

  it("is refused with the same sentence by every surface, and changes nothing", async () => {
    const buyerId = await seedAccount(database, ["buyer"], "Buyer B.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const deps = depsFor(database.db);

    const refusals = [
      await resolveFromForm(deps, buyerId, formOf({
        subjectType: "artwork",
        subjectId: artworkId,
        outcome: "dismissed",
        note: "looks fine",
      })),
      await takeDownFromForm(deps, buyerId, formOf({ artworkId, reason: "stolen" })),
      await suspendFromForm(deps, buyerId, formOf({ userId: artistId, reason: "fraud" })),
      await reinstateFromForm(deps, buyerId, formOf({ userId: artistId })),
      await setRateFromForm(database.db, buyerId, formOf({
        zoneCode: "centre",
        tierCode: "small",
        amountShekels: "1",
      })),
    ];

    for (const state of refusals) {
      expect(state).toEqual({ status: "error", message: REFUSAL });
    }

    // Nothing moved, and nothing was audited.
    const { rows } = await database.db.query<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(rows[0]!.status).toBe("published");
    await expect(isAccountSuspended(database.db, artistId)).resolves.toBe(false);
    await expect(readAuditTrail(database.db)).resolves.toEqual([]);
  });

  it("is refused identically when the submission is malformed", async () => {
    // Authorisation happens before the input is looked at. Otherwise a
    // non-admin who omits the note is told "say why you are closing this item",
    // which is a different answer and therefore a leak.
    const buyerId = await seedAccount(database, ["buyer"], "Buyer B.");
    const deps = depsFor(database.db);

    const empty = new FormData();
    expect(await resolveFromForm(deps, buyerId, empty)).toEqual({
      status: "error",
      message: REFUSAL,
    });
    expect(await takeDownFromForm(deps, buyerId, empty)).toEqual({
      status: "error",
      message: REFUSAL,
    });
    expect(await setRateFromForm(database.db, buyerId, empty)).toEqual({
      status: "error",
      message: REFUSAL,
    });
  });

  it("refuses a signed-out visitor the same way", async () => {
    const deps = depsFor(database.db);

    expect(await resolveFromForm(deps, null, new FormData())).toEqual({
      status: "error",
      message: REFUSAL,
    });
  });
});

describe("an admin working the queue", () => {
  const database = useTestDatabase();

  it("closes every open report on a subject with one decision", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const deps = depsFor(database.db);

    await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "not_original_work",
      clientId: "198.51.100.7",
    });
    await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "undeclared_ai",
      clientId: "198.51.100.8",
    });

    expect(await listQueue(deps, adminId)).toHaveLength(1);

    const state = await resolveFromForm(deps, adminId, formOf({
      subjectType: "artwork",
      subjectId: artworkId,
      outcome: "dismissed",
      note: "Checked the artist's studio photos; the work is theirs.",
    }));

    expect(state.status).toBe("ok");
    expect(await listQueue(deps, adminId)).toHaveLength(0);

    // The decision is audited, and the artwork is untouched: dismissing the
    // reports is not the same decision as acting on the subject.
    const audit = await readAuditTrail(database.db, { action: "report_resolution" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(adminId);

    const { rows } = await database.db.query<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(rows[0]!.status).toBe("published");
  });

  it("refuses a resolution with no note", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    const deps = depsFor(database.db);

    await fileReport(deps, {
      subject: { type: "artwork", artworkId },
      reason: "other",
      details: "Something is off about this listing.",
      clientId: "198.51.100.9",
    });

    const state = await resolveFromForm(deps, adminId, formOf({
      subjectType: "artwork",
      subjectId: artworkId,
      outcome: "dismissed",
      note: "   ",
    }));

    expect(state.status).toBe("error");
    expect(state.fields?.note?.[0]).toBeTruthy();
    expect(await listQueue(deps, adminId)).toHaveLength(1);
  });

  it("takes an artwork down, and says whether the artist was actually told", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);
    // No mailer wired, which is the deployment's real state today.
    const deps = depsFor(database.db);

    const state = await takeDownFromForm(deps, adminId, formOf({
      artworkId,
      reason: "Not the artist's own work",
      note: "Matches a stock photograph.",
    }));

    expect(state.status).toBe("ok");
    expect(state.message).toContain("לא נשלחה");

    const { rows } = await database.db.query<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(rows[0]!.status).toBe("removed");

    const audit = await readAuditTrail(database.db, { action: "artwork_takedown" });
    expect(audit).toHaveLength(1);
  });

  it("requires a reason for a takedown", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    const artistId = await seedArtist(database);
    const artworkId = await seedPublishedArtwork(database.db, artistId);

    const state = await takeDownFromForm(depsFor(database.db), adminId, formOf({ artworkId }));

    expect(state.status).toBe("error");
    expect(state.fields?.reason?.[0]).toBeTruthy();

    const { rows } = await database.db.query<{ status: string }>(
      "select status from artworks where id = $1",
      [artworkId],
    );
    expect(rows[0]!.status).toBe("published");
  });

  it("suspends an account and lifts the suspension again", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    const artistId = await seedArtist(database);
    await seedPublishedArtwork(database.db, artistId);
    const deps = depsFor(database.db);

    const suspended = await suspendFromForm(deps, adminId, formOf({
      userId: artistId,
      reason: "Selling mass-produced prints as originals",
    }));
    expect(suspended.status).toBe("ok");
    await expect(isAccountSuspended(database.db, artistId)).resolves.toBe(true);

    const lifted = await reinstateFromForm(deps, adminId, formOf({
      userId: artistId,
      note: "Artist provided studio evidence.",
    }));
    expect(lifted.status).toBe("ok");
    await expect(isAccountSuspended(database.db, artistId)).resolves.toBe(false);

    const actions = (await readAuditTrail(database.db)).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(["account_suspension", "account_reinstatement"]),
    );
  });
});

describe("an admin editing the shipping rate table", () => {
  const database = useTestDatabase();

  async function seedCell(db: Database): Promise<void> {
    await upsertZone(db, {
      code: "quiet_valley",
      displayName: "עמק שקט",
      cities: ["quiet valley"],
      postalPrefixes: ["4242"],
    });
    await upsertTier(db, {
      code: "flat_print",
      displayName: "הדפס שטוח",
      ordinal: 15,
      maxLengthMm: 700,
      maxWidthMm: 500,
      maxHeightMm: 80,
      maxWeightGrams: 4000,
    });
    await setRate(db, { zoneCode: "quiet_valley", tierCode: "flat_print", amountAgorot: 3900 });
  }

  it("changes the rate and records the change in the audit trail", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    await seedCell(database.db);

    const state = await setRateFromForm(database.db, adminId, formOf({
      zoneCode: "quiet_valley",
      tierCode: "flat_print",
      amountShekels: "52.50",
      note: "Carrier raised the flat rate.",
    }));

    expect(state.status).toBe("ok");

    const { rows } = await database.db.query<{ amount_agorot: string }>(
      `select r.amount_agorot
         from shipping_rates r
         join shipping_zones z on z.id = r.zone_id
         join shipping_tiers t on t.id = r.tier_id
        where z.code = 'quiet_valley' and t.code = 'flat_print'`,
    );
    expect(rows[0]!.amount_agorot).toBe("5250");

    const audit = await readAuditTrail(database.db, { action: "rate_table_change" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.targetId).toBe("quiet_valley:flat_print");
    expect(audit[0]!.actor).toBe(adminId);
  });

  it("refuses a cell that does not exist rather than inventing one", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    await seedCell(database.db);

    const state = await setRateFromForm(database.db, adminId, formOf({
      zoneCode: "quiet_valley",
      tierCode: "no_such_tier",
      amountShekels: "10",
    }));

    expect(state.status).toBe("error");
    await expect(readAuditTrail(database.db)).resolves.toEqual([]);
  });

  it("refuses an unreadable amount against the field it was typed in", async () => {
    const adminId = await seedAccount(database, ["admin"], "Admin A.");
    await seedCell(database.db);

    const state = await setRateFromForm(database.db, adminId, formOf({
      zoneCode: "quiet_valley",
      tierCode: "flat_print",
      amountShekels: "כמה שיוצא",
    }));

    expect(state.status).toBe("error");
    expect(state.fields?.amountShekels?.[0]).toBeTruthy();
    await expect(readAuditTrail(database.db)).resolves.toEqual([]);
  });
});
