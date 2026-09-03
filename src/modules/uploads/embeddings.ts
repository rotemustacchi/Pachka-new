/**
 * The embedding: computed once per primary image, never at query time.
 *
 * upload-pipeline, "Embedding generated once per artwork": compute and store a
 * vector for each published artwork's primary image at upload time; recompute
 * ONLY when the primary image changes; never compute at query time.
 * ARCHITECTURE.md states the last clause as a hard rule -- "If a matchmaker
 * code path can reach an AI provider, it is wrong" -- and the reason is the
 * cost constraint the whole project is shaped by: AI spend scales with the
 * number of artworks, not with traffic.
 *
 * "RECOMPUTED ONLY WHEN THE PRIMARY IMAGE CHANGES"
 * -----------------------------------------------
 * Implemented as a comparison, not as a notification. `artwork_embeddings`
 * stores the `image_id` its vector came from; `ensureEmbedding` reads the row
 * currently at position 0 and recomputes exactly when the two differ. So:
 *
 *   - calling it twice with nothing changed makes no second call, because the
 *     ids match;
 *   - swapping the primary image makes it recompute, because they no longer do,
 *     WITHOUT `artworks.setPrimaryImage` having to know this module exists.
 *
 * The alternative -- an event fired on image change -- is correct only for as
 * long as every path that changes the primary image remembers to fire it, and
 * `artworks.setPrimaryImage` is deliberately ignorant of `uploads`.
 *
 * WHAT IS EMBEDDED
 * ----------------
 * design.md: "One embedding call over that description plus the taxonomy
 * values." Not the pixels. The description already came out of the single
 * vision call at upload, so this adds no second look at the image, and
 * embedding the taxonomy alongside it means a buyer's questionnaire answers --
 * which are taxonomy values -- land in the same space as the artwork.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { Embedder } from "./ports";
import { recordEvent } from "./events";

/**
 * Vector width, stated in code as well as in the column type.
 *
 * Not an `app_config` value: `vector(1024)` is baked into the column, so
 * changing this is a migration, and an operator editing a row must not be able
 * to desynchronise the two. `uploads-embeddings.test.ts` reads
 * `information_schema` and asserts the column agrees with this constant.
 */
export const EMBEDDING_DIMENSIONS = 1024;

export interface StoredEmbedding {
  readonly artworkId: string;
  readonly imageId: string;
  readonly model: string;
  readonly description: string;
  readonly updatedAt: Date;
}

/** What `ensureEmbedding` did, so the caller can record it truthfully. */
export type EmbeddingOutcome =
  /** Computed and stored, because there was none or the primary image changed. */
  | { readonly status: "stored"; readonly embedding: StoredEmbedding }
  /** The stored vector already belongs to the current primary image. */
  | { readonly status: "unchanged"; readonly embedding: StoredEmbedding }
  /** No primary image to embed. Not an error: a draft may have no image yet. */
  | { readonly status: "no_primary_image" }
  /** Nothing to embed FROM: analysis failed, so there is no description. */
  | { readonly status: "no_source_text" }
  /** The embedding provider failed. The artwork still publishes; see below. */
  | { readonly status: "failed"; readonly reason: string };

/**
 * The text the vector is computed from.
 *
 * Taxonomy first and description second, so that two artworks sharing a medium
 * and a style start out close even when one has a much longer description.
 * Exported because it is worth testing that the taxonomy actually reaches the
 * vector -- an embedding computed from the description alone would rank
 * plausibly and be wrong in a way no assertion on the vector could catch.
 */
export function embeddingText(input: {
  readonly medium: string | null;
  readonly styles: readonly string[];
  readonly moods: readonly string[];
  readonly targetSpaces: readonly string[];
  readonly description: string;
}): string {
  const taxonomy = [
    input.medium ?? "",
    ...input.styles,
    ...input.moods,
    ...input.targetSpaces,
  ].filter((value) => value !== "");

  return [taxonomy.join(", "), input.description].filter((part) => part !== "").join("\n");
}

