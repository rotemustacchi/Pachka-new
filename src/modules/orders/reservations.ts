/**
 * Reservation — the part of PACHKA that must not be wrong.
 *
 * A one-of-a-kind painting sold twice is unrecoverable. There is no second
 * copy, and two people have paid for one object. Every decision in this file is
 * downstream of that, and this project runs on Postgres rather than Firebase
 * for the sake of the twelve lines in `holdUnits` below.
 *
 * THE MECHANISM, AND WHAT IT IS NOT
 * --------------------------------
 * ARCHITECTURE.md: "Reservation is transactional. `SELECT ... FOR UPDATE` on
 * the artwork row inside a transaction. There is no application-level lock, no
 * optimistic retry loop, no advisory-lock substitute."
 *
 * The lock is `artworks.lockArtworkForUpdate`, taken from that module rather
 * than reimplemented here, so both modules lock the same row the same way —
 * "two callers locking two different things is how a lock that looks right
 * stops working." It demands a `Tx` rather than an `Sql`, which is the type
 * doing real work: a `for update` outside a transaction releases at the end of
 * the statement and buys nothing.
 *
 * And it is not supabase-js. SECURITY.md S0-4: PostgREST runs every request in
 * its own transaction, so a `FOR UPDATE` issued through it "holds the row lock
 * for the duration of the first HTTP request and then releases it. Two buyers
 * checking out simultaneously both read availability 1, both insert a
 * reservation, and the one-of-a-kind painting is sold twice." Every function
 * here takes a `Tx` from `shared/db`.
 *
 * ORDER OF OPERATIONS, FIXED
 * --------------------------
 * SECURITY.md S0-4 item 2: "lock the artwork row first, then derive
 * availability, then insert. Never the reverse." The compute-then-lock variant
 * — deriving `stock - reserved - sold` and then taking the lock — is called out
 * by name as a defect, because the lock then protects a decision already made.
 * `holdUnits` therefore takes the artwork it locks as an argument, so it is
 * impossible to call without having locked first.
 *
 * THE BACKSTOP
 * ------------
 * One reservation row is one unit, carrying the ordinal of the unit it claims,
 * and a unique index over `(artwork_id, unit_index) where released_at is null`
 * makes a double sale a constraint violation rather than an outcome. See the
 * migration, O2, for why that index rather than the one SECURITY.md S0-4 item 3
 * spells out — which PostgreSQL will not create, because `now()` is not
 * IMMUTABLE and an index predicate must be.
 */
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import {
  assertDemandSourceIsWired,
  availableUnits,
  reconcileAvailability,
  type Artwork,
} from "@/modules/artworks";
import { artworksDepsFor, maxActiveReservationsFor, type OrdersDeps } from "./deps";
import { sqlInventoryDemand } from "./demand";
import { reservationTtlMinutes } from "./config";
import {
  RESERVATION_COLUMNS,
  toReservation,
  type ReleaseReason,
  type Reservation,
  type ReservationRow,
} from "./types";

/**
 * Release every hold on this artwork that has run out of time.
 *
 * Called inside the reservation transaction, under the artwork row lock, before
 * availability is derived. Two reasons it belongs there rather than only in the
 * background sweep:
 *
 *   • The unit ordinals an expired hold occupied have to come free before a new
 *     hold can claim them, or the unique index would refuse a reservation the
 *     derived availability said was fine.
 *   • It makes the sweep a tidying job rather than the authority. If a buyer
 *     could only reach an expired unit after the sweep had run, a stalled sweep
 *     would hold the catalog hostage — SECURITY.md S1-17's attack, arrived at by
 *     accident.
 *
 * A confirmed reservation is never touched: `confirmed_at is null` is in the
 * predicate, and a sale that happened does not lapse because time passed.
 */
export async function releaseExpiredHolds(tx: Tx, artworkId: string): Promise<number> {
  const { rowCount } = await tx.query(
    `update reservations
        set released_at = now(), release_reason = 'expired'
      where artwork_id = $1
        and released_at is null
        and confirmed_at is null
        and expires_at <= now()`,
    [artworkId],
  );
  return rowCount;
}

/** The unit ordinals currently spoken for — held or sold — for one artwork. */
async function occupiedUnits(tx: Tx, artworkId: string): Promise<Set<number>> {
  const { rows } = await tx.query<{ unit_index: number }>(
    "select unit_index from reservations where artwork_id = $1 and released_at is null",
    [artworkId],
  );
  return new Set(rows.map((row) => row.unit_index));
}

