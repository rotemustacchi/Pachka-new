/**
 * Manual settlement: what an operator can record, and what they cannot.
 *
 * `artist-payouts`, *Manual settlement recorded by an operator*: "An operator
 * SHALL mark a payout settled by recording a settlement date and a bank transfer
 * reference. The system SHALL NOT initiate any transfer itself."
 *
 * Three rejections have their own tests because the spec states them as
 * scenarios and ARCHITECTURE.md's test policy makes every stated rejection
 * mandatory: settling something ineligible, settling for an artist with no bank
 * details, and settling the same payout twice -- the last one raced for real,
 * on two connections, because SECURITY.md S1-10 item 4 is about a
 * double-submitted admin form and a sequential test proves nothing about it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";
import type { Database, Sql } from "@/shared/db";
import { readAuditTrail, recordAdminAction, requireAdmin } from "@/modules/moderation";
import {
  payableQueue,
  recordFulfilmentPaid,
  settlePayout,
  artistPayouts,
  PAYOUT_TEMPLATES,
  type AdminActionPort,
  type PayoutsDeps,
} from "@/modules/payouts";

/** The adapter the composition root owes this module. See payouts-ledger.test.ts. */
function moderationAdmin(): AdminActionPort {
  return {
    async authorise(sql: Sql, userId: string | null | undefined) {
      const actor = await requireAdmin(sql, userId);
      await sql.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.userId]);
      return actor;
    },
    async record(sql: Sql, entry) {
      return recordAdminAction(sql, entry);
    },
  };
}

function deps(database: TestDatabase): PayoutsDeps {
  return { db: database.db, admin: moderationAdmin() };
}

const ACCOUNT_NUMBER = "987654321";

async function seedArtist(db: Database, name = "יעל", withDetails = true): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  if (withDetails) {
    // SECURITY.md S1-11's seeded account number, so the privacy sweep in
    // payouts-privacy.test.ts is looking for the same string this one writes.
    await db.query(
      `insert into artist_payout_details
         (user_id, bank_name, branch, account_number, account_holder_name)
       values ($1, 'בנק הפועלים', '605', $2, 'יעל אברמוביץ')`,
      [id, ACCOUNT_NUMBER],
    );
  }
  return id;
}

async function seedBuyer(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'דנה')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

async function seedOperator(database: TestDatabase): Promise<string> {
  const id = randomUUID();
  await database.db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await grantAdminRole(database, id);
  return id;
}

async function seedSale(
  db: Database,
  artistId: string,
  buyerId: string,
  hoursAgo: number | null = 20 * 24,
  subtotal = 100_000,
): Promise<{ orderId: string; fulfilmentId: string }> {
  const order = await db.one<{ id: string }>(
    `insert into orders
       (buyer_id, status, subtotal_agorot, shipping_agorot, total_agorot, commission_rate_bp)
     values ($1, 'delivered', $2, 5000, $3, 1500) returning id`,
    [buyerId, subtotal, subtotal + 5_000],
  );
  const fulfilment = await db.one<{ id: string }>(
    `insert into fulfilments
       (order_id, artist_id, status, items_subtotal_agorot, shipping_agorot, delivered_at)
     values ($1, $2, 'delivered', $3, 5000,
             ${hoursAgo === null ? "null" : "now() - make_interval(hours => $4::int)"})
     returning id`,
    hoursAgo === null ? [order.id, artistId, subtotal] : [order.id, artistId, subtotal, hoursAgo],
  );
  if (hoursAgo !== null) {
    await db.query(
      `insert into order_transitions
         (order_id, fulfilment_id, from_status, to_status, actor_id, actor_kind, occurred_at)
       values ($1, $2, 'shipped', 'delivered', $3, 'buyer', now() - make_interval(hours => $4::int))`,
      [order.id, fulfilment.id, buyerId, hoursAgo],
    );
  }
  return { orderId: order.id, fulfilmentId: fulfilment.id };
}

const TODAY = new Date().toISOString().slice(0, 10);

