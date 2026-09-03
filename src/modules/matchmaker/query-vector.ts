/**
 * Turning a buyer's answers into a vector, without asking a model to do it.
 *
 * THE PROBLEM THIS FILE EXISTS FOR
 * --------------------------------
 * An artwork's embedding was computed at upload from its taxonomy plus the AI
 * description (`uploads/embeddings.ts`). To rank by cosine similarity we need a
 * vector on the buyer's side of the comparison, and the obvious way to get one
 * is to embed the buyer's answers — one embedding call per questionnaire.
 *
 * That is the exact thing the whole project is shaped to avoid. ARCHITECTURE.md:
 * "No outbound AI call at query time... If a matchmaker code path can reach an
 * AI provider, it is wrong." The reason is not fastidiousness: AI spend that
 * scales with the number of ARTWORKS is a cost the business can carry, and AI
 * spend that scales with TRAFFIC is one it cannot, because the questionnaire is
 * anonymous, unauthenticated, and the cheapest thing in the system to script.
 *
 * THE ANSWER: THE CATALOG ALREADY CONTAINS THE VECTORS
 * ---------------------------------------------------
 * The buyer's answers are taxonomy values. Every artwork's embedding was
 * computed from text that LEADS with its taxonomy values. So the region of the
 * vector space that means "minimalist, calm, living room" is already described,
 * precisely, by the artworks that are classified that way — and the centroid of
 * their stored embeddings is a vector in exactly that region.
 *
 *   query vector := avg(embedding) over published artworks matching ANY
 *                   answered taxonomy axis
 *
 * It costs one `avg()` over an indexed set, runs entirely inside Postgres, and
 * reaches nothing outside the database. It also has a property an embedding of
 * the buyer's words would not: it is expressed in the same distribution as the
 * things being ranked, so cosine distances mean the same thing on both sides.
 *
 * WHAT IT COSTS, HONESTLY
 * -----------------------
 * The centroid is only as good as the catalog. With three artworks matching the
 * answers it is a coarse direction; with none it does not exist at all, and
 * `null` comes back rather than a fabricated vector. That is not a failure
 * state to paper over — it is the sparse catalog the spec devotes a whole
 * requirement to being honest about. When there is no vector, `scoring.ts`
 * drops the embedding component and renormalises over the remaining four, so
 * the buyer gets a ranking on taxonomy, budget, size and freshness rather than
 * a ranking against a vector that meant nothing.
 *
 * Falling back to the centroid of the WHOLE rankable catalog was considered and
 * rejected: that vector is "the average artwork on PACHKA", which ranks every
 * piece by how typical it is. On a young catalog that is a feedback loop
 * pointed directly at homogeneity, and it would be invisible in every test that
 * did not already know to look for it.
 */
import type { Sql } from "@/shared/db";
import type { Answers } from "./questionnaire";
import { hasTaxonomyAnswers } from "./questionnaire";

/**
 * The visibility predicate, restated as SQL.
 *
 * The same two conditions `artworks.listPublishedArtworks` applies: published,
 * and the artist is not suspended. Written here rather than called because the
 * centroid has to be an aggregate computed inside the database — pulling every
 * published artwork into the process to average its vector in JavaScript is the
 * traffic-scaled cost this module exists to avoid, one layer down.
 *
 * `account_status` belongs to `accounts` and `artwork_embeddings` to `uploads`.
 * Both are READS. ARCHITECTURE.md: "Foreign keys across module boundaries are
 * permitted and expected. Writes are not." `artworks/queries.ts` reads
 * `account_status` the same way and for the same reason.
 */
export const VISIBLE_ARTWORK = `
  a.status = 'published'
  and not exists (
    select 1 from account_status s
     where s.user_id = a.artist_id and s.suspended_at is not null
  )`;

/**
 * The centroid of the artworks matching the buyer's answers, as a pgvector
 * literal, or null when nothing matches.
 *
 * "Matching ANY answered axis", not all of them. Requiring all would make the
 * vector vanish the moment a buyer answered four questions on a catalog of
 * forty pieces, which is the common case at launch rather than an edge one.
 */
export async function queryVector(sql: Sql, answers: Answers): Promise<string | null> {
  if (!hasTaxonomyAnswers(answers)) return null;

  const row = await sql.maybeOne<{ centroid: string | null }>(
    `select avg(e.embedding)::text as centroid
       from artwork_embeddings e
       join artworks a on a.id = e.artwork_id
      where ${VISIBLE_ARTWORK}
        and (
             ($1::text is not null and a.medium = $1::text)
          or (cardinality($2::text[]) > 0 and a.styles        && $2::text[])
          or (cardinality($3::text[]) > 0 and a.target_spaces && $3::text[])
          or (cardinality($4::text[]) > 0 and a.moods         && $4::text[])
        )`,
    [answers.medium, [...answers.styles], [...answers.targetSpaces], [...answers.moods]],
  );

  return row?.centroid ?? null;
}