/**
 * The lowest `count` free ordinals in `[0, stock)`.
 *
 * Lowest-first rather than "next after the highest" so that an edition whose
 * middle units were cancelled reuses them instead of running the ordinal off
 * the end of the edition and out of the range the unique index constrains.
 */
function freeUnitIndices(stock: number, occupied: ReadonlySet<number>, count: number): number[] {
  const free: number[] = [];
  for (let index = 0; index < stock && free.length < count; index += 1) {
    if (!occupied.has(index)) free.push(index);
  }
  return free;
}

export interface HoldRequest {
  /** The artwork, ALREADY LOCKED by the caller. See the header. */
  readonly artwork: Artwork;
  readonly buyerId: string;
  readonly orderId: string | null;
  readonly quantity: number;
  readonly expiresAt: Date;
}

/**
 * Take the units, or refuse.
 *
 * The caller must already hold `artwork`'s row lock in `tx`. Everything below
 * happens under it: the derivation, the ordinal allocation, and the insert. The
 * whole point is that no other transaction can interleave between the read and
 * the write, and that is a property of the caller's lock, not of anything here.
 */
export async function holdUnits(tx: Tx, request: HoldRequest): Promise<Reservation[]> {
  const { artwork, buyerId, orderId, quantity, expiresAt } = request;

  // An artwork that is not published cannot be bought, whatever its stock says.
  // `sold`, `unlisted`, `draft` and `removed` all land here — and `removed` is
  // terminal for every role (ARCHITECTURE.md), so it is not-found rather than a
  // conflict the buyer could wait out.
  if (artwork.status === "removed" || artwork.status === "draft") {
    throw AppError.notFound("Artwork not found", {
      code: "orders.artwork_not_found",
      details: { artworkId: artwork.id },
    });
  }
  if (artwork.status !== "published") {
    throw AppError.conflict("This piece is no longer available.", {
      code: "orders.artwork_unavailable",
      details: { artworkId: artwork.id, status: artwork.status },
    });
  }

  // Expired holds first, so their ordinals are free and the derivation below
  // counts what is genuinely outstanding.
  await releaseExpiredHolds(tx, artwork.id);

  // DERIVED, under the lock, on this transaction's connection. Passing `tx`
  // rather than a pool handle is load-bearing: a demand figure read on a second
  // connection is a figure from before the lock, "which is exactly the read
  // that lets two checkouts both see one unit free" (artworks/inventory.ts).
  const demand = await sqlInventoryDemand.demandFor(tx, artwork.id);
  const available = availableUnits(artwork.stock, demand);

  if (available < quantity) {
    throw AppError.conflict(
      available === 0
        ? "This piece is no longer available."
        : `Only ${available} of these remain.`,
      {
        code: "orders.artwork_unavailable",
        details: {
          artworkId: artwork.id,
          requested: quantity,
          available,
          stock: artwork.stock,
        },
      },
    );
  }

  const indices = freeUnitIndices(artwork.stock, await occupiedUnits(tx, artwork.id), quantity);
  if (indices.length < quantity) {
    // Unreachable unless the derivation above and the ordinal ledger disagree,
    // which would itself be the bug this module exists to prevent. Loud rather
    // than silent: a wrong answer here is a double sale.
    throw AppError.conflict("This piece is no longer available.", {
      code: "orders.artwork_unavailable",
      details: { artworkId: artwork.id, requested: quantity, allocatable: indices.length },
    });
  }

  const created: Reservation[] = [];
  for (const unitIndex of indices) {
    const row = await tx.one<ReservationRow>(
      `insert into reservations (artwork_id, buyer_id, order_id, unit_index, expires_at)
       values ($1, $2, $3, $4, $5)
       returning ${RESERVATION_COLUMNS}`,
      [artwork.id, buyerId, orderId, unitIndex, expiresAt],
    );
    created.push(toReservation(row));
  }
  return created;
}

/** When a hold taken now would lapse. */
export async function reservationExpiryFrom(db: Sql, now: Date = new Date()): Promise<Date> {
  const minutes = await reservationTtlMinutes(db);
  return new Date(now.getTime() + minutes * 60_000);
}

/** Units this buyer is holding right now, excluding sales and released rows. */
export async function activeReservationCount(db: Sql, buyerId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    `select count(*)::text as count
       from reservations
      where buyer_id = $1
        and released_at is null
        and confirmed_at is null
        and expires_at > now()`,
    [buyerId],
  );
  return Number(row.count);
}