/** pgvector's text input format. `[0.1,0.2,...]`, no spaces. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw AppError.externalFailure(
      `The embedding provider returned ${vector.length} dimensions; the column holds ${EMBEDDING_DIMENSIONS}.`,
      { code: "uploads.embedding_wrong_width", details: { got: vector.length } },
    );
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw AppError.externalFailure("The embedding provider returned a non-finite component.", {
        code: "uploads.embedding_not_finite",
      });
    }
  }
  return `[${vector.join(",")}]`;
}

interface EmbeddingRow {
  readonly artwork_id: string;
  readonly image_id: string;
  readonly model: string;
  readonly description: string;
  readonly updated_at: Date;
}

function toStored(row: EmbeddingRow): StoredEmbedding {
  return {
    artworkId: row.artwork_id,
    imageId: row.image_id,
    model: row.model,
    description: row.description,
    updatedAt: row.updated_at,
  };
}

export async function embeddingFor(sql: Sql, artworkId: string): Promise<StoredEmbedding | null> {
  const row = await sql.maybeOne<EmbeddingRow>(
    "select artwork_id, image_id, model, description, updated_at from artwork_embeddings where artwork_id = $1",
    [artworkId],
  );
  return row === null ? null : toStored(row);
}

/** The raw vector, for tests and for the matchmaker's own ranking query. */
export async function embeddingVectorFor(
  sql: Sql,
  artworkId: string,
): Promise<readonly number[] | null> {
  const row = await sql.maybeOne<{ embedding: string }>(
    "select embedding::text as embedding from artwork_embeddings where artwork_id = $1",
    [artworkId],
  );
  if (row === null) return null;
  return row.embedding
    .slice(1, -1)
    .split(",")
    .map((component) => Number(component));
}

interface PrimaryImage {
  readonly id: string;
}

async function primaryImageId(sql: Sql, artworkId: string): Promise<string | null> {
  const row = await sql.maybeOne<PrimaryImage>(
    "select id from artwork_images where artwork_id = $1 and position = 0",
    [artworkId],
  );
  return row?.id ?? null;
}

export interface EmbeddingSource {
  readonly artistId: string;
  readonly medium: string | null;
  readonly styles: readonly string[];
  readonly moods: readonly string[];
  readonly targetSpaces: readonly string[];
  /** The AI description stored with the previous embedding, or a fresh one. */
  readonly description: string;
}

/**
 * Compute and store the embedding, if and only if it is missing or stale.
 *
 * A provider failure returns `failed` rather than throwing, and the caller
 * publishes anyway. upload-pipeline, "Embedding generation fails": "the artwork
 * is still published and remains browsable in the catalog, but is excluded from
 * matchmaker results until an embedding exists." Excluding it is not something
 * this function does -- it is what the ABSENCE of a row means, and
 * `rankable()` reads that absence. There is no "unrankable" flag to forget to
 * set.
 */
export async function ensureEmbedding(
  sql: Sql,
  embedder: Embedder,
  artworkId: string,
  source: EmbeddingSource,
): Promise<EmbeddingOutcome> {
  const imageId = await primaryImageId(sql, artworkId);
  if (imageId === null) return { status: "no_primary_image" };

  const existing = await embeddingFor(sql, artworkId);
  if (existing !== null && existing.imageId === imageId) {
    return { status: "unchanged", embedding: existing };
  }

  const description = source.description.trim();
  const text = embeddingText({ ...source, description });
  if (text === "") {
    return { status: "no_source_text" };
  }

  let vector: readonly number[];
  let model: string;
  try {
    const result = await embedder.embed(text);
    vector = result.vector;
    model = result.model;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordEvent(sql, {
      artworkId,
      artistId: source.artistId,
      imageId,
      event: "embedding_failed",
      detail: { reason },
    });
    return { status: "failed", reason };
  }

  let literal: string;
  try {
    literal = toVectorLiteral(vector);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordEvent(sql, {
      artworkId,
      artistId: source.artistId,
      imageId,
      event: "embedding_failed",
      detail: { reason },
    });
    return { status: "failed", reason };
  }

  const row = await sql.one<EmbeddingRow>(
    `insert into artwork_embeddings (artwork_id, image_id, embedding, description, model)
     values ($1, $2, $3::vector, $4, $5)
     on conflict (artwork_id) do update
        set image_id    = excluded.image_id,
            embedding   = excluded.embedding,
            description = excluded.description,
            model       = excluded.model
     returning artwork_id, image_id, model, description, updated_at`,
    [artworkId, imageId, literal, description, model],
  );

  await recordEvent(sql, {
    artworkId,
    artistId: source.artistId,
    imageId,
    event: "embedding_stored",
    detail: { model, recomputed: existing !== null },
  });

  return { status: "stored", embedding: toStored(row) };
}

/**
 * Of these artworks, the ones the matchmaker may rank.
 *
 * The other half of "browsable but excluded": `artworks.listPublishedArtworks`
 * answers the catalog's question and knows nothing about embeddings, and this
 * answers the matchmaker's. One query for the whole candidate set, because a
 * query per candidate per questionnaire is the traffic-scaled cost the design
 * exists to avoid.
 */
export async function rankableArtworkIds(
  sql: Sql,
  artworkIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (artworkIds.length === 0) return new Set();

  const { rows } = await sql.query<{ artwork_id: string }>(
    "select artwork_id from artwork_embeddings where artwork_id = any($1::uuid[])",
    [[...artworkIds]],
  );
  return new Set(rows.map((row) => row.artwork_id));
}
