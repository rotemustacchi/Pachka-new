/**
 * Wiring for the artist's own surfaces.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. Building
 * the dependencies a module is handed is part of "call a module API".
 *
 * This file used to call `depsWithoutOrdersOrMatchmaker`, whose conspicuous
 * name existed for exactly this moment: it installs the zero-reporting demand
 * source and the zero-reporting impression source, which were correct only
 * while `orders` and `matchmaker` did not exist. Both have shipped, so the swap
 * its own header promised — "this function is the one place that changes" — has
 * been made, in `_lib/deps.ts`, once, for every surface.
 *
 * The consequence for this dashboard is that reserved units and match
 * impressions are now real numbers rather than zeros. The consequence
 * everywhere else is larger: `noDemand` reports zero reservations for
 * everything, and with a `reservations` table present that is the failure
 * `assertDemandSourceIsWired` exists to make loud — an artwork that reads as
 * fully available regardless of what is held against it.
 */
export { artworksDeps } from "@/app/_lib/deps";
