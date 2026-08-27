/**
 * Availability, derived.
 *
 * ARCHITECTURE.md, non-negotiable: "Availability is derived, never stored.
 * `stock - active_reservations - sold`. Any counter column for availability is
 * a defect." There is therefore no availability column in the migration, and
 * `availableUnits` below is a pure function of three numbers.
 *
 * WHERE THE OTHER TWO NUMBERS COME FROM
 * -------------------------------------
 * `stock` is ours: the edition size the artist declared. `reservedUnits` and
 * `soldUnits` are facts about orders, and `orders` owns `reservations`,
 * `order_items` and everything that decides what "in progress" means.
 *
 * ARCHITECTURE.md's dependency table has the edge pointing the other way --
 * `orders` may call `artworks`; `artworks` may call only `accounts` -- so this
 * module cannot import `orders`, and it does not. It states a PORT instead:
 * `InventoryDemandSource`, an interface `orders` will implement and inject.
 * The dependency still runs orders -> artworks; the data flows back the other
 * way without an import, which is the whole point of stating it as an interface
 * rather than reaching across.
 *
 * Reading the orders tables directly from SQL here -- the way the accounts
 * migration resolves `public.artworks` at call time -- was the alternative, and
 * was rejected. That pattern is right for accounts because it FAILS CLOSED: with
 * no artworks table, no artist is publicly visible, which is what the spec wants
 * anyway. The same pattern here fails OPEN: with no orders tables, every artwork
 * looks fully available, and the failure mode of "assume nothing is reserved" is
 * selling a piece twice.
 *
 * So `noDemand` below is not a fallback that guesses. It is only correct while
 * no orders module exists at all, and `assertDemandSourceIsWired` gives the
 * orders team a hard failure to hang their integration on rather than a silent
 * zero.
 *
 * THE LOCK
 * --------
 * SECURITY.md S0-4 fixes the order of operations for reservation: lock the
 * artwork row FIRST (`select ... from artworks where id = $1 for update`), then
 * derive availability, then insert. `lockArtworkForUpdate` below is that lock,
 * exported so `orders` takes exactly the lock this module's invariants assume,
 * on the same row, in the same order -- rather than reimplementing it slightly
 * differently and discovering the difference in production.
 */
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import { ARTWORK_COLUMNS, toArtwork, type Artwork, type ArtworkRow } from "./types";

/** Units of an artwork spoken for by orders, at one instant. */
export interface InventoryDemand {
  /**
   * Units held by reservations that are neither released nor expired -- an
   * in-progress checkout. This is what makes an artwork un-unlistable
   * (artwork-listings: "Artwork with a pending order cannot be unlisted").
   */
  readonly reservedUnits: number;
  /** Units transferred by confirmed orders. Never comes back down for a sale that stood. */
  readonly soldUnits: number;
}

/**
 * The port `orders` implements.
 *
 * Takes an `Sql` so the caller decides whether the read happens on the pool or
 * inside the transaction that already holds the artwork row lock. During a
 * reservation it MUST be the transaction: a demand figure read on a second
 * connection is a figure from before the lock, which is exactly the read that
 * lets two checkouts both see one unit free.
 */
export interface InventoryDemandSource {
  demandFor(sql: Sql, artworkId: string): Promise<InventoryDemand>;
  /** Batched form, so an artist dashboard of forty listings is one query. */
  demandForMany(sql: Sql, artworkIds: readonly string[]): Promise<ReadonlyMap<string, InventoryDemand>>;
}

export const ZERO_DEMAND: InventoryDemand = { reservedUnits: 0, soldUnits: 0 };

/**
 * The demand source used while the `orders` module does not exist.
 *
 * Reports zero demand, which is true today: there are no reservations and no
 * orders because there is no table to hold them. It becomes a lie the moment
 * orders ships without wiring its own implementation in, so it identifies
 * itself -- see `assertDemandSourceIsWired`.
 */
export const noDemand: InventoryDemandSource = {
  demandFor: async () => ZERO_DEMAND,
  demandForMany: async (_sql, artworkIds) =>
    new Map(artworkIds.map((id) => [id, ZERO_DEMAND] as const)),
};

