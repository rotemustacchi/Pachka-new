/**
 * Publication, gated on screening.
 *
 * upload-pipeline: "a screening failure blocks publication, never merely
 * warns", and SECURITY.md SPEC-C spells out why the weaker reading is not
 * available: the screening service being unreachable is attacker-triggerable,
 * so "proceed with a warning" hands the attacker the decision.
 *
 * WHY THE GATE IS HERE AND NOT INSIDE `artworks.publishArtwork`
 * ------------------------------------------------------------
 * `artworks` owns publication and ARCHITECTURE.md's dependency table points
 * uploads -> artworks, not the reverse. `artworks` therefore cannot call this
 * module, and this module cannot reach inside `publishArtwork`. So the gate
 * runs here, in front of it, and `publishArtwork` below is the entry point a
 * route uses.
 *
 * THAT LEAVES A DOOR, AND IT IS REPORTED RATHER THAN PAPERED OVER
 * --------------------------------------------------------------
 * Nothing stops a future route from importing `artworks.publishArtwork`
 * directly and skipping this. The structurally sound fix is the pattern
 * `artworks` already uses twice: `ArtworksDeps` carries `InventoryDemandSource`
 * and `ImpressionSource` as injected ports that fail CLOSED when unwired, and a
 * `ScreeningGate` port alongside them -- defaulting to one that refuses --
 * would make the gate unskippable from inside the module that owns publishing.
 * That is a change to `artworks`, which this agent may not write, so it is in
 * the report to the lead architect. Until it lands, the gate is enforced here
 * and asserted by `uploads-screening.test.ts`.
 */
import { publishArtwork as publishThroughArtworks, type Artwork } from "@/modules/artworks";
import type { Sql } from "@/shared/db";
import type { UploadsDeps } from "./deps";
import { assertPublishable } from "./screening";
import { ensureEmbedding, type EmbeddingOutcome } from "./embeddings";
import { embeddingFor } from "./embeddings";
import { suggestionsFor } from "./classification";
import { classificationProvenance } from "./classification";

export interface PublishOutcome {
  readonly artwork: Artwork;
  /**
   * What happened to the embedding. `failed` and `no_source_text` do NOT undo
   * the publication: upload-pipeline is explicit that an artwork with no
   * embedding "is still published and remains browsable in the catalog, but is
   * excluded from matchmaker results until an embedding exists".
   */
  readonly embedding: EmbeddingOutcome;
}

/**
 * Publish, but only if the primary image has been screened.
 *
 * The gate runs BEFORE `artworks.publishArtwork`, not after, so an unscreened
 * artwork is never momentarily published. It also runs before the completeness
 * survey, which means an artist with an unscreened image and three missing
 * fields is told about the screening first -- the right order, because the
 * three fields are theirs to fix and the screening is not.
 */
export async function publishArtwork(
  deps: UploadsDeps,
  artistId: string,
  artworkId: string,
): Promise<PublishOutcome> {
  await assertPublishable(deps.db, artworkId);

  const artwork = await publishThroughArtworks(deps.artworks, artistId, artworkId);

  // The embedding is computed after publication rather than before, and the
  // ordering is deliberate: a provider outage must not be able to stop an
  // artwork going live, so publication must not be waiting on it.
  const embedding = await ensureEmbedding(deps.db, deps.embedder, artworkId, {
    artistId,
    medium: artwork.medium,
    styles: artwork.styles,
    moods: artwork.moods,
    targetSpaces: artwork.targetSpaces,
    description: await descriptionForEmbedding(deps.db, artworkId, artwork.description),
  });

  return { artwork, embedding };
}

/**
 * What to embed: the AI description when there is one, the artist's otherwise.
 *
 * design.md embeds "that description plus the taxonomy values", meaning the
 * model's rich description of the image. When analysis failed there is none,
 * and falling back to the artist's own description is better than not
 * embedding at all -- the artwork would otherwise be permanently unrankable
 * through no fault of the artist's.
 *
 * A previously stored embedding's description is reused rather than re-derived,
 * so a recompute triggered by a new primary image does not silently switch
 * which text the artwork is ranked on when the new image was not analysed.
 */
async function descriptionForEmbedding(
  sql: Sql,
  artworkId: string,
  artistDescription: string | null,
): Promise<string> {
  const suggestions = await suggestionsFor(sql, artworkId);
  if (suggestions.description !== "") return suggestions.description;

  const stored = await embeddingFor(sql, artworkId);
  if (stored !== null && stored.description !== "") return stored.description;

  return artistDescription ?? "";
}

/**
 * Everything a route needs to render the classification step.
 *
 * One call rather than three, because the three answers have to be consistent
 * with each other: suggestions the artist has already overridden must be shown
 * next to the provenance saying so.
 */
export async function classificationState(sql: Sql, artworkId: string) {
  const [suggestions, provenance] = await Promise.all([
    suggestionsFor(sql, artworkId),
    classificationProvenance(sql, artworkId),
  ]);
  return { suggestions, provenance };
}
