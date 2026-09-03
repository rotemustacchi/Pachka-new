/**
 * When a payout becomes payable, against the real tables.
 *
 * `artist-payouts`: "A payout SHALL become eligible only when its fulfilment has
 * been in `delivered` state for the full 14-day return window without a return
 * request. A fulfilment under `return_requested` SHALL NOT be eligible. The
 * artist SHALL be able to see the exact date their payout becomes eligible."
 *
 * WHY THESE TESTS SEED TIMESTAMPS RATHER THAN DRIVING THE STATE MACHINE
 * ---------------------------------------------------------------------
 * The rule under test is arithmetic on a timestamp, and the interesting values
 * are fourteen days apart. `order_transitions` has no UPDATE policy for any role
 * -- deliberately, it is a history -- so a transition written by
 * `orders.transition()` cannot be moved backwards afterwards, and there is no
 * sleeping for a fortnight.
 *
 * So the delivered transition is INSERTED with an explicit `occurred_at`, which
 * is the same row `orders` writes and the same column this module reads. That is
 * not a shortcut around the state machine: `orders-lifecycle.test.ts` already
 * proves the machine writes these rows and refuses to let an artist write this
 * one (SECURITY.md SPEC-D). What is under test here is what `payouts` concludes
 * from a row that exists, including the case where one does NOT.
 *
 * ARCHITECTURE.md's "no sleep" rule is honoured: nothing here waits. The clock
 * is moved by choosing when the past happened, not by living through it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useTestDatabase, type TestDatabase } from "../harness";
import type { Database } from "@/shared/db";
import {
  artistPayouts,
  payoutViewsForArtist,
  recordFulfilmentPaid,
  eligibilityDelayDays,
  type PayoutsDeps,
} from "@/modules/payouts";

function deps(database: TestDatabase): PayoutsDeps {
  return { db: database.db };
}

async function seedArtist(db: Database, name = "יעל"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, $2)", [id, name]);
  return id;
}

async function seedBuyer(db: Database, name = "דנה כהן"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, name]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  return id;
}

interface SaleOptions {
  readonly itemsSubtotalAgorot?: number;
  readonly shippingAgorot?: number;
  readonly commissionRateBp?: number;
  /** Null means the parcel was never confirmed delivered. */
  readonly deliveredHoursAgo?: number | null;
  readonly fulfilmentStatus?: string;
  /** Write `fulfilments.delivered_at` WITHOUT an accompanying transition row. */
  readonly forgeDeliveredColumn?: boolean;
}

interface Sale {
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
}

/**
 * One order, one artist, one parcel, at whatever point in its life the test
 * needs. Inserted rather than driven, for the reason in the file header.
 */
