/**
 * The production `Embedder`: Voyage AI, `voyage-3`, 1024 dimensions.
 *
 * WHY NOT ANTHROPIC
 * -----------------
 * Everything else in this module's AI budget is Anthropic, and this one call is
 * not, for the simple reason that Anthropic does not offer an embeddings API.
 * Voyage AI is Anthropic's own documented recommendation for embeddings, and
 * `voyage-3` returns exactly 1024 dimensions, which is the width already baked
 * into `artwork_embeddings.embedding` as `vector(1024)` and asserted against
 * `information_schema` by `uploads-embeddings.test.ts`. So this provider was
 * chosen to fit the column rather than the column changed to fit a provider --
 * deliberately, because changing a stored vector's dimension invalidates every
 * embedding already written and every ranking computed from one.
 *
 * WHY `input_type: "document"` FOR EVERYTHING
 * -------------------------------------------
 * Voyage's asymmetric models put queries and documents in slightly different
 * sub-spaces, which is a win when a short question is matched against long
 * documents. It would be a bug here. `matchmaker` does not embed the buyer's
 * questionnaire -- ARCHITECTURE.md forbids a matchmaker code path reaching an
 * AI provider at all -- it builds the query vector by combining the stored
 * vectors of artworks that already match the answers. Every vector in the
 * system is therefore a document vector, including the ones used as queries,
 * and they have to live in one space to be comparable.
 *
 * COST
 * ----
 * `voyage-3` bills about $0.06 per million tokens. The text is a handful of
 * taxonomy values plus a description capped at `artworks.max_description_length`
 * -- call it 250 tokens -- so one embedding costs roughly $0.000015. It is a
 * rounding error next to the vision call, and it is mentioned here only so that
 * "the embedding is cheap" is a measured statement rather than an assumption.
 * What makes it cheap is not the price: it is that `ensureEmbedding` computes
 * one per PRIMARY IMAGE and the matchmaker computes none per query.
 */
import { AppError } from "@/shared/errors";
import { EMBEDDING_DIMENSIONS } from "./embeddings";
import type { Embedder, EmbeddingResult } from "./ports";
import type { HttpTransport } from "./anthropic-vision";

/**
 * The model, and why it is a constant rather than an environment variable.
 *
 * An operator who could swap this from a dashboard would produce a table of
 * mixed, mutually incomparable vectors: `ensureEmbedding` recomputes when the
 * PRIMARY IMAGE changes, not when the model does, so old rows would keep their
 * old vectors and the cosine distances between the two generations would be
 * meaningless. Changing embedding model is a backfill, and a backfill is a
 * deploy, so the model belongs in code where a review can see it.
 */
export const EMBEDDING_MODEL = "voyage-3";

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

/** Matches the vision adapter's budget. An artist is watching a spinner. */
export const EMBEDDING_TIMEOUT_MS = 20_000;

export interface VoyageEmbedderOptions {
  /** Defaults to `process.env.VOYAGE_API_KEY`. Passed explicitly only by tests. */
  readonly apiKey?: string | undefined;
  readonly transport?: HttpTransport;
  readonly model?: string;
  readonly timeoutMs?: number;
}

/**
 * Read the vector out of the response, refusing anything that is not one.
 *
 * Every rejection here is deliberately an `AppError` with its own code rather
 * than a silent coercion. `ensureEmbedding` catches whatever this throws,
 * records an `embedding_failed` event carrying the message, and returns
 * `failed` -- and upload-pipeline says what that means: "the artwork is still
 * published and remains browsable in the catalog, but is excluded from
 * matchmaker results until an embedding exists". So a bad response costs an
 * artwork its ranking until someone looks at the event log. A COERCED response
 * -- a short vector zero-padded to 1024, say -- would cost it its ranking
 * forever, silently, and would look like a working system.
 */
function readVector(payload: unknown): { vector: number[]; model: string | null } {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw AppError.externalFailure("The embedding response carried no data.", {
      code: "uploads.embedding_malformed_response",
    });
  }

  const embedding = (data[0] as { embedding?: unknown } | null)?.embedding;
  if (!Array.isArray(embedding)) {
    throw AppError.externalFailure("The embedding response carried no vector.", {
      code: "uploads.embedding_malformed_response",
    });
  }

  const vector: number[] = [];
  for (const component of embedding) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw AppError.externalFailure(
        "The embedding response contained a component that is not a finite number.",
        { code: "uploads.embedding_not_finite" },
      );
    }
    vector.push(component);
  }

  if (vector.length !== EMBEDDING_DIMENSIONS) {
    // `toVectorLiteral` would also catch this, one layer later. Catching it
    // here names the provider in the message, which is the difference between
    // an operator reading "the column holds 1024" and knowing which knob is
    // wrong.
    throw AppError.externalFailure(
      `The embedding provider returned ${vector.length} dimensions; artwork_embeddings.embedding is vector(${EMBEDDING_DIMENSIONS}).`,
      { code: "uploads.embedding_wrong_width", details: { got: vector.length } },
    );
  }

  const reported = (payload as { model?: unknown }).model;
  return { vector, model: typeof reported === "string" && reported !== "" ? reported : null };
}