describe("an operator settling an eligible payout", () => {
  const database = useTestDatabase();

  it("records the date and the reference, and marks the payout settled", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    const result = await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "HAP-2026-09-03-0417",
    });

    expect(result.entry.entryType).toBe("settlement");
    expect(result.entry.parentEntryId).toBe(entry.id);
    expect(result.entry.settledOn).toBe(TODAY);
    expect(result.entry.bankReference).toBe("HAP-2026-09-03-0417");
    expect(result.entry.settledBy).toBe(operatorId);
    // The money leaves the balance: the settlement is the negative of the net.
    expect(result.entry.netAgorot).toBe(-85_000);
    expect(result.payout.status).toBe("settled");
  });

  it("brings the artist's outstanding balance to zero without deleting anything", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "REF-1",
    });

    const view = await artistPayouts(deps(database), artistId);
    expect(view.totals.outstandingAgorot).toBe(0);
    expect(view.totals.eligibleAgorot).toBe(0);
    expect(view.totals.settledAgorot).toBe(85_000);

    // Both rows still there. An append-only ledger settles by appending.
    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where artist_id = $1",
      [artistId],
    );
    expect(rowCount).toBe(2);
  });

  it("writes exactly one audit entry, naming the payout and the operator", async () => {
    // SECURITY.md S1-14 lists `payout_settlement` among the audited actions, and
    // item 3 requires the entry to share the action's transaction.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "REF-77",
    });

    const trail = await readAuditTrail(database.db, { action: "payout_settlement" });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actor).toBe(operatorId);
    expect(trail[0]?.targetType).toBe("payout");
    expect(trail[0]?.targetId).toBe(entry.id);
    expect(trail[0]?.details).toMatchObject({ net_payable_agorot: 85_000, bank_reference: "REF-77" });
  });

  it("tells the artist the amount, the date and the reference, and nothing about their bank", async () => {
    // SECURITY.md S1-11 item 3: "It does not contain the account number, branch,
    // or bank." The notification is returned rather than sent, so this asserts
    // what it SAYS rather than that a mailer was called.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    const result = await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "REF-9",
    });

    expect(result.notifications).toHaveLength(1);
    const message = result.notifications[0];
    expect(message?.template).toBe(PAYOUT_TEMPLATES.payoutSettled);
    expect(message?.recipientId).toBe(artistId);
    expect(message?.data).toMatchObject({ netAgorot: 85_000, settledOn: TODAY, bankReference: "REF-9" });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(ACCOUNT_NUMBER);
    expect(serialised).not.toContain("בנק הפועלים");
    expect(serialised).not.toContain("605");
  });
});

describe("settling a payout that is not eligible", () => {
  const database = useTestDatabase();

  it("is rejected and states the eligibility date", async () => {
    // `artist-payouts`, *Settling an ineligible payout*: "the system rejects the
    // action and states the eligibility date."
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId, 24);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    const rejection = await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "TOO-EARLY",
    }).catch((error: unknown) => error);

    expect(rejection).toMatchObject({ kind: "conflict", code: "payouts.not_eligible" });
    const details = (rejection as { details: Record<string, unknown> }).details;
    expect(details.blockedBy).toBe("within_return_window");
    // The date itself, structured, so a route can render it.
    expect(typeof details.eligibleAt).toBe("string");
    expect((rejection as Error).message).toContain(String(details.eligibleAt));

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where entry_type = 'settlement'",
    );
    expect(rowCount).toBe(0);
  });

  it("is rejected while a return is open, even past the fourteen days", async () => {
    // SECURITY.md S1-10's third test: deliver, request a return on day 13,
    // advance to day 15, attempt settlement. "Assert the settlement is rejected
    // and the ledger has no settlement entry."
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId, 15 * 24);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    await database.db.query(
      `insert into returns
         (order_id, fulfilment_id, artwork_id, buyer_id, artist_id, status,
          delivered_at, receipt_deadline_at, item_subtotal_agorot)
       values ($1, $2, $3, $4, $5, 'requested',
               now() - interval '15 days', now() + interval '5 days', 100000)`,
      [sale.orderId, sale.fulfilmentId, randomUUID(), buyerId, artistId],
    );

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "SHOULD-NOT-LAND",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "payouts.not_eligible" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where entry_type = 'settlement'",
    );
    expect(rowCount).toBe(0);
  });

  it("is rejected for a parcel that was never confirmed delivered", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId, null);
    await database.db.query("update fulfilments set status = 'paid' where id = $1", [
      sale.fulfilmentId,
    ]);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "NEVER",
      }),
    ).rejects.toMatchObject({ code: "payouts.not_eligible" });
  });
});

describe("settling for an artist with no bank details on file", () => {
  const database = useTestDatabase();

  it("is blocked", async () => {
    // `artist-payouts`, *Settlement blocked without details*.
    const artistId = await seedArtist(database.db, "רון", false);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "NOWHERE-TO-SEND-IT",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "payouts.no_payout_details" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where entry_type = 'settlement'",
    );
    expect(rowCount).toBe(0);
  });

  it("is blocked when the row exists but a field was left blank", async () => {
    // Four fields are required. A row with three of them is not details on file,
    // and "the row exists" is the check somebody writes by accident.
    const artistId = await seedArtist(database.db, "נועה", false);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    await database.db.query(
      `insert into artist_payout_details (user_id, bank_name, branch, account_number)
       values ($1, 'בנק לאומי', '800', '111222333')`,
      [artistId],
    );
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "INCOMPLETE",
      }),
    ).rejects.toMatchObject({ code: "payouts.no_payout_details" });
  });

  it("still shows the payout in the payable queue, flagged as not settleable", async () => {
    // An operator has to be able to see that somebody is owed money and cannot
    // be paid; hiding the row would hide the problem.
    const artistId = await seedArtist(database.db, "רון", false);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    const queue = await payableQueue(deps(database));

    expect(queue).toHaveLength(1);
    expect(queue[0]?.settleable).toBe(false);
    expect(queue[0]?.payoutDetails.onFile).toBe(false);
    expect(queue[0]?.payableNetAgorot).toBe(85_000);
  });
});

