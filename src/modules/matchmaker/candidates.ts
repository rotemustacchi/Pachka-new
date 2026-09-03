/**
 * The one query the questionnaire runs against the catalog.
 *
 * One statement, one round trip, bounded result set, under a statement timeout.
 * SECURITY.md S2-22 is about this file: the questionnaire "is anonymous by
 * design and requires no account", and each submission "runs a pgvector
 * similarity scan blended with taxonomy, budget, and size scoring over the
 * published catalog... On Supabase's free tier that is the most expensive
 * anonymous operation in the system."
 *
 * THREE THINGS BOUND THE COST, AND ALL THREE ARE HERE
 * --------------------------------------------------
 * 1. The candidate pool is capped (`matchmaker.candidate_pool_size`), so an
 *    anonymous request cannot ask the database to sort the entire catalog.
 * 2. When there is a query vector, the ORDER BY is `embedding <=> $vec`, which
 *    is the operator `artwork_embeddings_cosine_idx` was built for — an HNSW
 *    index on `vector_cosine_ops`. An index built for a different operator is
 *    not used by the query at all, which is why the distance expression here
 *    and the index there have to stay the same shape.
 * 3. The statement runs with `statement_timeout` set locally, so a pathological
 *    plan is a failed request rather than a held connection
 *    (SECURITY.md S2-22 item 2).
 *
 * "BROWSABLE BUT UNMATCHED" IS THE JOIN, NOT A FLAG
 * ------------------------------------------------
 * `upload-pipeline`, "Embedding generation fails": an artwork without an
 * embedding "is still published and remains browsable in the catalog, but is
 * excluded from matchmaker results until an embedding exists". `uploads` states
 * the same thing from its side: "that is the ABSENCE of a row rather than a
 * flag, so there is nothing to keep in sync." An INNER JOIN onto
 * `artwork_embeddings` is that absence, spelled in SQL. There is no `rankable`
 * boolean anywhere in this module to forget to set, and no code path that could
 * include an artwork the join excludes.
 *
 * A NOTE ON THE MODULE BOUNDARY, WHICH IS A GENUINE CONFLICT AND IS REPORTED
 * -------------------------------------------------------------------------
 * ARCHITECTURE.md's allowed-dependency table gives `matchmaker` edges to
 * `artworks` and `catalog`, and no edge to `uploads`. Yet `uploads/index.ts`
 * addresses this module directly — "`matchmaker` — `matchmakerExclusion()`
 * answers 'which of these may I rank'... `embeddingVectorFor` gives you the
 * stored vector; do not compute one" — and the vectors it owns are the ranking
 * input. Both of its offered entry points are per-artwork or per-set functions
 * returning vectors to JavaScript, which would mean pulling the catalog into
 * the process and sorting it there: no index, no bound, and the cost curve the
 * design exists to flatten.
 *
 * So this file READS `artwork_embeddings` in SQL and writes nothing to it,
 * which ARCHITECTURE.md permits in the same sentence it forbids the write.
 * It is reported to the lead architect as a dependency-table question rather
 * than resolved silently: either the table gains a matchmaker → uploads edge,
 * or the read is blessed as the cross-module read it already is.
 */
import type { Medium, Mood, Style, TargetSpace } from "@/modules/artworks";
import type { Database } from "@/shared/db";
import type { ScorableArtwork } from "./scoring";
import { VISIBLE_ARTWORK } from "./query-vector";

interface CandidateRow {
  readonly id: string;
  readonly price_agorot: string;
  readonly medium: Medium | null;
  readonly styles: readonly Style[];
  readonly target_spaces: readonly TargetSpace[];
  readonly moods: readonly Mood[];
  readonly height_mm: number | null;
  readonly width_mm: number | null;
  readonly published_at: Date | null;
  readonly cosine_similarity: number | null;
}

export interface CandidateQuery {
  /** A pgvector literal, or null when the catalog gave us nothing to aim at. */
  readonly vector: string | null;
  readonly poolSize: number;
  readonly timeoutMs: number;
}

/**
 * Fetch the candidate pool.
 *
 * Runs in a READ-ONLY transaction, which is what makes `set local
 * statement_timeout` scoped to this statement rather than leaked onto a pooled
 * connection that the next request inherits. Read-only is also a real control:
 * nothing in the ranking path is permitted to write, and this makes that true
 * of the connection rather than merely true of the code.
 *
 * `price_agorot` comes back as a string because it is a `bigint` and the driver
 * will not silently narrow it. SECURITY.md S2-27: bigint agorot arriving as
 * strings is how money gets concatenated instead of added. It is parsed here,
 * once, at the boundary.
 */
export async function fetchCandidates(
  db: Database,
  query: CandidateQuery,
): Promise<readonly ScorableArtwork[]> {
  const rows = await db.withTransaction(
    async (tx) => {
      // `set local` is scoped to this transaction and reverts on commit, so a
      // pooled connection cannot carry the timeout to an unrelated request.
      // The value is interpolated because Postgres does not accept a parameter
      // in SET; it is an integer read from app_config and bounded there, and
      // is coerced again here so this line cannot become an injection point
      // however the config is later sourced.
      const timeout = Math.trunc(query.timeoutMs);
      await tx.query(`set local statement_timeout = ${timeout}`);

      const { rows: found } = await tx.query<CandidateRow>(
        `select a.id,
                a.price_agorot::text as price_agorot,
                a.medium,
                a.styles,
                a.target_spaces,
                a.moods,
                a.height_mm,
                a.width_mm,
                a.published_at,
                case when $1::text is null then null
                     else 1 - (e.embedding <=> $1::vector)
                end as cosine_similarity
           from artworks a
           join artwork_embeddings e on e.artwork_id = a.id
          where ${VISIBLE_ARTWORK}
          order by case when $1::text is null then null else e.embedding <=> $1::vector end
                     asc nulls last,
                   a.published_at desc nulls last,
                   a.id
          limit $2`,
        [query.vector, query.poolSize],
      );
      return found;
    },
    { readOnly: true },
  );

  return rows.map(toScorable);
}

function toScorable(row: CandidateRow): ScorableArtwork {
  return {
    id: row.id,
    priceAgorot: Number(row.price_agorot),
    medium: row.medium,
    styles: row.styles ?? [],
    targetSpaces: row.target_spaces ?? [],
    moods: row.moods ?? [],
    heightMm: row.height_mm,
    widthMm: row.width_mm,
    publishedAt: row.published_at,
    cosineSimilarity: row.cosine_similarity === null ? null : Number(row.cosine_similarity),
  };
}

/**
 * How many artworks are published and visible right now.
 *
 * The sparse-catalog message keys off the size of the CATALOG, not off the size
 * of the result set: "when the total published catalog is below the configured
 * sparse threshold" is a separate trigger from "when fewer results are returned
 * than requested" (art-matchmaker, "Honest behavior on a sparse catalog"). An
 * artwork with no embedding counts here — it is browsable, and the message is
 * about how much work there is to look at, not about how much of it is
 * rankable.
 */
export async function publishedArtworkCount(db: Database): Promise<number> {
  const row = await db.one<{ count: string }>(
    `select count(*)::text as count from artworks a where ${VISIBLE_ARTWORK}`,
  );
  return Number(row.count);
}
