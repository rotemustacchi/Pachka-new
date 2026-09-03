/**
 * The pipeline's thresholds, read from `app_config`.
 *
 * ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
 * through `shared/config`... No magic numbers in module code." upload-pipeline
 * says the same thing in its own words: "Thresholds SHALL be configuration
 * values changeable without a code deployment" -- which is task 4.3, and is
 * satisfied by these keys already existing in the registry and in
 * `20260827T090100_create_app_config.sql`, not by anything this file adds.
 *
 * Read once per upload and passed down, rather than fetched at each use. The
 * difference is not the query count -- `getConfig` caches -- it is that one
 * upload is judged by one consistent set of thresholds, instead of a slow
 * upload straddling an operator's edit and being sized by the old maximum and
 * blurred by the new one.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";

export interface UploadThresholds {
  /** upload-pipeline: reject a shorter edge under this. */
  readonly minShorterEdgePx: number;
  /** upload-pipeline: reject a file smaller than this. */
  readonly minFileSizeBytes: number;
  /** Minimum Laplacian variance. Below it the photograph is out of focus. */
  readonly blurThreshold: number;
  /** At or above this confidence, a safety flag blocks the upload. */
  readonly safetyConfidenceThreshold: number;
  /** Long edge of the public display derivative. */
  readonly maxDisplayDimensionPx: number;
  /** Target size of the display derivative, which sets the encoder quality. */
  readonly displayTargetBytes: number;
}

export async function uploadThresholds(db: Sql): Promise<UploadThresholds> {
  const [
    minShorterEdgePx,
    minFileSizeBytes,
    blurThreshold,
    safetyConfidenceThreshold,
    maxDisplayDimensionPx,
    displayTargetBytes,
  ] = await Promise.all([
    getConfig(db, "upload.min_shorter_edge_px"),
    getConfig(db, "upload.min_file_size_bytes"),
    getConfig(db, "upload.blur_threshold"),
    getConfig(db, "upload.safety_confidence_threshold"),
    getConfig(db, "upload.max_display_dimension_px"),
    getConfig(db, "upload.display_target_bytes"),
  ]);

  return {
    minShorterEdgePx,
    minFileSizeBytes,
    blurThreshold,
    safetyConfidenceThreshold,
    maxDisplayDimensionPx,
    displayTargetBytes,
  };
}

/**
 * The thumbnail's long edge, as a fraction of the display derivative's.
 *
 * Not a config key, and this is the one number in the module where that needs
 * an argument rather than an apology. A separate `upload.thumbnail_dimension_px`
 * could be set larger than `upload.max_display_dimension_px`, at which point the
 * card image is bigger than the detail image and the compression budget is
 * spent backwards. Deriving it makes that unrepresentable. If an operator ever
 * needs to tune it independently, the key to add is a RATIO, so the invariant
 * survives.
 */
export const THUMBNAIL_FRACTION = 0.25;

/** Long edge of the thumbnail, given the configured display dimension. */
export function thumbnailDimension(thresholds: UploadThresholds): number {
  return Math.max(1, Math.round(thresholds.maxDisplayDimensionPx * THUMBNAIL_FRACTION));
}