describe("a double-submitted settlement", () => {
  const database = useTestDatabase();

  it("is refused the second time, sequentially", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "FIRST",
    });

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "SECOND",
      }),
    ).rejects.toMatchObject({ kind: "conflict", code: "payouts.already_settled" });
  });

  it("produces exactly one settlement when raced for real on two connections", async () => {
    // SECURITY.md S1-10's fourth test: "Submit the settlement action twice
    // concurrently for the same eligible payout. Assert exactly one settlement
    // entry exists and the artist's settled total equals the net payable once,
    // not twice." Genuinely parallel, per ARCHITECTURE.md: a sequential pair
    // proves nothing about the lock.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    const attempt = (reference: string) =>
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: reference,
      });

    const outcomes = await Promise.allSettled([attempt("RACE-A"), attempt("RACE-B")]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from payout_ledger where entry_type = 'settlement'",
    );
    expect(rows[0]?.count).toBe("1");

    // Paid once, not twice.
    const view = await artistPayouts(deps(database), artistId);
    expect(view.totals.outstandingAgorot).toBe(0);
    expect(view.totals.settledAgorot).toBe(85_000);
  });
});

describe("what an operator may type", () => {
  const database = useTestDatabase();

  async function eligibleEntry() {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    return { entry, operatorId };
  }

  it("refuses a settlement date in the future, because the transfer has not happened", async () => {
    const { entry, operatorId } = await eligibleEntry();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: tomorrow,
        bankReference: "FUTURE",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "payouts.settlement_date_future" });
  });

  it("refuses a date that is not a date", async () => {
    const { entry, operatorId } = await eligibleEntry();

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: "2026-02-31",
        bankReference: "NOPE",
      }),
    ).rejects.toMatchObject({ code: "payouts.settlement_date_invalid" });
  });

  it("refuses a settlement with no transfer reference, because nothing could be reconciled", async () => {
    const { entry, operatorId } = await eligibleEntry();

    await expect(
      settlePayout(deps(database), {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "   ",
      }),
    ).rejects.toMatchObject({ kind: "validation", code: "payouts.bank_reference_required" });
  });

  it("refuses anybody who is not an admin, as not-found", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    await expect(
      settlePayout(deps(database), {
        actorId: artistId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "PAYING-MYSELF",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where entry_type = 'settlement'",
    );
    expect(rowCount).toBe(0);
  });

  it("cannot settle anything at all when no audit writer is wired in", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const sale = await seedSale(database.db, artistId, buyerId);
    const { entry } = await recordFulfilmentPaid({ db: database.db }, sale.fulfilmentId);

    await expect(
      settlePayout({ db: database.db }, {
        actorId: operatorId,
        ledgerEntryId: entry.id,
        settledOn: TODAY,
        bankReference: "UNAUDITED",
      }),
    ).rejects.toMatchObject({ code: "payouts.audit_writer_unwired" });

    const { rowCount } = await database.db.query(
      "select 1 from payout_ledger where entry_type = 'settlement'",
    );
    expect(rowCount).toBe(0);
  });
});

describe("the payable queue", () => {
  const database = useTestDatabase();

  it("lists eligible unsettled payouts and drops them once settled", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const operatorId = await seedOperator(database);
    const eligible = await seedSale(database.db, artistId, buyerId, 20 * 24, 100_000);
    const tooEarly = await seedSale(database.db, artistId, buyerId, 24, 300_000);
    const { entry } = await recordFulfilmentPaid(deps(database), eligible.fulfilmentId);
    await recordFulfilmentPaid(deps(database), tooEarly.fulfilmentId);

    const before = await payableQueue(deps(database));
    expect(before).toHaveLength(1);
    expect(before[0]?.payableNetAgorot).toBe(85_000);
    expect(before[0]?.settleable).toBe(true);
    // Masked by default. SECURITY.md S1-11 item 2.
    expect(before[0]?.payoutDetails.accountNumberLast4).toBe("4321");
    expect(JSON.stringify(before)).not.toContain(ACCOUNT_NUMBER);

    await settlePayout(deps(database), {
      actorId: operatorId,
      ledgerEntryId: entry.id,
      settledOn: TODAY,
      bankReference: "DONE",
    });

    expect(await payableQueue(deps(database))).toHaveLength(0);
  });
});
