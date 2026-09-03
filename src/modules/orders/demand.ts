/**
 * The `InventoryDemandSource` that `artworks` has been waiting for.
 *
 * ARCHITECTURE.md: "Downstream facts arrive as injected ports, never as
 * cross-module reads... `artworks` declares `InventoryDemandSource` and
 * `ImpressionSource`, and those modules inject implementations." This file is
 * the orders half of that arrangement. The dependency still runs
 * `orders -> artworks`; the data flows back the other way without an import.
 *
 * WHY THIS IS THE ONLY PLACE THAT COUNTS
 * --------------------------------------
 * "Availability is derived, never stored. `stock - active_reservations - sold`."
 * `stock` is the artist's declared edition size and belongs to `artworks`. The
 * other two terms are both counted here, from one table, in one query. A second
 * query somewhere else that counted them slightly differently -- including an
 * expired hold, excluding a confirmed one -- would be a second answer to the
 * question the whole module exists to answer correctly.
 *
 * The three states a reservation row can be in are defined in the migration,
 * section 6. Restated as the predicate this file uses, because getting it wrong
 * in either direction is a live defect:
 *
 *   reserved  released_at is null AND confirmed_at is null AND expires_at > now()
 *   sold      released_at is null AND confirmed_at is not null
 *   neither   released_at is not null, or expired and not yet swept
 *
 * An expired-but-unswept hold counts as NOTHING, deliberately. The sweep is a
 * tidying job, not the authority: if availability depended on the sweep having
 * run, a stalled sweep would hold the whole catalog hostage, which is
 * SECURITY.md S1-17's attack arriving by accident instead of on purpose.
 *
 * A confirmed row never expires. `expires_at` is in the past for every sale
 * older than the TTL, and a `sold` predicate that also tested expiry would
 * quietly put every past sale back on the market.
 */
import type { Sql } from "@/shared/db";
import type { InventoryDemand, InventoryDemandSource } from "@/modules/artworks";
import { ZERO_DEMAND } from "@/modules/artworks";

interface DemandRow {
  readonly artwork_id: string;
  readonly reserved_units: string;
  readonly sold_units: string;
}

/**
 * `count(*)` comes back as a `bigint`, and node-postgres hands those over as
 * strings (see shared/db/client.ts). These are unit counts rather than money,
 * so `Number()` is right here where it would be wrong for an amount -- an
 * edition of more than 2^53 units is not a case worth carrying code for.
 */
function toDemand(row: DemandRow): InventoryDemand {
  return {
    reservedUnits: Number(row.reserved_units),
    soldUnits: Number(row.sold_units),
  };
}

const COUNTS = `
  count(*) filter (where confirmed_at is null and expires_at > now())::text as reserved_units,
  count(*) filter (where confirmed_at is not null)::text                    as sold_units
`;

/**
 * The real demand source. Inject this and nothing else.
 *
 * Takes an `Sql`, so the caller decides whether the read happens on the pool or
 * inside the transaction holding the artwork row lock. `artworks` is explicit
 * that during a reservation it MUST be the transaction: "a demand figure read
 * on a second connection is a figure from before the lock, which is exactly the
 * read that lets two checkouts both see one unit free." `checkout.ts` passes
 * the transaction.
 */
export const sqlInventoryDemand: InventoryDemandSource = {
  async demandFor(sql: Sql, artworkId: string): Promise<InventoryDemand> {
    const row = await sql.one<DemandRow>(
      `select $1::uuid as artwork_id, ${COUNTS}
         from reservations
        where artwork_id = $1 and released_at is null`,
      [artworkId],
    );
    return toDemand(row);
  },

  /**
   * Batched, so an artist dashboard of forty listings is one query rather than
   * forty. Artworks with no reservation row at all are absent from the result
   * set and are filled in as zero here -- the caller asked about them, so the
   * caller gets an answer for each.
   */
  async demandForMany(
    sql: Sql,
    artworkIds: readonly string[],
  ): Promise<ReadonlyMap<string, InventoryDemand>> {
    const result = new Map<string, InventoryDemand>(
      artworkIds.map((id) => [id, ZERO_DEMAND] as const),
    );
    if (artworkIds.length === 0) return result;

    const { rows } = await sql.query<DemandRow>(
      `select artwork_id, ${COUNTS}
         from reservations
        where artwork_id = any($1::uuid[]) and released_at is null
        group by artwork_id`,
      [[...artworkIds]],
    );

    for (const row of rows) result.set(row.artwork_id, toDemand(row));
    return result;
  },
};
