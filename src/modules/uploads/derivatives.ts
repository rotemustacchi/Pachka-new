/**
 * Producing what a buyer actually downloads.
 *
 * upload-pipeline, "Image storage and delivery": store an optimised,
 * size-limited derivative and retain the original; serve nothing larger than
 * the configured maximum display dimension; apply NO watermark; and strip all
 * EXIF and XMP from every served derivative, GPS above all.
 *
 * THE METADATA RULE, AND THE ONE LINE THAT BREAKS IT
 * -------------------------------------------------
 * SECURITY.md S1-9: artists photograph their work in the studio, which is
 * usually their home, so `GPSLatitude`/`GPSLongitude` in a phone photograph
 * locate the artist to within metres -- more precisely than the street address
 * this platform already refuses to disclose. `Artist`, `Copyright` and
 * `XPAuthor` routinely carry a full legal name and sometimes a phone number.
 *
 * `sharp` strips metadata by default. The trap is `.withMetadata()`, which is
 * what everybody reaches for the first time an image comes out rotated -- and
 * which re-attaches EVERYTHING, GPS included. The correct fix for orientation
 * is `.rotate()` with no argument: it bakes the orientation into the pixels and
 * drops the tag. So:
 *
 *     NEVER call .withMetadata(), .keepMetadata(), .keepExif() or .keepXmp()
 *     in this module. `no-metadata-passthrough.test.ts` reads this directory
 *     and fails if any of them appears.
 *
 * The re-encode is from decoded pixels in every case (`.rotate()` forces a
 * decode, and the output format is always WebP regardless of the input), which
 * S1-9 item 1 asks for on its own account: it destroys any payload embedded in
 * the container as a side effect of not copying the container at all.
 *
 * NO WATERMARK
 * ------------
 * upload-pipeline: "Displayed images SHALL NOT carry a watermark." This is a
 * product decision, not an oversight, and it is stated here because a
 * watermark is the thing somebody adds to this file later without thinking of
 * it as a spec change. There is no compositing step below and no place to put
 * one; `no-watermark.test.ts` asserts the derivative's pixels are the source's
 * pixels, resized, and nothing else.
 */
import sharp from "sharp";
import type { UploadThresholds } from "./config";
import { thumbnailDimension } from "./config";
import { DERIVATIVE_CONTENT_TYPE, DERIVATIVE_FORMAT } from "./formats";
import type { StoredObject } from "./ports";

export interface Derivative extends StoredObject {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface Derivatives {
  /** What the artwork detail page shows. */
  readonly display: Derivative;
  /** What a catalog card shows. */
  readonly thumbnail: Derivative;
}

/**
 * WebP quality for the display derivative.
 *
 * `upload.display_target_bytes` states the size we are aiming at; this is the
 * starting quality, stepped down until the result fits. Encoding twice for a
 * large photograph is cheaper than serving a 900 KB card image forever, and it
 * is the only way "no larger than the configured target" is a fact rather than
 * a hope -- a fixed quality produces wildly different sizes for a flat
 * minimalist canvas and a densely textured one.
 */
const QUALITY_LADDER = [82, 72, 62, 52, 42] as const;

async function encode(
  bytes: Uint8Array,
  longEdgePx: number,
  quality: number,
): Promise<Derivative> {
  const { data, info } = await sharp(bytes, { failOn: "error" })
    // Bakes EXIF orientation into the pixels and drops the tag. NOT
    // `.withMetadata()`, which would put the whole EXIF block back.
    .rotate()
    .resize({
      width: longEdgePx,
      height: longEdgePx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toFormat(DERIVATIVE_FORMAT, { quality, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(data),
    contentType: DERIVATIVE_CONTENT_TYPE,
    widthPx: info.width,
    heightPx: info.height,
  };
}

/**
 * Encode at the highest quality on the ladder that fits the byte target.
 *
 * Falls through to the lowest rung rather than failing: a derivative slightly
 * over target is a page that loads a little slower, and refusing to produce one
 * would mean an artwork with no image at all.
 */
async function encodeWithinBudget(
  bytes: Uint8Array,
  longEdgePx: number,
  targetBytes: number,
): Promise<Derivative> {
  let last: Derivative | null = null;
  for (const quality of QUALITY_LADDER) {
    const candidate = await encode(bytes, longEdgePx, quality);
    if (candidate.bytes.byteLength <= targetBytes) return candidate;
    last = candidate;
  }
  // Unreachable unless the ladder is empty; typed rather than asserted.
  return last ?? (await encode(bytes, longEdgePx, QUALITY_LADDER[QUALITY_LADDER.length - 1] ?? 42));
}

export async function buildDerivatives(
  bytes: Uint8Array,
  thresholds: UploadThresholds,
): Promise<Derivatives> {
  const display = await encodeWithinBudget(
    bytes,
    thresholds.maxDisplayDimensionPx,
    thresholds.displayTargetBytes,
  );

  // The thumbnail is encoded from the ORIGINAL bytes, not from the display
  // derivative. Re-encoding an already-lossy WebP compounds its artefacts, and
  // the card image is the first thing a buyer sees.
  const thumbnail = await encode(bytes, thumbnailDimension(thresholds), 78);

  return { display, thumbnail };
}