/**
 * Fail loudly if the zero-demand placeholder is still installed once orders
 * exists.
 *
 * Call this from the reservation path. It is cheap, and it converts the one
 * dangerous silent failure in this design -- orders ships, forgets to inject,
 * and every artwork reads as fully available forever -- into an error on the
 * first checkout rather than a double sale on the first popular piece.
 */
export async function assertDemandSourceIsWired(sql: Sql, source: InventoryDemandSource): Promise<void> {
  if (source !== noDemand) return;

  const { rows } = await sql.query<{ present: boolean }>(
    "select to_regclass('public.reservations') is not null as present",
  );

  if (rows[0]?.present === true) {
    throw AppError.conflict(
      "The artworks module is still using the zero-demand placeholder, but `reservations` exists. " +
        "The orders module must inject a real InventoryDemandSource: every artwork currently reads " +
        "as fully available regardless of what is reserved or sold.",
      { code: "artworks.demand_source_not_wired" },
    );
  }
}

/**
 * `stock - active_reservations - sold`, and nothing else.
 *
 * Clamped at zero rather than allowed to go negative. A negative figure would
 * mean more units were sold than declared, which is a bug worth finding, but
 * returning it here would let it render as "-1 remaining" on a public page and
 * would break every `available > 0` test into a subtly different question. The
 * clamp is the safe read; `oversoldBy` is how the bug is found.
 */
export function availableUnits(stock: number, demand: InventoryDemand): number {
  return Math.max(0, stock - demand.reservedUnits - demand.soldUnits);
}

/** How far past its declared stock an artwork has been committed. Should always be zero. */
export function oversoldBy(stock: number, demand: InventoryDemand): number {
  return Math.max(0, demand.reservedUnits + demand.soldUnits - stock);
}

/** Availability as the catalog and the detail page need to speak about it. */
export interface Availability {
  readonly stock: number;
  readonly reservedUnits: number;
  readonly soldUnits: number;
  /** Derived: `stock - reservedUnits - soldUnits`, clamped at zero. */
  readonly availableUnits: number;
  /** Whether a buyer can add this to a cart right now. */
  readonly purchasable: boolean;
  /** Every unit is spoken for. A unique piece here is sold; an edition is sold out. */
  readonly soldOut: boolean;
}

/**
 * Combine an artwork's declared stock with current demand.
 *
 * Purchasability is availability AND lifecycle state together. An unlisted
 * artwork with stock free is not purchasable, and neither is a removed one --
 * catalog-browse requires removed artworks to return not-found and sold and
 * unlisted ones to render read-only with no purchase action.
 */
export function availabilityFor(artwork: Artwork, demand: InventoryDemand): Availability {
  const available = availableUnits(artwork.stock, demand);
  return {
    stock: artwork.stock,
    reservedUnits: demand.reservedUnits,
    soldUnits: demand.soldUnits,
    availableUnits: available,
    purchasable: artwork.status === "published" && available > 0,
    soldOut: available === 0,
  };
}

/**
 * Take the row lock, then read the artwork under it.
 *
 * SECURITY.md S0-4: "Inside the transaction, order of operations is fixed: lock
 * the artwork row first, then derive". Exported so `orders` and this module's
 * own `reconcileAvailability` take the same lock the same way; two callers
 * locking two different things is how a lock that looks right stops working.
 *
 * Requires a `Tx`, not an `Sql`, and that is the type doing real work: a
 * `for update` issued outside a transaction locks for the duration of one
 * statement and releases immediately, which buys nothing at all. Demanding a
 * transaction handle makes that mistake impossible to write.
 */
export async function lockArtworkForUpdate(tx: Tx, artworkId: string): Promise<Artwork | null> {
  const row = await tx.maybeOne<ArtworkRow>(
    `select ${ARTWORK_COLUMNS} from artworks where id = $1 for update`,
    [artworkId],
  );
  return row === null ? null : toArtwork(row);
}
