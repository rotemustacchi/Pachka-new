/**
 * What the artworks module needs handed to it.
 *
 * The database is real everywhere, including in tests -- ARCHITECTURE.md's test
 * policy makes that non-negotiable and the harness gives every test its own
 * PostgreSQL. So `db` is not a seam, it is just a dependency.
 *
 * The other two ARE seams, and both exist for the same structural reason.
 * ARCHITECTURE.md's allowed-dependency table lets `artworks` call `accounts`
 * and nothing else; `orders` and `matchmaker` both point AT artworks. Yet two
 * things artworks is responsible for need facts those modules own:
 *
 *   - "an artwork reserved by an in-progress order cannot be unlisted"
 *     (artwork-listings) needs to know about reservations, which `orders` owns.
 *   - the artist dashboard shows match impressions (task 3.10), which
 *     `matchmaker` owns.
 *
 * Importing them would invert two edges in the dependency table. Reading their
 * tables from SQL here would do the same thing while hiding it from the import
 * graph. Stating them as ports keeps the arrows pointing the way the contract
 * says: `orders` and `matchmaker` depend on artworks, and hand it an
 * implementation as part of doing so. `accounts` does exactly this for review
 * eligibility (`OrderEligibility` in accounts/reviews).
 */
import type { Database, Sql } from "@/shared/db";
import type { InventoryDemandSource } from "./inventory";
import { noDemand } from "./inventory";

/**
 * Lifetime match impressions per artwork.
 *
 * art-matchmaker requires impressions to be recorded per artwork and surfaced
 * to artists and admins, and owns `match_impressions`. Zero is the honest
 * answer until that module exists: an artwork that has never been through a
 * questionnaire has been shown zero times.
 *
 * This one can safely default, where `InventoryDemandSource` cannot, because
 * being wrong about it under-reports a number on a dashboard. Being wrong about
 * demand sells a one-of-a-kind painting twice.
 */
export interface ImpressionSource {
  countsFor(sql: Sql, artworkIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export const noImpressions: ImpressionSource = {
  countsFor: async (_sql, artworkIds) => new Map(artworkIds.map((id) => [id, 0] as const)),
};

export interface ArtworksDeps {
  readonly db: Database;
  /** Supplied by `orders`. See the warning on `noDemand`. */
  readonly demand: InventoryDemandSource;
  /** Supplied by `matchmaker`. */
  readonly impressions: ImpressionSource;
}

/**
 * Deps for a deployment where `orders` and `matchmaker` are not wired in.
 *
 * Named to be conspicuous in a diff. It is correct today -- there are no
 * reservations and no impressions because there are no tables holding any --
 * and `assertDemandSourceIsWired` turns it into a loud failure rather than a
 * silent zero the moment `orders` ships.
 */
export function depsWithoutOrdersOrMatchmaker(db: Database): ArtworksDeps {
  return { db, demand: noDemand, impressions: noImpressions };
}
