/**
 * Turning scores into an ordered, truncated, honest result list.
 *
 * Pure, and separate from `search.ts` on purpose: everything the spec is
 * strictest about — never padded, never below the minimum, reproducible within
 * an epoch, rotating between epochs, a clear winner never displaced — is a
 * property of this function alone, and can be tested without a database, a
 * clock, or a network.
 *
 * THE ORDER OF OPERATIONS IS LOAD-BEARING
 * ---------------------------------------
 * 1. Drop artworks priced beyond the over-budget tolerance. An exclusion, not a
 *    ranking penalty (art-matchmaker, "Far above budget").
 * 2. Drop artworks below the minimum score. "The system SHALL NOT return an
 *    artwork below the minimum match threshold" is absolute; it is applied
 *    BEFORE truncation, so a thin result set can never be topped up from below
 *    the line to reach the configured count.
 * 3. Sort by score descending, ties broken by the rotation key, so the input to
 *    banding is itself deterministic.
 * 4. Band: walk the sorted list, and extend the current band while the
 *    candidate is within `tieTolerance` OF THE BAND LEADER.
 * 5. Order each band by the rotation key.
 * 6. Truncate to the result count — the LAST step, so truncation can only ever
 *    remove, never promote something that failed step 2.
 *
 * WHY BANDS ARE ANCHORED ON THE LEADER AND NOT ON THE PREVIOUS ITEM
 * ----------------------------------------------------------------
 * Comparing each artwork to its predecessor makes ties transitive: with a
 * tolerance of 0.02, scores of 0.90, 0.89, 0.88, 0.87 … chain into a single
 * band spanning any distance at all, and "a clear winner is not displaced"
 * fails on a catalog with a smooth score distribution — which is what a real
 * catalog has. Anchoring on the band leader means a band is exactly "the set of
 * artworks that are, individually, within the tolerance of the best score in
 * it", so an artwork more than the tolerance below the leader starts a new band
 * and can never be rotated above it.
 */
import type { MatchmakerSettings } from "./config";
import type { RotationEpoch } from "./rotation";
import { rotationKey } from "./rotation";
import { round6, type ArtworkScore } from "./scoring";

export type RankingSettings = Pick<
  MatchmakerSettings,
  "minimumScore" | "tieTolerance" | "resultCount"
>;

/**
 * Rank the scored candidates.
 *
 * Takes the epoch rather than a clock, and scores rather than artworks: there
 * is no parameter here through which an impression count, a view count or any
 * other visitor-influenced value could reach the ordering (SECURITY.md S2-23).
 */
export function rank(
  scored: readonly ArtworkScore[],
  settings: RankingSettings,
  epoch: RotationEpoch,
): readonly ArtworkScore[] {
  const eligible = scored.filter(
    (candidate) => !candidate.excludedForBudget && candidate.score >= settings.minimumScore,
  );

  const keyed = new Map(eligible.map((c) => [c.artworkId, rotationKey(epoch, c.artworkId)] as const));
  const keyOf = (candidate: ArtworkScore): string => keyed.get(candidate.artworkId) ?? "";

  const sorted = [...eligible].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const a = keyOf(left);
    const b = keyOf(right);
    if (a !== b) return a < b ? -1 : 1;
    return left.artworkId < right.artworkId ? -1 : 1;
  });

  const ordered: ArtworkScore[] = [];
  let index = 0;
  while (index < sorted.length) {
    const leader = sorted[index];
    if (leader === undefined) break;

    const band: ArtworkScore[] = [leader];
    let next = index + 1;
    for (;;) {
      const candidate = sorted[next];
      if (candidate === undefined) break;
      // Rounded before the comparison, for the reason `round6` exists at all:
      // 0.9 - 0.88 is 0.020000000000000018 in IEEE-754, so an unrounded
      // comparison puts a pair that a human would call exactly-at-tolerance
      // OUTSIDE the band. Two artworks landing in the same band or not must not
      // depend on the binary representation of a decimal the operator typed.
      if (round6(leader.score - candidate.score) > settings.tieTolerance) break;
      band.push(candidate);
      next += 1;
    }

    band.sort((left, right) => {
      const a = keyOf(left);
      const b = keyOf(right);
      if (a !== b) return a < b ? -1 : 1;
      return left.artworkId < right.artworkId ? -1 : 1;
    });

    ordered.push(...band);
    index = next;
  }

  // Truncate last. art-matchmaker, "Results are never padded": "only two
  // artworks score above the minimum threshold and the configured result count
  // is five -> the system returns exactly two."
  return ordered.slice(0, settings.resultCount);
}
