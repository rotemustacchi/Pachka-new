/**
 * Configurable limits for a listing, read from `app_config`.
 *
 * ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
 * through `shared/config`... No magic numbers in module code."
 *
 * These six were literals here until the keys existed, stated once so that the
 * swap would be a change to this file and nowhere else. That is what happened:
 * the call sites ask for `limits.maxStyles`, not for a key name, so no other
 * file in the module knows what any of these is called.
 *
 * The first three exist because of SECURITY.md S2-20 item 2, "cap the shape":
 * claiming every style and every target space maximises taxonomy overlap in the
 * matchmaker's scoring function and ranks the artwork into every result set.
 * The cap defuses that regardless of whether the values came from an artist
 * gaming the form or from a vision model steered by text painted into the
 * image. It is a cap on how many an artist MAY pick, distinct from the
 * cardinality check constraints in the migration, which are absolute ceilings
 * equal to the size of each closed set.
 *
 * Read once per operation and passed down, rather than fetched at each use.
 * `getConfig` caches, so the difference is not the query count -- it is that
 * one validation pass then applies one consistent set of limits, instead of a
 * long-running request being able to straddle an operator's edit and cap styles
 * by the old value and moods by the new one.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";

export interface ListingLimits {
  /** Most styles one artwork may claim. SECURITY.md S2-20 item 2. */
  readonly maxStyles: number;
  /** Most target spaces one artwork may claim. SECURITY.md S2-20 item 2. */
  readonly maxTargetSpaces: number;
  /** Most moods one artwork may claim. SECURITY.md S2-20 item 2. */
  readonly maxMoods: number;
  /** Longest stored description, matching the column's check constraint. */
  readonly maxDescriptionLength: number;
  /** Most images one artwork may carry. Position is 0-based, so the last is this minus one. */
  readonly maxImagesPerArtwork: number;
  /**
   * Largest edition an artist may declare.
   *
   * Not an aesthetic judgement: `stock` is the number of units a single row can
   * put on hold, and an unbounded edition is an unbounded reservation fan-out
   * for the orders module to sweep.
   */
  readonly maxEditionSize: number;
}

export async function listingLimits(db: Sql): Promise<ListingLimits> {
  const [
    maxStyles,
    maxTargetSpaces,
    maxMoods,
    maxDescriptionLength,
    maxImagesPerArtwork,
    maxEditionSize,
  ] = await Promise.all([
    getConfig(db, "artworks.max_styles"),
    getConfig(db, "artworks.max_target_spaces"),
    getConfig(db, "artworks.max_moods"),
    getConfig(db, "artworks.max_description_length"),
    getConfig(db, "artworks.max_images_per_artwork"),
    getConfig(db, "artworks.max_edition_size"),
  ]);

  return {
    maxStyles,
    maxTargetSpaces,
    maxMoods,
    maxDescriptionLength,
    maxImagesPerArtwork,
    maxEditionSize,
  };
}
