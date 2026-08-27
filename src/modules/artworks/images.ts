/**
 * `artwork_images`, which artworks owns and `uploads` writes through.
 *
 * ARCHITECTURE.md: "A module owns its own tables. No module writes another
 * module's tables. Cross-module effects go through the owning module's public
 * API." The upload pipeline produces the bytes, the derivatives and the
 * technical verdict; it calls `attachImage` to record where they landed.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not validate that the object at `originalPath` exists, that it came
 * from the pipeline, or that it passed safety screening. Those are `uploads`'
 * responsibility and SECURITY.md S2-24 is explicit about the shape of the
 * defence: object keys are server-generated as `${artworkId}/${uuid}.${ext}`,
 * the browser never writes to the artwork bucket at all, and attaching requires
 * that the object was produced by the pipeline itself. What this file enforces
 * is the part it can see -- that the path is inside the artwork's own prefix --
 * so that a bug in the caller cannot attach artist B's object to artist A's
 * artwork even if every other check upstream were bypassed.
 */
import { z } from "zod";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { explainFindings, scanForContactDetails } from "@/modules/accounts";
import type { ArtworksDeps } from "./deps";
import { MAX_IMAGES_PER_ARTWORK } from "./limits";
import type { PublicArtworkImage } from "./serialize";

export interface ArtworkImage {
  readonly id: string;
  readonly artworkId: string;
  readonly originalPath: string;
  readonly displayPath: string | null;
  readonly thumbnailPath: string | null;
  readonly altText: string | null;
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly position: number;
  /** Position 0. `uploads` recomputes the embedding only when this changes. */
  readonly isPrimary: boolean;
}

interface ImageRow {
  readonly id: string;
  readonly artwork_id: string;
  readonly original_path: string;
  readonly display_path: string | null;
  readonly thumbnail_path: string | null;
  readonly alt_text: string | null;
  readonly width_px: number | null;
  readonly height_px: number | null;
  readonly position: number;
}

const IMAGE_COLUMNS =
  "id, artwork_id, original_path, display_path, thumbnail_path, alt_text, width_px, height_px, position";

function toImage(row: ImageRow): ArtworkImage {
  return {
    id: row.id,
    artworkId: row.artwork_id,
    originalPath: row.original_path,
    displayPath: row.display_path,
    thumbnailPath: row.thumbnail_path,
    altText: row.alt_text,
    widthPx: row.width_px,
    heightPx: row.height_px,
    position: row.position,
    isPrimary: row.position === 0,
  };
}

export interface AttachImageInput {
  readonly originalPath: string;
  readonly displayPath?: string | null;
  readonly thumbnailPath?: string | null;
  readonly altText?: string | null;
  readonly widthPx?: number | null;
  readonly heightPx?: number | null;
}

const Path = z.string().trim().min(1).max(500);
const AttachSchema = z.object({
  originalPath: Path,
  displayPath: Path.nullish(),
  thumbnailPath: Path.nullish(),
  altText: z.string().trim().max(300).nullish(),
  widthPx: z.number().int().positive().nullish(),
  heightPx: z.number().int().positive().nullish(),
});

/**
 * Every path must sit under the artwork's own prefix.
 *
 * SECURITY.md S2-24: keys are `${artworkId}/${randomUUID()}.${ext}`, and the
 * storage policies predicate on ownership of the artwork named by the first
 * path segment. Checking it here as well means the database row and the storage
 * object agree about which artwork owns the bytes -- if they disagreed, the
 * storage policy would be guarding one artwork while the page rendered another.
 */
function assertWithinArtworkPrefix(artworkId: string, paths: readonly (string | null | undefined)[]): void {
  const prefix = `${artworkId}/`;
  const strays = paths.filter((path): path is string => typeof path === "string" && !path.startsWith(prefix));

  if (strays.length > 0) {
    throw AppError.forbidden(
      `Image paths must sit under this artwork's own prefix "${prefix}"; refused ${strays.join(", ")}. ` +
        "Object keys are server-generated (SECURITY.md S2-24).",
      { code: "artworks.image_path_outside_prefix", details: { artworkId, strays } },
    );
  }
}

/**
 * Record an image against an artwork.
 *
 * Appends at the next free position, so the first image attached becomes the
 * primary one without the caller having to say so, and a second attach cannot
 * silently displace it. Changing which image is primary is a separate,
 * deliberate call.
 *
 * The whole thing runs in one transaction with the next-position read, because
 * two uploads finishing at the same moment would otherwise both compute the
 * same next position and one would lose to the unique constraint.
 */
