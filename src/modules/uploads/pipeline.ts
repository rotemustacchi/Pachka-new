/**
 * The pipeline, in the order the money says it has to run in.
 *
 *   1. Local technical gate      -- free, and therefore first.
 *   2. One vision call           -- taxonomy, colours, safety, description.
 *   3. Derivatives and storage   -- re-encoded, metadata-free, unwatermarked.
 *   4. Attach through `artworks` -- their table, their API.
 *   5. Embedding                 -- at publish, from the description.
 *
 * STEP 1 BEFORE STEP 2 IS THE WHOLE COST MODEL
 * --------------------------------------------
 * The change proposal's hard constraint is that AI spend scales with the number
 * of ARTWORKS, not with traffic. An image that is too small, too light or out
 * of focus must therefore cost nothing at all -- and "nothing" means the vision
 * client is never reached, not that the response is discarded. Anything else
 * turns the upload form into a billing endpoint for anyone with a folder of
 * blurry snapshots. `uploads-pipeline.test.ts` injects an analyst that THROWS
 * if called and asserts a blurry image is still rejected, which is the only
 * form of that assertion that cannot pass for the wrong reason.
 *
 * STEP 2 BEFORE STEP 3 IS THE SAFETY MODEL
 * ----------------------------------------
 * An image blocked by screening must leave no object behind: SECURITY.md S0-7's
 * test asks that "no `artwork_images` row exists, no object remains in the
 * artwork bucket". Screening before storing is the cheapest way to make that
 * true -- there is nothing to clean up if nothing was written -- and it means a
 * crash between the two cannot strand an unscreened object in a public bucket.
 *
 * WHAT A FAILURE DOES, PER SPEC, AND THEY ARE NOT THE SAME
 * -------------------------------------------------------
 *   blocked by screening  -> the upload is REFUSED. Nothing is stored.
 *   screening unavailable -> the upload SUCCEEDS into the draft; publication is
 *                            blocked until screening succeeds or an admin
 *                            clears it, and an admin queue item exists.
 *   analysis unusable     -> the upload SUCCEEDS; the artist gets an EMPTY
 *                            classification form. Publication is NOT blocked by
 *                            this, only by the screening half.
 *   embedding fails       -> the artwork publishes and stays browsable; it is
 *                            absent from matchmaker results until one exists.
 */
import { attachImage, type ArtworkImage } from "@/modules/artworks";
import { AppError } from "@/shared/errors";
import { listingLimits } from "@/modules/artworks";
import { uploadThresholds } from "./config";
import type { UploadsDeps } from "./deps";
import { retryPolicy } from "./deps";
import { buildDerivatives } from "./derivatives";
import { recordEvent } from "./events";
import { assertWithinUploadSizeLimit, contentTypeFor, extensionFor } from "./formats";
import { generateObjectKeys } from "./keys";
import { DISPLAY_BUCKET, ORIGINALS_BUCKET } from "./ports";
import { assessQuality, qualityRejection } from "./quality";
import { screen } from "./screening";
import { emptySuggestions } from "./classification";
import { nothingRejected, type Suggestions } from "./analysis";

export interface UploadRequest {
  readonly artistId: string;
  readonly artworkId: string;
  readonly bytes: Uint8Array;
  /** Artist-written, contact-scanned by `artworks.attachImage`. */
  readonly altText?: string | null;
}

export interface UploadResult {
  readonly image: ArtworkImage;
  /** Pre-filled and editable. Empty when analysis produced nothing usable. */
  readonly suggestions: Suggestions;
  /**
   * False when screening did not return a verdict. The upload succeeded and the
   * artwork is in the artist's draft; publication is blocked until it does.
   */
  readonly screened: boolean;
  /** True when the artwork is waiting on a human. Mirrors the admin queue. */
  readonly flaggedForReview: boolean;
}