/**
 * The production embedding client.
 *
 * MISSING KEY DEGRADES HONESTLY
 * -----------------------------
 * With no `VOYAGE_API_KEY`, `embed` REJECTS. It does not return a zero vector,
 * and there is no development stub -- a table of zero vectors would rank every
 * artwork identically while looking, from the outside, exactly like a working
 * matchmaker. Rejecting means `ensureEmbedding` records `embedding_failed` and
 * the artwork publishes, is browsable, and is absent from match results until
 * the key is set and the primary image is re-processed. That is the failure
 * mode `upload-pipeline` specifies, and unlike the vision key it does not block
 * publication: an unranked artwork is a degraded experience, not a safety
 * problem.
 *
 * The key is read at CALL time so importing this module needs no environment.
 */
export function createVoyageEmbedder(options: VoyageEmbedderOptions = {}): Embedder {
  const transport = options.transport ?? ((url, init) => globalThis.fetch(url, init));
  const model = options.model ?? EMBEDDING_MODEL;
  const timeoutMs = options.timeoutMs ?? EMBEDDING_TIMEOUT_MS;

  return {
    async embed(text: string): Promise<EmbeddingResult> {
      const apiKey = options.apiKey ?? process.env["VOYAGE_API_KEY"];
      if (apiKey === undefined || apiKey === "") {
        throw AppError.externalFailure(
          "VOYAGE_API_KEY is not set, so no artwork can be embedded. Uploads and publication " +
            "still work; every artwork will be browsable in the catalog and absent from " +
            "matchmaker results until the key is configured (see .env.example).",
          { code: "uploads.embedding_not_configured" },
        );
      }

      // -------------------------------------------------------------------
      // THE PAID CALL. ONCE PER PRIMARY IMAGE, NEVER PER QUERY.
      //
      // ~$0.000015 per artwork at voyage-3's $0.06/MTok. Trivial per call, and
      // that is exactly why it is worth guarding: a cost this small is the kind
      // a future change moves into a request path without noticing. It must
      // not. ARCHITECTURE.md: "If a matchmaker code path can reach an AI
      // provider, it is wrong." The buyer's query vector is built in
      // `matchmaker/query-vector.ts` out of vectors ALREADY STORED here; if you
      // are about to call `embed` from a questionnaire handler, a search box or
      // any other buyer-triggered path, that is the mistake this comment
      // exists to catch.
      // -------------------------------------------------------------------
      let response: Response;
      try {
        response = await transport(VOYAGE_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model,
            input: [text],
            // Every vector in this system is a document vector; see the header.
            input_type: "document",
            // A description longer than the model's window is truncated rather
            // than rejected. Losing the tail of a long description costs a
            // little ranking precision; a 400 costs the artwork its ranking
            // entirely.
            truncation: true,
          }),
        });
      } catch (error) {
        const name = (error as { name?: string } | undefined)?.name;
        const timedOut = name === "TimeoutError" || name === "AbortError";
        throw AppError.externalFailure(
          timedOut
            ? `The embedding provider did not answer within ${timeoutMs}ms.`
            : `The embedding provider could not be reached: ${error instanceof Error ? error.message : String(error)}`,
          { code: "uploads.embedding_unreachable", cause: error },
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw AppError.externalFailure(
          `The embedding provider returned HTTP ${response.status}: ${body.slice(0, 400)}`,
          { code: "uploads.embedding_http_error", details: { status: response.status } },
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw AppError.externalFailure("The embedding response was not JSON.", {
          code: "uploads.embedding_malformed_response",
          cause: error,
        });
      }

      const { vector, model: reported } = readVector(payload);

      // The model recorded on the row is the one the provider says produced the
      // vector, falling back to the one we asked for. `artwork_embeddings.model`
      // exists so two incomparable vectors never share a table, which only
      // works if it names what actually ran.
      return { vector, model: reported ?? model };
    },
  };
}
