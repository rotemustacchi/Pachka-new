/**
 * What an uploaded file is allowed to be, decided by its bytes.
 *
 * SECURITY.md S1-15 item 2: object keys are `${artworkId}/${randomUUID()}.${ext}`
 * "where `ext` is derived from the sniffed format, not the filename. The
 * original filename may be stored as a display-only column after sanitisation;
 * it never enters a path." So nothing here reads a filename, and there is no
 * function in this module that turns one into an extension.
 *
 * The set is closed for the same reason the artwork taxonomy is closed: an
 * open-ended list of decoders is an open-ended list of decoder bugs, and
 * `sharp` will happily decode formats (SVG above all -- it is a document
 * format with script in it) that have no business being an artwork photograph.
 */
import { AppError } from "@/shared/errors";

/** The formats `sharp` reports that this module accepts. */
export const ACCEPTED_FORMATS = ["jpeg", "png", "webp", "heif", "avif"] as const;
export type AcceptedFormat = (typeof ACCEPTED_FORMATS)[number];

/**
 * File extension per sniffed format. Never derived from the uploaded filename.
 *
 * `heif` covers HEIC, which is what an iPhone produces by default and therefore
 * what a large share of artists will upload.
 */
const EXTENSION: Readonly<Record<AcceptedFormat, string>> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  heif: "heic",
  avif: "avif",
};

const CONTENT_TYPE: Readonly<Record<AcceptedFormat, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heif: "image/heic",
  avif: "image/avif",
};

export function isAcceptedFormat(format: string | undefined): format is AcceptedFormat {
  return (ACCEPTED_FORMATS as readonly string[]).includes(format ?? "");
}

export function extensionFor(format: AcceptedFormat): string {
  return EXTENSION[format];
}

export function contentTypeFor(format: AcceptedFormat): string {
  return CONTENT_TYPE[format];
}

/**
 * The largest file the pipeline will decode.
 *
 * A hard ceiling rather than an `app_config` value, deliberately: it exists to
 * bound how much memory one request can make the server allocate before any
 * check has run, so an operator must not be able to raise it from an admin
 * screen. The configurable end of the range -- the MINIMUM size, below which an
 * image is too small to be a usable photograph -- is `upload.min_file_size_bytes`
 * and does live in `app_config`, because that one is a quality judgement.
 *
 * 40 MB comfortably holds a 24-megapixel HEIC or a 12-bit TIFF-ish JPEG from a
 * full-frame camera, which is the largest thing an artist plausibly photographs
 * their own work with.
 */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/**
 * The display derivative's format. WebP for every input, including PNG.
 *
 * Re-encoding to one format is not a compression preference, it is the
 * metadata control: SECURITY.md S1-9 item 1 requires "a full re-encode from
 * decoded pixels -- which incidentally destroys any embedded payload". Passing
 * a PNG through as a PNG would leave the door open to a passthrough
 * optimisation that preserved ancillary chunks, `eXIf` and `iTXt` among them.
 */
export const DERIVATIVE_FORMAT = "webp" as const;
export const DERIVATIVE_CONTENT_TYPE = "image/webp";
export const DERIVATIVE_EXTENSION = "webp";

export function assertWithinUploadSizeLimit(byteLength: number): void {
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw AppError.validation(
      `הקובץ גדול מדי. הגודל המרבי הוא ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} מגה-בייט.`,
      {
        code: "uploads.file_too_large",
        details: { byteLength, maxBytes: MAX_UPLOAD_BYTES },
      },
    );
  }
}
