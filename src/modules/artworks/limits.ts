/**
 * Configurable limits for a listing.
 *
 * ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
 * through `shared/config`... No magic numbers in module code."
 *
 * TODO(config): these six keys are not in `src/shared/config/registry.ts` yet.
 * The artworks module may not edit the registry -- it is shared, another team
 * owns it, and the registry test asserts every key has a matching seed row in
 * the app_config migration, so adding one here without the migration would fail
 * that test. The values below are the proposed defaults; they are stated ONCE,
 * here, so that swapping them for `getConfig()` calls is a change to this file
 * and nowhere else. Requested keys and defaults:
 *
 *   artworks.max_styles                 integer  3
 *   artworks.max_target_spaces          integer  3
 *   artworks.max_moods                  integer  2
 *   artworks.max_description_length     integer  4000
 *   artworks.max_images_per_artwork     integer  8
 *   artworks.max_edition_size           integer  250
 *
 * The first three exist because of SECURITY.md S2-20 item 2, "cap the shape":
 * claiming every style and every target space maximises taxonomy overlap in the
 * matchmaker's scoring function and ranks the artwork into every result set.
 * The cap defuses that regardless of whether the values came from an artist
 * gaming the form or from a vision model steered by text painted into the
 * image. It is a cap on how many an artist MAY pick, distinct from the
 * cardinality check constraints in the migration, which are absolute ceilings
 * equal to the size of each closed set.
 */

/** Most styles one artwork may claim. SECURITY.md S2-20 item 2. */
export const MAX_STYLES = 3;

/** Most target spaces one artwork may claim. SECURITY.md S2-20 item 2. */
export const MAX_TARGET_SPACES = 3;

/** Most moods one artwork may claim. SECURITY.md S2-20 item 2. */
export const MAX_MOODS = 2;

/** Longest stored description, matching the column's check constraint. */
export const MAX_DESCRIPTION_LENGTH = 4000;

/** Most images one artwork may carry. Position is 0-based, so the last is this minus one. */
export const MAX_IMAGES_PER_ARTWORK = 8;

/**
 * Largest edition an artist may declare.
 *
 * Not an aesthetic judgement: `stock` is the number of units a single row can
 * put on hold, and an unbounded edition is an unbounded reservation fan-out for
 * the orders module to sweep.
 */
export const MAX_EDITION_SIZE = 250;
