/**
 * The local technical gate. Everything that can be decided without spending
 * money, decided before any money is spent.
 *
 * upload-pipeline, "Technical quality gate": reject a shorter edge under the
 * configured minimum, a file under the configured minimum size, or a blur score
 * below the configured threshold, and say which check failed and what the
 * artist can do about it.
 *
 * WHY THE ORDER MATTERS
 * ---------------------
 * The change proposal's cost constraint is that AI spend scales with the number
 * of ARTWORKS, never with traffic. A rejected image must therefore cost nothing:
 * an attacker (or an artist with a large folder of snapshots) who can make the
 * pipeline call a vision model before deciding the image is unusable has turned
 * a quality gate into a billing endpoint. So `assessQuality` performs no I/O
 * beyond decoding the bytes it was handed, and `pipeline.ts` calls it first --
 * with an integration test asserting that a rejected image reaches a vision
 * analyst that would throw if it were ever called.
 *
 * BLUR
 * ----
 * Variance of the Laplacian, the standard focus measure: convolve the greyscale
 * image with a discrete Laplacian kernel and take the variance of the response.
 * A sharp photograph has strong edges, so the second derivative has a wide
 * spread; a blurred one has almost none, so the response clusters near zero.
 *
 * Measured at a NORMALISED SIZE (long edge `BLUR_SAMPLE_EDGE_PX`) rather than
 * at native resolution, and this is load-bearing rather than an optimisation.
 * Laplacian variance is scale-dependent: the same photograph downsampled by
 * half has meaningfully different variance, because the same edge now spans
 * fewer pixels. Measuring at native resolution would make one configured
 * threshold mean different things for a 1200px phone photo and a 6000px camera
 * file, and would quietly reject the careful artist with the better camera.
 */
import sharp from "sharp";
import type { Metadata, OutputInfo } from "sharp";
import { AppError } from "@/shared/errors";
import type { UploadThresholds } from "./config";
import { isAcceptedFormat, type AcceptedFormat } from "./formats";

/** Long edge the blur measurement is taken at. See the header. */
export const BLUR_SAMPLE_EDGE_PX = 800;

export interface ImageFacts {
  readonly format: AcceptedFormat;
  /** Pixel dimensions AFTER EXIF orientation is applied. See `orientedSize`. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly byteLength: number;
  /** Variance of the Laplacian at the normalised sample size. */
  readonly blurScore: number;
}

/** Which check failed, so the message can say what to do about it. */
export type QualityFailure =
  | "unreadable"
  | "unsupported_format"
  | "resolution"
  | "file_size"
  | "blur";

export interface QualityVerdict {
  readonly accepted: boolean;
  readonly facts: ImageFacts | null;
  readonly failure: QualityFailure | null;
  /** Hebrew, shown to the artist. Names the check and the remedy. */
  readonly message: string | null;
}

/**
 * Dimensions as a viewer sees them.
 *
 * `sharp`'s `width`/`height` are the stored dimensions, before the EXIF
 * orientation tag is applied. A portrait phone photograph is very often stored
 * landscape with orientation 6, so reading the raw pair would judge the shorter
 * edge of a 4032x3024-stored, 3024x4032-displayed image as 3024 in one place
 * and 4032 in another. Orientations 5-8 are the transposing quarter turns.
 */
export function orientedSize(
  width: number,
  height: number,
  orientation: number | undefined,
): { readonly widthPx: number; readonly heightPx: number } {
  const transposed = orientation !== undefined && orientation >= 5 && orientation <= 8;
  return transposed
    ? { widthPx: height, heightPx: width }
    : { widthPx: width, heightPx: height };
}

/**
 * Variance of the Laplacian over a greyscale byte plane.
 *
 * Exported because it is the one piece of arithmetic here that is worth testing
 * on its own: a flat plane must score zero and a hard edge must not, and that
 * is checkable without an image file.
 */
export function laplacianVariance(
  plane: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;

  // The 4-neighbour discrete Laplacian: 4*centre - up - down - left - right.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const response =
        4 * (plane[i] as number) -
        (plane[i - width] as number) -
        (plane[i + width] as number) -
        (plane[i - 1] as number) -
        (plane[i + 1] as number);
      sum += response;
      sumOfSquares += response * response;
      count += 1;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumOfSquares / count - mean * mean;
}

