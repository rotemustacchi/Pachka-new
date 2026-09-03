/**
 * Wiring for the artist's own surfaces.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. Building
 * the dependencies a module is handed is part of "call a module API".
 *
 * `depsWithoutOrdersOrMatchmaker` is the conspicuous name on purpose: it
 * installs the zero-reporting demand source and the zero-reporting impression
 * source, which are correct only while `orders` and `matchmaker` do not exist.
 * The dashboard therefore shows zero reserved units and zero impressions today.
 * When those modules ship, this function is the one place that changes -- and
 * `assertDemandSourceIsWired` turns a forgotten swap into a loud failure on the
 * reservation path rather than a silently over-available artwork.
 */
import { getDatabase } from "@/shared/db";
import { depsWithoutOrdersOrMatchmaker, type ArtworksDeps } from "@/modules/artworks";

export function artworksDeps(): ArtworksDeps {
  return depsWithoutOrdersOrMatchmaker(getDatabase());
}
