/**
 * Match impressions: counted for the artist, invisible to the ranking.
 *
 * art-matchmaker, "Match impressions are recorded for reporting only": record
 * per artwork how often it has been returned, expose it to the artist and to
 * admins, and "This count SHALL be reporting data only and SHALL NOT be read by
 * the ranking function."
 *
 * WHY THAT SENTENCE IS A SECURITY REQUIREMENT AND NOT A PREFERENCE
 * ---------------------------------------------------------------
 * SECURITY.md S2-23. Every row this file writes is caused by an anonymous
 * stranger submitting a questionnaire. If the ranking read the count, an artist
 * could script submissions crafted to return a competitor's work, inflate that
 * competitor's count, and — under the pre-review design, which ranked ties by
 * ascending lifetime impressions — demote them permanently while their own
 * never-returned work rose. The counter is an attacker-writable ranking input,
 * which is a contradiction in terms.
 *
 * The defence is structural rather than diligent. `ranking.ts` takes scores and
 * an epoch; `scoring.ts` takes an artwork, answers, and a context of weights and
 * thresholds. Neither has a parameter this count could be passed as, and
 * neither takes a database handle to go and read it with. Grepping this module
 * for `match_impressions` returns this file and the migration, and nothing on
 * the ranking path.
 *
 * DEDUPLICATION IS THE DATABASE'S JOB
 * ----------------------------------
 * SECURITY.md S2-23 item 1: "at most one impression per artwork per (session or
 * hashed IP) per configured window. Repeated identical queries do not
 * accumulate." A select-then-insert implements that until two requests arrive
 * at once, and the flood being defended against is concurrent by construction.
 * So the window is reified as `dedupe_bucket` — the window index computed from
 * the configured window length — and the UNIQUE constraint over (artwork,
 * viewer, bucket) makes the second insert in a window impossible rather than
 * unlikely. `on conflict do nothing` is the whole of the dedupe logic.
 *
 * Item 4 of the same finding — "The dashboard figure shown to artists is the
 * deduplicated count" — then comes for free: there is no other kind of row in
 * the table to count.
 */
import type { ImpressionSource } from "@/modules/artworks";
import type { Sql } from "@/shared/db";
import { matchmakerRateLimits } from "./config";

const MILLISECONDS_PER_MINUTE = 60 * 1000;

/**
 * The window index an instant falls in.
 *
 * Exported because it is the whole of the dedupe guarantee and deserves a test
 * that does not need a database: two instants inside one window share a bucket,
 * two instants either side of a boundary do not.
 */
export function dedupeBucket(at: Date, windowMinutes: number): number {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error(`impression dedupe window must be positive; got ${windowMinutes}`);
  }
  return Math.floor(at.getTime() / (windowMinutes * MILLISECONDS_PER_MINUTE));
}

/**
 * Record that these artworks were shown to this viewer.
 *
 * Returns how many impressions were actually new, which is what a test asserts
 * against and what an operator watching for the anomaly in SECURITY.md S2-23
 * item 3 would chart. Repeats inside the window return zero without erroring:
 * showing a buyer the same matches twice is normal behaviour, not a conflict.
 *
 * `viewerFingerprint` arrives already hashed, like every other subject in this
 * module — a raw IP never reaches here.
 */
export async function recordImpressions(
  db: Sql,
  artworkIds: readonly string[],
  viewerFingerprint: string,
  at: Date = new Date(),
): Promise<number> {
  if (artworkIds.length === 0) return 0;

  const { impressionDedupeWindowMinutes } = await matchmakerRateLimits(db);
  const bucket = dedupeBucket(at, impressionDedupeWindowMinutes);

  const { rowCount } = await db.query(
    `insert into match_impressions (artwork_id, viewer_fingerprint, dedupe_bucket)
     select id, $2, $3 from unnest($1::uuid[]) as id
     on conflict (artwork_id, viewer_fingerprint, dedupe_bucket) do nothing`,
    [[...artworkIds], viewerFingerprint, bucket],
  );
  return rowCount;
}

/**
 * Deduplicated lifetime impression counts, for the artworks asked about.
 *
 * Every artwork asked about appears in the result, with zero where there are no
 * rows — an artwork that has never been matched has been shown zero times, and
 * a caller should not have to distinguish "no impressions" from "not in the
 * map".
 */
export async function impressionCounts(
  db: Sql,
  artworkIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>(artworkIds.map((id) => [id, 0] as const));
  if (artworkIds.length === 0) return counts;

  const { rows } = await db.query<{ artwork_id: string; count: string }>(
    `select artwork_id, count(*)::text as count
       from match_impressions
      where artwork_id = any($1::uuid[])
      group by artwork_id`,
    [[...artworkIds]],
  );

  for (const row of rows) counts.set(row.artwork_id, Number(row.count));
  return counts;
}

/**
 * The `ImpressionSource` `artworks` declared and this module supplies.
 *
 * ARCHITECTURE.md, "Downstream facts arrive as injected ports, never as
 * cross-module reads": the dependency table points matchmaker AT artworks, so
 * artworks cannot import this module to fill in the dashboard's impression
 * column. It declares the port; `src/app` injects this implementation when it
 * composes `ArtworksDeps`, replacing `noImpressions`, which honestly reports
 * zero for everything until it is wired.
 *
 * Typed as artworks' own `ImpressionSource` rather than as a structural twin,
 * because matchmaker → artworks is an edge the dependency table actually has,
 * so the compiler can check the shape instead of a test having to.
 */
export function impressionSource(): ImpressionSource {
  return { countsFor: impressionCounts };
}