async function seedSale(
  db: Database,
  artistId: string,
  buyerId: string,
  options: SaleOptions = {},
): Promise<Sale> {
  const subtotal = options.itemsSubtotalAgorot ?? 100_000;
  const shipping = options.shippingAgorot ?? 5_000;
  const rateBp = options.commissionRateBp ?? 1_500;
  const status = options.fulfilmentStatus ?? "delivered";
  const deliveredHoursAgo = options.deliveredHoursAgo === undefined ? null : options.deliveredHoursAgo;

  const order = await db.one<{ id: string }>(
    `insert into orders
       (buyer_id, status, subtotal_agorot, shipping_agorot, total_agorot, commission_rate_bp)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [buyerId, status, subtotal, shipping, subtotal + shipping, rateBp],
  );

  const deliveredAt =
    deliveredHoursAgo === null && options.forgeDeliveredColumn !== true
      ? null
      : `now() - make_interval(hours => ${deliveredHoursAgo ?? 15 * 24})`;

  const fulfilment = await db.one<{ id: string }>(
    `insert into fulfilments
       (order_id, artist_id, status, items_subtotal_agorot, shipping_agorot, delivered_at)
     values ($1, $2, $3, $4, $5, ${deliveredAt ?? "null"}) returning id`,
    [order.id, artistId, status, subtotal, shipping],
  );

  // The row `payouts` actually reads. Absent when the test is proving that a
  // forged `delivered_at` column buys an artist nothing.
  if (deliveredHoursAgo !== null && options.forgeDeliveredColumn !== true) {
    await db.query(
      `insert into order_transitions
         (order_id, fulfilment_id, from_status, to_status, actor_id, actor_kind, occurred_at)
       values ($1, $2, 'shipped', 'delivered', $3, 'buyer', now() - make_interval(hours => $4::int))`,
      [order.id, fulfilment.id, buyerId, deliveredHoursAgo],
    );
  }

  return { orderId: order.id, fulfilmentId: fulfilment.id, artworkId: randomUUID() };
}

async function openReturn(
  db: Database,
  sale: Sale,
  artistId: string,
  buyerId: string,
  status = "requested",
): Promise<void> {
  await db.query(
    `insert into returns
       (order_id, fulfilment_id, artwork_id, buyer_id, artist_id, status,
        delivered_at, receipt_deadline_at, item_subtotal_agorot)
     values ($1, $2, $3, $4, $5, $6, now() - interval '9 days', now() + interval '5 days', 100000)`,
    [sale.orderId, sale.fulfilmentId, sale.artworkId, buyerId, artistId, status],
  );
}

describe("the sale entry a paid fulfilment produces", () => {
  const database = useTestDatabase();

  it("records the spec's worked example exactly, with shipping excluded", async () => {
    // `artist-payouts`, *Commission calculated at order time* and *Shipping
    // excluded from commission*: ₪1,000 artwork plus ₪50 shipping at 15% gives
    // ₪150 commission and ₪850 payable. The figure that must NOT appear is
    // 105000 -- the total including postage.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, {
      itemsSubtotalAgorot: 100_000,
      shippingAgorot: 5_000,
      commissionRateBp: 1_500,
      fulfilmentStatus: "paid",
    });

    const { entry, created } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    expect(created).toBe(true);
    expect(entry.grossAgorot).toBe(100_000);
    expect(entry.commissionAgorot).toBe(15_000);
    expect(entry.netAgorot).toBe(85_000);
    expect(entry.entryType).toBe("sale");
    expect(entry.parentEntryId).toBeNull();
  });

  it("splits at the rate snapshotted on the order, not the rate configured now", async () => {
    // `artist-payouts`, *Rate changes later*: "existing orders retain the rate
    // stored at their placement." The order below was placed at 1000 bp; the
    // platform is now on 2500. The artist keeps the deal they sold under.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, {
      itemsSubtotalAgorot: 100_000,
      commissionRateBp: 1_000,
      fulfilmentStatus: "paid",
    });

    await database.db.query(
      `insert into app_config (key, value, value_type, description)
       values ('platform.commission_rate_bp', '2500'::jsonb, 'integer', 'raised after the sale')
       on conflict (key) do update set value = excluded.value`,
    );

    const { entry } = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    expect(entry.commissionRateBp).toBe(1_000);
    expect(entry.commissionAgorot).toBe(10_000);
    expect(entry.netAgorot).toBe(90_000);
  });

  it("is created once however many times the payment path runs", async () => {
    // The partial unique index, not a read-then-write check. A route that
    // retried, a sweep racing it, and an operator double-clicking all converge.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { fulfilmentStatus: "paid" });

    const first = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    const second = await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from payout_ledger where fulfilment_id = $1",
      [sale.fulfilmentId],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("refuses a fulfilment that has not been paid for", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, {
      fulfilmentStatus: "awaiting_payment",
    });

    await expect(recordFulfilmentPaid(deps(database), sale.fulfilmentId)).rejects.toMatchObject({
      kind: "conflict",
      code: "payouts.fulfilment_not_paid",
    });
  });
});

describe("the fourteen-day return window", () => {
  const database = useTestDatabase();

  async function payoutFor(sale: Sale, artistId: string) {
    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    const delay = await eligibilityDelayDays(database.db);
    const views = await payoutViewsForArtist(database.db, artistId, delay);
    return views[0];
  }

  it("is 14 days by configuration, so this suite is testing the real number", async () => {
    expect(await eligibilityDelayDays(database.db)).toBe(14);
  });

  it("holds the payout one second before the window closes", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    // Delivered 14 days ago minus one hour: the window has not run out.
    const sale = await seedSale(database.db, artistId, buyerId, {
      deliveredHoursAgo: 14 * 24 - 1,
    });

    const payout = await payoutFor(sale, artistId);

    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("within_return_window");
  });

  it("releases it at exactly delivered plus fourteen days", async () => {
    // `artist-payouts`, *Return window closes cleanly*: "WHEN a fulfilment has
    // been delivered for 14 days with no return request THEN its payout becomes
    // eligible and appears in the payable queue."
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 14 * 24 });

    const payout = await payoutFor(sale, artistId);

    expect(payout?.status).toBe("eligible");
    expect(payout?.blockedBy).toBeNull();
  });

  it("has not started at all while the parcel is undelivered", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, {
      deliveredHoursAgo: null,
      fulfilmentStatus: "shipped",
    });

    const payout = await payoutFor(sale, artistId);

    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("awaiting_delivery");
    // No honest date exists yet, so none is invented.
    expect(payout?.eligibleAt).toBeNull();
    expect(payout?.deliveredAt).toBeNull();
  });

  it("moves with the configured delay, because 14 is a setting and not a literal", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 20 * 24 });

    // 30 days: the parcel arrived 20 days ago, so it is not yet payable.
    await database.db.query(
      `insert into app_config (key, value, value_type, description)
       values ('payouts.eligibility_delay_days', '30'::jsonb, 'integer', 'longer window')
       on conflict (key) do update set value = excluded.value`,
    );

    const payout = await payoutFor(sale, artistId);
    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("within_return_window");
  });
});

describe("a return that is open", () => {
  const database = useTestDatabase();

  async function payoutFor(sale: Sale, artistId: string) {
    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    const delay = await eligibilityDelayDays(database.db);
    return (await payoutViewsForArtist(database.db, artistId, delay))[0];
  }

  it("holds the payout even after the fourteen days have run out", async () => {
    // `artist-payouts`, *Return requested during the window*: "WHEN a buyer
    // requests a return on day 9 after delivery THEN the payout does not become
    // eligible and is held pending resolution." SECURITY.md S1-10's third test
    // adds the part that matters: the clock reaching day 15 does not release it.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 15 * 24 });
    await openReturn(database.db, sale, artistId, buyerId, "requested");

    const payout = await payoutFor(sale, artistId);

    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("return_open");
  });

  it.each(["requested", "disputed", "unreceived", "received_intact", "resolved_refunded"])(
    "still holds it while the case is %s",
    async (status) => {
      const artistId = await seedArtist(database.db);
      const buyerId = await seedBuyer(database.db);
      const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 40 * 24 });
      await openReturn(database.db, sale, artistId, buyerId, status);

      expect((await payoutFor(sale, artistId))?.blockedBy).toBe("return_open");
    },
  );

  it("releases it only once an admin has resolved the case against the buyer", async () => {
    // `resolved_denied` is the single exception, so a status added to `shipping`
    // later defaults to withholding the money rather than releasing it.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 40 * 24 });
    await openReturn(database.db, sale, artistId, buyerId, "resolved_denied");

    const payout = await payoutFor(sale, artistId);

    expect(payout?.status).toBe("eligible");
    expect(payout?.blockedBy).toBeNull();
  });

  it("never becomes eligible once the fulfilment itself is returned", async () => {
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, {
      deliveredHoursAgo: 40 * 24,
      fulfilmentStatus: "delivered",
    });
    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    await database.db.query("update fulfilments set status = 'returned' where id = $1", [
      sale.fulfilmentId,
    ]);

    const delay = await eligibilityDelayDays(database.db);
    const payout = (await payoutViewsForArtist(database.db, artistId, delay))[0];

    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("fulfilment_returned");
  });
});

describe("the clock an artist cannot move", () => {
  const database = useTestDatabase();

  it("ignores a delivered_at column with no transition behind it", async () => {
    // SECURITY.md S1-10, second variant: "eligibility computed from a
    // client-supplied or artist-supplied `delivered_at` date rather than a
    // server timestamp -- an artist backdates delivery and collects
    // immediately." The fulfilment below claims it was delivered 15 days ago.
    // `order_transitions` says nothing happened, and `order_transitions` is the
    // table with no UPDATE policy for any role.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, {
      deliveredHoursAgo: 15 * 24,
      forgeDeliveredColumn: true,
    });

    // The forged column really is there, so this test is not passing because
    // the seed silently did nothing.
    const row = await database.db.one<{ delivered_at: Date | null }>(
      "select delivered_at from fulfilments where id = $1",
      [sale.fulfilmentId],
    );
    expect(row.delivered_at).not.toBeNull();

    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    const delay = await eligibilityDelayDays(database.db);
    const payout = (await payoutViewsForArtist(database.db, artistId, delay))[0];

    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("awaiting_delivery");
    expect(payout?.eligibleAt).toBeNull();
  });

  it("restarts the window when a parcel is delivered a second time", async () => {
    // delivered -> returned -> delivered again. The later transition is the one
    // that counts, which can only ever push eligibility later.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 40 * 24 });
    await database.db.query(
      `insert into order_transitions
         (order_id, fulfilment_id, from_status, to_status, actor_id, actor_kind, occurred_at)
       values ($1, $2, 'shipped', 'delivered', $3, 'buyer', now() - interval '2 days')`,
      [sale.orderId, sale.fulfilmentId, buyerId],
    );

    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);
    const delay = await eligibilityDelayDays(database.db);
    const payout = (await payoutViewsForArtist(database.db, artistId, delay))[0];

    expect(payout?.status).toBe("pending");
    expect(payout?.blockedBy).toBe("within_return_window");
  });
});

describe("what the artist is shown", () => {
  const database = useTestDatabase();

  it("states the exact eligibility date, fourteen days after the delivery", async () => {
    // `artist-payouts`, *Artist sees the date*: "WHEN an artist views a
    // delivered fulfilment in their dashboard THEN the exact eligibility date is
    // displayed."
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);
    const sale = await seedSale(database.db, artistId, buyerId, { deliveredHoursAgo: 24 });
    await recordFulfilmentPaid(deps(database), sale.fulfilmentId);

    const view = await artistPayouts(deps(database), artistId);
    const payout = view.payouts[0];

    expect(payout?.deliveredAt).not.toBeNull();
    expect(payout?.eligibleAt).not.toBeNull();

    const delivered = new Date(payout?.deliveredAt ?? "").getTime();
    const eligible = new Date(payout?.eligibleAt ?? "").getTime();
    expect(eligible - delivered).toBe(14 * 24 * 60 * 60 * 1_000);
  });

  it("adds up pending, eligible and settled separately, with the entries behind them", async () => {
    // `artist-payouts`, *Artist views their balance*.
    const artistId = await seedArtist(database.db);
    const buyerId = await seedBuyer(database.db);

    const stillPending = await seedSale(database.db, artistId, buyerId, {
      itemsSubtotalAgorot: 200_000,
      deliveredHoursAgo: 24,
    });
    const nowEligible = await seedSale(database.db, artistId, buyerId, {
      itemsSubtotalAgorot: 100_000,
      deliveredHoursAgo: 20 * 24,
    });
    await recordFulfilmentPaid(deps(database), stillPending.fulfilmentId);
    await recordFulfilmentPaid(deps(database), nowEligible.fulfilmentId);

    const view = await artistPayouts(deps(database), artistId);

    expect(view.payouts).toHaveLength(2);
    expect(view.totals.pendingAgorot).toBe(170_000);
    expect(view.totals.eligibleAgorot).toBe(85_000);
    expect(view.totals.settledAgorot).toBe(0);
    // The balance straight from the table, which is the figure to trust.
    expect(view.totals.outstandingAgorot).toBe(255_000);
    // No bank details on file, so the dashboard says so -- and says nothing else.
    expect(view.payoutDetailsOnFile).toBe(false);
  });

  it("shows one artist nothing of another artist's ledger", async () => {
    // SECURITY.md S1-18: "on `payout_ledger` [a permissive policy] exposes every
    // artist's revenue." The module scopes by artist in the WHERE clause; the
    // RLS policy is the second layer, tested in payouts-privacy.test.ts.
    const artistA = await seedArtist(database.db, "אורית");
    const artistB = await seedArtist(database.db, "רון");
    const buyerId = await seedBuyer(database.db);

    const saleA = await seedSale(database.db, artistA, buyerId, { itemsSubtotalAgorot: 111_100 });
    const saleB = await seedSale(database.db, artistB, buyerId, { itemsSubtotalAgorot: 999_900 });
    await recordFulfilmentPaid(deps(database), saleA.fulfilmentId);
    await recordFulfilmentPaid(deps(database), saleB.fulfilmentId);

    const view = await artistPayouts(deps(database), artistA);

    expect(view.payouts).toHaveLength(1);
    expect(view.payouts[0]?.entry.grossAgorot).toBe(111_100);
    expect(JSON.stringify(view)).not.toContain("999900");
  });
});