/**
 * Refuse a buyer who is already holding as much as they are allowed to.
 *
 * SECURITY.md S1-17, the inventory-hostage attack: without a cap, one scripted
 * account holds every unique artwork in the catalog for the TTL and re-runs on a
 * timer, "the catalog shows every piece as unavailable indefinitely; artists see
 * zero sales and leave."
 *
 * `rate_limited` rather than `conflict`, and the distinction is the one
 * `shared/errors` draws for exactly this: "nothing about the request is wrong
 * and the same request will succeed once the window resets, which is what 429
 * tells a client and 409 does not." A legitimate buyer at the cap completes or
 * abandons a checkout and comes back.
 */
export async function assertReservationCapacity(
  deps: OrdersDeps,
  db: Sql,
  buyerId: string,
  wanted: number,
): Promise<void> {
  const cap = maxActiveReservationsFor(deps);
  const held = await activeReservationCount(db, buyerId);

  if (held + wanted > cap) {
    throw AppError.rateLimited(
      `You can hold up to ${cap} pieces at a time while you complete a purchase. ` +
        `Finish or cancel a checkout in progress and try again.`,
      {
        code: "orders.reservation_cap_reached",
        details: { cap, held, requested: wanted },
      },
    );
  }
}

/**
 * Turn an order's holds into sales.
 *
 * `checkout-orders`: "WHEN payment for a reserved artwork succeeds THEN the
 * reservation converts to a sale and inventory is decremented."
 *
 * FAILING CLOSED ON THE SWEEP RACE. SECURITY.md S0-4 names it: "The background
 * sweep releases an expired reservation at the moment its owner's payment
 * confirmation is in flight. Both the sweep and the confirmation must take the
 * same artwork-row lock, and confirmation must re-check expiry *under* that lock
 * and fail closed."
 *
 * So this re-reads every row `for update` after the caller has taken the artwork
 * locks, and refuses if any of them lapsed or was released while the
 * confirmation was on its way. Refusing is the safe half of the race: the
 * operator retries, or refunds. Confirming a hold that the sweep already gave
 * away is the unsafe half, and it is the double sale.
 */
export async function confirmReservationsForOrder(tx: Tx, orderId: string): Promise<Reservation[]> {
  // `for update` on the reservation rows as well as the artwork rows: the
  // artwork lock serialises checkouts against each other, and this serialises
  // this confirmation against a sweep that reached the same rows first.
  const { rows: current } = await tx.query<ReservationRow>(
    `select ${RESERVATION_COLUMNS} from reservations where order_id = $1 for update`,
    [orderId],
  );

  if (current.length === 0) {
    throw AppError.conflict("This order is no longer holding any inventory.", {
      code: "orders.no_reservations",
      details: { orderId },
    });
  }

  const now = Date.now();
  const lapsed = current.filter(
    (row) =>
      row.released_at !== null ||
      (row.confirmed_at === null && new Date(row.expires_at).getTime() <= now),
  );

  if (lapsed.length > 0) {
    throw AppError.conflict(
      "The hold on one or more pieces in this order expired before payment was confirmed.",
      {
        code: "orders.reservation_lapsed",
        details: {
          orderId,
          artworkIds: [...new Set(lapsed.map((row) => row.artwork_id))],
        },
      },
    );
  }

  const { rows } = await tx.query<ReservationRow>(
    `update reservations
        set confirmed_at = now()
      where order_id = $1 and released_at is null and confirmed_at is null
      returning ${RESERVATION_COLUMNS}`,
    [orderId],
  );

  // Already-confirmed rows are returned unchanged rather than treated as an
  // error, so a retried confirmation is idempotent.
  const updated = new Map(rows.map((row) => [row.id, row] as const));
  return current.map((row) => toReservation(updated.get(row.id) ?? row));
}

/**
 * Give an order's units back.
 *
 * `checkout-orders`: "WHEN an order in `awaiting_payment` or `paid` is cancelled
 * THEN the reserved inventory is released and the artwork becomes purchasable
 * again." Also the return path, where `shipping` hands back `restoreInventory`
 * and this module acts on it.
 *
 * Releases confirmed rows too — a cancelled paid order gives the unit back, and
 * that is the whole point of the cancellation branch. The caller must hold the
 * artwork row locks, because releasing changes derived availability and the
 * `reconcileAvailability` that follows has to see a consistent picture.
 */
export async function releaseReservationsForOrder(
  tx: Tx,
  orderId: string,
  reason: ReleaseReason,
): Promise<Reservation[]> {
  const { rows } = await tx.query<ReservationRow>(
    `update reservations
        set released_at = now(), release_reason = $2
      where order_id = $1 and released_at is null
      returning ${RESERVATION_COLUMNS}`,
    [orderId, reason],
  );
  return rows.map(toReservation);
}