/**
 * Read the facts a quality decision needs out of the bytes.
 *
 * Rejects with `unreadable` rather than throwing on a file that is not an
 * image, because "this is not a photograph" is an artist-facing answer, not an
 * internal error.
 */
export type DecodeFailure = Extract<QualityFailure, "unreadable" | "unsupported_format">;

export async function readImageFacts(bytes: Uint8Array): Promise<ImageFacts | DecodeFailure> {
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    return "unreadable";
  }

  if (!isAcceptedFormat(metadata.format)) return "unsupported_format";
  if (metadata.width === undefined || metadata.height === undefined) return "unreadable";

  const { widthPx, heightPx } = orientedSize(metadata.width, metadata.height, metadata.orientation);

  // `.rotate()` with no argument bakes in the EXIF orientation, so the plane the
  // blur is measured on is the image as it will be displayed. `.greyscale()`
  // before `.raw()` gives one byte per pixel and one channel to convolve.
  let plane: { data: Buffer; info: OutputInfo };
  try {
    plane = await sharp(bytes, { failOn: "error" })
      .rotate()
      .resize({
        width: BLUR_SAMPLE_EDGE_PX,
        height: BLUR_SAMPLE_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return "unreadable";
  }

  return {
    format: metadata.format,
    widthPx,
    heightPx,
    byteLength: bytes.byteLength,
    blurScore: laplacianVariance(plane.data, plane.info.width, plane.info.height),
  };
}

/**
 * The gate itself. Pure, given the facts and the thresholds.
 *
 * Reports the FIRST failing check rather than all of them, unlike
 * `artworks.missingForPublication`, and the difference is deliberate: a
 * publication survey is a form the artist fills in, where every gap at once
 * saves round trips, whereas this is one file that either is or is not usable
 * and the remedy for each failure is "take a different photograph". Telling
 * someone their photograph is both too small and too blurry does not help them
 * more than telling them it is too small.
 */
export function judge(facts: ImageFacts, thresholds: UploadThresholds): QualityVerdict {
  const shorterEdge = Math.min(facts.widthPx, facts.heightPx);

  if (shorterEdge < thresholds.minShorterEdgePx) {
    return {
      accepted: false,
      facts,
      failure: "resolution",
      message:
        `רזולוציה נמוכה מדי: הצלע הקצרה היא ${shorterEdge} פיקסלים ונדרשות לפחות ` +
        `${thresholds.minShorterEdgePx}. יש לצלם מחדש ברזולוציה גבוהה יותר.`,
    };
  }

  if (facts.byteLength < thresholds.minFileSizeBytes) {
    return {
      accepted: false,
      facts,
      failure: "file_size",
      message:
        `הקובץ קטן מדי (${facts.byteLength} בתים) ונדרשים לפחות ` +
        `${thresholds.minFileSizeBytes}. יש להעלות את הקובץ המקורי ולא צילום מסך או תמונה דחוסה.`,
    };
  }

  if (facts.blurScore < thresholds.blurThreshold) {
    return {
      accepted: false,
      facts,
      failure: "blur",
      message: "התמונה אינה חדה מספיק. יש לצלם שוב במיקוד טוב יותר ובתאורה מספקת.",
    };
  }

  return { accepted: true, facts, failure: null, message: null };
}

const FAILURE_MESSAGES: Readonly<Record<DecodeFailure, string>> = {
  unreadable: "לא הצלחנו לקרוא את הקובץ. יש להעלות קובץ תמונה תקין.",
  unsupported_format: "סוג הקובץ אינו נתמך. ניתן להעלות JPEG, PNG, WebP, HEIC או AVIF.",
};

/** Decode and judge in one step. No network, no paid call, no I/O. */
export async function assessQuality(
  bytes: Uint8Array,
  thresholds: UploadThresholds,
): Promise<QualityVerdict> {
  const facts = await readImageFacts(bytes);
  if (typeof facts === "string") {
    return {
      accepted: false,
      facts: null,
      failure: facts,
      message: FAILURE_MESSAGES[facts],
    };
  }
  return judge(facts, thresholds);
}

/** The verdict as the error the route returns. */
export function qualityRejection(verdict: QualityVerdict): AppError {
  return AppError.validation(verdict.message ?? "התמונה לא עברה את בדיקת האיכות", {
    code: `uploads.quality_${verdict.failure ?? "failed"}`,
    details: {
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
}
