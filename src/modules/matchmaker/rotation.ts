/**
 * Exposure rotation: how two near-equal artworks take turns, and why the thing
 * they take turns by is not a number anyone can move.
 *
 * art-matchmaker, "Exposure rotation": "Where two or more artworks score within
 * the configured tie tolerance of one another, the system SHALL order them by a
 * deterministic function of the current rotation epoch and the artwork
 * identifier... The system SHALL NOT use match impression counts, view counts,
 * or any other visitor-influenced value as a ranking input, because an
 * anonymous visitor could otherwise move a rival's position by scripting
 * queries."
 *
 * THIS REPLACED AN EARLIER DESIGN, AND THE DIFFERENCE IS THE WHOLE POINT
 * ---------------------------------------------------------------------
 * `tasks.md` 6.10 still says "ordered by ascending lifetime impressions", and
 * `app_config`'s description of `matchmaker.tie_tolerance` still says "rotated
 * by lifetime impressions". Both predate the security review. SECURITY.md S2-23
 * is the review: an impression count is incremented by anonymous strangers, so
 * ranking on it hands an attacker a slider labelled "demote my competitor" --
 * script queries that return a rival's work, their count rises, and inside the
 * tie band they are permanently last while the attacker's own work, never
 * returned, is permanently first. ARCHITECTURE.md: where a task description and
 * the spec disagree, the spec wins and the conflict is reported. It has been.
 *
 * What replaces it has to do two things that pull against each other:
 * ranking must be REPRODUCIBLE ("the same answers... within the same rotation
 * epoch... returns the same artworks in the same order") and it must ROTATE
 * ("their relative order changes, so no single artwork holds the top tie
 * position permanently"). A function of (epoch, artwork id) and nothing else
 * does both exactly: constant while the epoch is, and a fresh permutation when
 * it advances. No state, no counter, nothing a visitor touches.
 *
 * WHY A HASH RATHER THAN, SAY, (epoch + index) MOD n
 * --------------------------------------------------
 * A rotation that shifts every band by the same offset each epoch is a rota:
 * an artist can compute exactly which epoch puts them first and time a
 * promotion to it. A keyed hash of the pair gives an order that is stable,
 * checkable, and reproducible by anyone -- while being uncorrelated between
 * epochs, so knowing this epoch's order tells you nothing about the next one's.
 */
import { createHash } from "node:crypto";

/**
 * Where we are in the rotation schedule.
 *
 * `startedAt` is not decoration. Every time-dependent term in the score is
 * computed against the START of the epoch rather than against `now()`, which is
 * what makes "the same answers submitted twice within the same epoch return the
 * same order" true of the freshness component too. Score against `now()` and
 * reproducibility holds only for as long as two submissions round to the same
 * millisecond.
 */
export interface RotationEpoch {
  /** Epoch index. Advances on a fixed schedule; the unit is the configured period. */
  readonly index: number;
  /** The instant this epoch began. The clock every score is computed against. */
  readonly startedAt: Date;
  readonly periodHours: number;
}

/** The epoch containing `at`, for a configured period. */
export function rotationEpochAt(at: Date, periodHours: number): RotationEpoch {
  if (!Number.isFinite(periodHours) || periodHours <= 0) {
    throw new Error(`rotation period must be positive; got ${periodHours}`);
  }
  const periodMs = periodHours * 60 * 60 * 1000;
  const index = Math.floor(at.getTime() / periodMs);
  return { index, startedAt: new Date(index * periodMs), periodHours };
}

/**
 * The sort key for one artwork in one epoch.
 *
 * Hex, so it compares lexicographically the way the bytes compare, and stable
 * across processes and Node versions -- which matters because "reproducible"
 * has to survive a deployment, not only a second request.
 */
export function rotationKey(epoch: RotationEpoch, artworkId: string): string {
  return createHash("sha256").update(`${epoch.index}:${artworkId}`, "utf8").digest("hex");
}

/**
 * Order one tie band.
 *
 * Pure, and takes the ids rather than the scored rows, so the property that
 * matters -- this depends on the epoch and the id, and on nothing else -- is
 * visible in the signature. There is no parameter here that an impression
 * count could be passed as.
 */
export function orderTieBand(epoch: RotationEpoch, artworkIds: readonly string[]): readonly string[] {
  return [...artworkIds].sort((left, right) => {
    const a = rotationKey(epoch, left);
    const b = rotationKey(epoch, right);
    if (a === b) return left < right ? -1 : left > right ? 1 : 0;
    return a < b ? -1 : 1;
  });
}