/** Every artwork an order holds or sold units of, sorted — see `checkout.ts` on lock order. */
export async function artworkIdsForOrder(sql: Sql, orderId: string): Promise<string[]> {
  const { rows } = await sql.query<{ artwork_id: string }>(
    "select distinct artwork_id from reservations where order_id = $1 order by artwork_id",
    [orderId],
  );
  return rows.map((row) => row.artwork_id);
}

export interface SweepResult {
  /** Reservations released by this run. */
  readonly released: readonly Reservation[];
  /** Artworks whose derived availability was recomputed as a result. */
  readonly artworkIds: readonly string[];
}

/**
 * The background sweep. `checkout-orders`, "Reservation expires".
 *
 * Three things make this correct rather than merely functional:
 *
 * 1. **It takes the artwork row lock** (SECURITY.md S0-4 item 4), by locking the
 *    artwork before touching any of its reservations. Without that, the sweep
 *    and a checkout race on the same rows.
 *
 * 2. **It never releases a hold whose money is moving.** S0-4 item 4 again:
 *    "never releases a reservation whose payment is in a non-terminal state."
 *    Read literally against the manual adapter that would mean never releasing
 *    anything, because `pending` is where every unpaid order sits and the TTL is
 *    exactly what bounds it. The defensible reading — and the one implemented —
 *    is that a payment which has reached `authorized` or `captured` has money
 *    committed against it, and the sweep must not pull the inventory out from
 *    under it. `pending` and `failed` are fair game once the clock runs out.
 *    Reported to the lead architect as an ambiguity resolved rather than
 *    assumed.
 *
 * 3. **It reconciles availability afterwards**, so an artwork that went to
 *    `sold` when the last unit was held comes back to `published` when the hold
 *    lapses — which is the observable half of the spec scenario.
 *
 * One transaction per artwork rather than one for the whole sweep: a sweep that
 * held every artwork's lock at once would block every checkout in the
 * marketplace for its duration, and a failure on one artwork would roll back the
 * releases for all the others.
 */
export async function sweepExpiredReservations(deps: OrdersDeps): Promise<SweepResult> {
  const { rows: candidates } = await deps.db.query<{ artwork_id: string }>(
    `select distinct r.artwork_id
       from reservations r
       left join payments p on p.order_id = r.order_id
      where r.released_at is null
        and r.confirmed_at is null
        and r.expires_at <= now()
        and (p.status is null or p.status not in ('authorized', 'captured'))
      order by r.artwork_id`,
  );

  const released: Reservation[] = [];
  const touched: string[] = [];

  for (const { artwork_id: artworkId } of candidates) {
    const releasedHere = await deps.db.withTransaction(async (tx) => {
      // The lock first, always. Re-selecting the rows under it is what makes
      // the read above a candidate list rather than a decision.
      await tx.query("select id from artworks where id = $1 for update", [artworkId]);

      // No `for update` on the reservation rows here, deliberately. The artwork
      // row lock taken immediately above already serialises this against every
      // checkout and every confirmation for this artwork — all three take that
      // lock first, which is the point of taking it from `artworks` rather than
      // inventing a lock per call site.
      const { rows } = await tx.query<ReservationRow>(
        `update reservations
            set released_at = now(), release_reason = 'expired'
          where artwork_id = $1
            and released_at is null
            and confirmed_at is null
            and expires_at <= now()
            and not exists (
              select 1 from payments p
               where p.order_id = reservations.order_id
                 and p.status in ('authorized', 'captured')
            )
         returning ${RESERVATION_COLUMNS}`,
        [artworkId],
      );

      if (rows.length > 0) {
        // Inside the same transaction and on the same handle, so the artwork's
        // status and the released units are decided together.
        await reconcileAvailability(artworksDepsFor(deps, deps.db), artworkId, tx);
      }
      return rows.map(toReservation);
    });

    if (releasedHere.length > 0) {
      released.push(...releasedHere);
      touched.push(artworkId);
    }
  }

  return { released, artworkIds: touched };
}

/**
 * The fail-closed check, called on every checkout.
 *
 * `artworks` ships with `noDemand`, which reports zero reservations for
 * everything. That is true only while no orders module exists; the moment one
 * does, leaving it installed means "every artwork reads as fully available
 * regardless of what is reserved or sold", and the failure mode of assuming
 * nothing is reserved is selling a piece twice. `artworks` provides the
 * assertion and asks the orders team to call it from the reservation path
 * (ARCHITECTURE.md: "An unwired demand source therefore raises on the first
 * checkout rather than returning zero"). This is that call site.
 */
export async function assertDemandWired(deps: OrdersDeps, sql: Sql): Promise<void> {
  await assertDemandSourceIsWired(sql, artworksDepsFor(deps).demand);
}