export async function attachImage(
  deps: ArtworksDeps,
  artistId: string,
  artworkId: string,
  input: AttachImageInput,
): Promise<ArtworkImage> {
  const parsed = AttachSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (fields[issue.path.join(".") || "input"] ??= []).push(issue.message);
    }
    throw AppError.fieldsInvalid(fields, { code: "artworks.invalid_image_input" });
  }
  const value = parsed.data;

  // Alt text is artist-written and rendered on a public page, so it goes
  // through the same scanner as the title and the description (SECURITY.md
  // S2-19). An alt attribute is a particularly quiet place to put a phone
  // number: sighted buyers never see it and it is in the served HTML.
  if (value.altText) {
    const findings = scanForContactDetails(value.altText);
    if (findings.length > 0) {
      throw AppError.fieldsInvalid(
        { altText: [explainFindings(findings)] },
        { code: "artworks.contact_details_not_permitted" },
      );
    }
  }

  assertWithinArtworkPrefix(artworkId, [value.originalPath, value.displayPath, value.thumbnailPath]);

  return deps.db.withTransaction(async (tx) => {
    const owned = await tx.maybeOne<{ id: string }>(
      "select id from artworks where id = $1 and artist_id = $2 for update",
      [artworkId, artistId],
    );
    if (owned === null) {
      throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
    }

    const next = await tx.one<{ next_position: number; total: string }>(
      `select coalesce(max(position) + 1, 0) as next_position, count(*)::text as total
         from artwork_images where artwork_id = $1`,
      [artworkId],
    );

    if (Number(next.total) >= MAX_IMAGES_PER_ARTWORK) {
      throw AppError.validation(
        `An artwork may carry at most ${MAX_IMAGES_PER_ARTWORK} images.`,
        { code: "artworks.too_many_images", details: { max: MAX_IMAGES_PER_ARTWORK } },
      );
    }

    const row = await tx.one<ImageRow>(
      `insert into artwork_images
         (artwork_id, original_path, display_path, thumbnail_path, alt_text, width_px, height_px, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${IMAGE_COLUMNS}`,
      [
        artworkId,
        value.originalPath,
        value.displayPath ?? null,
        value.thumbnailPath ?? null,
        value.altText ?? null,
        value.widthPx ?? null,
        value.heightPx ?? null,
        next.next_position,
      ],
    );

    return toImage(row);
  });
}

/** Images for one artwork, primary first. */
export async function imagesFor(sql: Sql, artworkId: string): Promise<readonly ArtworkImage[]> {
  const { rows } = await sql.query<ImageRow>(
    `select ${IMAGE_COLUMNS} from artwork_images where artwork_id = $1 order by position`,
    [artworkId],
  );
  return rows.map(toImage);
}

/**
 * Make an image the primary one.
 *
 * Swaps positions rather than renumbering everything, and does it via a
 * temporary negative position because `(artwork_id, position)` is unique and a
 * direct swap collides halfway through. Negative rather than "max + 1" so the
 * intermediate value can never be mistaken for a real slot if the transaction
 * is inspected mid-flight.
 *
 * upload-pipeline recomputes the embedding when the primary image changes, so
 * the caller is expected to act on the returned value.
 */
export async function setPrimaryImage(
  deps: ArtworksDeps,
  artistId: string,
  artworkId: string,
  imageId: string,
): Promise<readonly ArtworkImage[]> {
  return deps.db.withTransaction(async (tx) => {
    const owned = await tx.maybeOne<{ id: string }>(
      "select id from artworks where id = $1 and artist_id = $2 for update",
      [artworkId, artistId],
    );
    if (owned === null) {
      throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
    }

    const target = await tx.maybeOne<{ position: number }>(
      "select position from artwork_images where id = $1 and artwork_id = $2",
      [imageId, artworkId],
    );
    if (target === null) {
      throw AppError.notFound("Image not found", { code: "artworks.image_not_found" });
    }
    if (target.position === 0) return imagesFor(tx, artworkId);

    await tx.query("update artwork_images set position = -1 where id = $1", [imageId]);
    await tx.query(
      "update artwork_images set position = $2 where artwork_id = $1 and position = 0",
      [artworkId, target.position],
    );
    await tx.query("update artwork_images set position = 0 where id = $1", [imageId]);

    return imagesFor(tx, artworkId);
  });
}

/**
 * Shape images for a buyer.
 *
 * `displayPath` falls back to the original only when no derivative exists yet.
 * upload-pipeline requires the original to be "retained unserved", so that
 * fallback is a transitional state, not a design: an artwork whose derivative
 * generation failed still renders rather than showing a broken image, and the
 * pipeline backfills.
 */
export function toPublicImages(images: readonly ArtworkImage[]): readonly PublicArtworkImage[] {
  return images.map((image) => ({
    id: image.id,
    displayPath: image.displayPath ?? image.originalPath,
    thumbnailPath: image.thumbnailPath,
    altText: image.altText,
    isPrimary: image.isPrimary,
  }));
}