/**
 * Run one image through the pipeline.
 *
 * Everything after the vision call happens in ONE transaction: the derivative
 * record, the screening verdict, and the `artwork_images` row commit together
 * or not at all. That coupling is not tidiness -- a `screening_passed` event
 * that commits without its image, or an image that commits without its verdict,
 * is a way past the publication gate in one direction or a permanently
 * unpublishable artwork in the other.
 *
 * The object store is written BEFORE the transaction opens, because it is not
 * transactional and pretending otherwise inside a `withTransaction` block would
 * hold a database connection open across a network round trip to a vendor. The
 * objects are cleaned up explicitly if the transaction then fails.
 */
export async function processUpload(
  deps: UploadsDeps,
  request: UploadRequest,
): Promise<UploadResult> {
  assertWithinUploadSizeLimit(request.bytes.byteLength);

  const thresholds = await uploadThresholds(deps.db);

  // ---- 1. Local gate. No network, no vendor, no cost.
  const verdict = await assessQuality(request.bytes, thresholds);
  if (!verdict.accepted) {
    await recordEvent(deps.db, {
      artworkId: request.artworkId,
      artistId: request.artistId,
      event: "quality_rejected",
      detail: {
        failure: verdict.failure,
        ...(verdict.facts
          ? {
              widthPx: verdict.facts.widthPx,
              heightPx: verdict.facts.heightPx,
              byteLength: verdict.facts.byteLength,
              blurScore: Math.round(verdict.facts.blurScore * 100) / 100,
            }
          : {}),
      },
    });
    throw qualityRejection(verdict);
  }

  const facts = verdict.facts;
  if (facts === null) {
    // Unreachable: `accepted` is only true when facts were read. Stated rather
    // than asserted with `!`, so a future edit that breaks the invariant fails
    // loudly instead of dereferencing null.
    throw AppError.externalFailure("The quality gate accepted an image it could not read.", {
      code: "uploads.quality_gate_inconsistent",
    });
  }

  // ---- 2. One vision call. Taxonomy, colours, safety verdict, description.
  const limits = await listingLimits(deps.db);
  const outcome = await screen(
    deps.vision,
    { bytes: request.bytes, contentType: contentTypeFor(facts.format) },
    thresholds,
    limits,
    retryPolicy(deps),
  );

  // Blocked: refuse the upload outright. Nothing is stored, so there is nothing
  // to clean up and no object in any bucket (SECURITY.md S0-7).
  if (outcome.status === "blocked") {
    await recordEvent(deps.db, {
      artworkId: request.artworkId,
      artistId: request.artistId,
      event: "screening_blocked",
      detail: {
        confidence: outcome.analysis.safety.confidence,
        categories: outcome.analysis.safety.categories,
        threshold: thresholds.safetyConfidenceThreshold,
      },
    });
    throw AppError.validation(
      "התמונה לא עברה את סינון התוכן ולכן לא ניתן להעלות אותה. אם מדובר בטעות, ניתן לפנות לצוות פצ׳קה.",
      {
        code: "uploads.screening_blocked",
        details: { categories: outcome.analysis.safety.categories },
      },
    );
  }

  // ---- 3. Derivatives, then storage. Re-encoded from decoded pixels, so no
  // EXIF or XMP survives, and no watermark is applied.
  const derivatives = await buildDerivatives(request.bytes, thresholds);
  const keys = generateObjectKeys(request.artworkId, extensionFor(facts.format));

  await deps.store.put(ORIGINALS_BUCKET, keys.original, {
    bytes: request.bytes,
    contentType: contentTypeFor(facts.format),
  });
  await deps.store.put(DISPLAY_BUCKET, keys.display, derivatives.display);
  await deps.store.put(DISPLAY_BUCKET, keys.thumbnail, derivatives.thumbnail);

  try {
    return await deps.db.withTransaction(async (tx) => {
      // Recorded BEFORE the attach, because `assertPipelineProduced` reads this
      // event and the attach is the thing it authorises.
      await recordEvent(tx, {
        artworkId: request.artworkId,
        artistId: request.artistId,
        event: "derivatives_stored",
        detail: {
          originalPath: keys.original,
          displayPath: keys.display,
          thumbnailPath: keys.thumbnail,
          format: facts.format,
          widthPx: facts.widthPx,
          heightPx: facts.heightPx,
          displayWidthPx: derivatives.display.widthPx,
          displayHeightPx: derivatives.display.heightPx,
          displayBytes: derivatives.display.bytes.byteLength,
          blurScore: Math.round(facts.blurScore * 100) / 100,
        },
      });

      const image = await attachImage(
        { ...deps.artworks, db: txAsDatabase(deps, tx) },
        request.artistId,
        request.artworkId,
        {
          originalPath: keys.original,
          displayPath: keys.display,
          thumbnailPath: keys.thumbnail,
          altText: request.altText ?? null,
          widthPx: derivatives.display.widthPx,
          heightPx: derivatives.display.heightPx,
        },
      );

      if (outcome.status === "passed") {
        await recordEvent(tx, {
          artworkId: request.artworkId,
          artistId: request.artistId,
          imageId: image.id,
          event: "screening_passed",
          detail: { confidence: outcome.analysis.safety.confidence },
        });

        await recordEvent(tx, {
          artworkId: request.artworkId,
          artistId: request.artistId,
          imageId: image.id,
          event: "suggestions_recorded",
          detail: { suggestions: outcome.analysis.suggestions },
        });

        if (!nothingRejected(outcome.analysis.rejected)) {
          // SECURITY.md S2-20 item 1: a value outside the closed set is dropped
          // AND the drop is recorded. The record is the audit trail for a
          // steering attempt, so it is not conditional on anyone reading it.
          await recordEvent(tx, {
            artworkId: request.artworkId,
            artistId: request.artistId,
            imageId: image.id,
            event: "suggestions_rejected",
            detail: { ...outcome.analysis.rejected },
          });
        }

        return {
          image,
          suggestions: outcome.analysis.suggestions,
          screened: true,
          flaggedForReview: false,
        };
      }

      // Unavailable. The upload lands in the draft; publication does not.
      await recordEvent(tx, {
        artworkId: request.artworkId,
        artistId: request.artistId,
        imageId: image.id,
        event: "screening_unavailable",
        detail: { reason: outcome.reason, attempts: retryPolicy(deps).attempts },
      });

      // The same call carried the analysis, so losing it loses the suggestions
      // too: the artist gets the empty form the spec asks for on analysis
      // failure, and this is recorded as its own event because the two
      // consequences go to two different places -- the artist sees a blank
      // form, the admin sees a queue item.
      await recordEvent(tx, {
        artworkId: request.artworkId,
        artistId: request.artistId,
        imageId: image.id,
        event: "analysis_failed",
        detail: { reason: outcome.reason },
      });

      return {
        image,
        suggestions: emptySuggestions(),
        screened: false,
        flaggedForReview: true,
      };
    });
  } catch (error) {
    // The store is not transactional, so a failed attach would otherwise leave
    // three orphaned objects, one of them in a public bucket.
    await Promise.allSettled([
      deps.store.remove(ORIGINALS_BUCKET, keys.original),
      deps.store.remove(DISPLAY_BUCKET, keys.display),
      deps.store.remove(DISPLAY_BUCKET, keys.thumbnail),
    ]);
    throw error;
  }
}

/**
 * `artworks` takes a `Database`; inside a transaction we have a `Tx`.
 *
 * `shared/db`'s `withTransaction` joins an existing transaction via a savepoint
 * when one is already open on the same async context, so handing the outer
 * `Database` down would in fact do the right thing. This adapter states the
 * intent instead of relying on that: the attach runs on THIS transaction,
 * visibly, and a future change to the nesting behaviour cannot silently split
 * the image row away from its screening verdict.
 */
function txAsDatabase(
  deps: UploadsDeps,
  tx: Parameters<Parameters<UploadsDeps["db"]["withTransaction"]>[0]>[0],
): UploadsDeps["artworks"]["db"] {
  return {
    query: tx.query.bind(tx),
    maybeOne: tx.maybeOne.bind(tx),
    one: tx.one.bind(tx),
    withTransaction: async (fn) => fn(tx),
    end: async () => {
      /* the pool this transaction came from is owned by `deps.db` */
    },
  };
}
