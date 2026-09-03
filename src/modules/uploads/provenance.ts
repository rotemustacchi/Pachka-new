/**
 * "This object came from the pipeline" -- checkable, rather than asserted.
 *
 * SECURITY.md S1-15 item 4: "Attaching an image to an artwork requires that the
 * object was produced by the pipeline in this session -- a pipeline-issued
 * token or a pipeline-owned row, not a client-supplied storage path."
 *
 * `artworks.attachImage` says in its own header that it deliberately does not
 * check this: it verifies the path sits under the artwork's prefix and leaves
 * provenance to us, because `upload_events` is our table and the question is
 * ours to answer. This file is that answer, and it is the pipeline-owned-row
 * form rather than the token form -- a token is a second thing to issue, store
 * and expire, and the row already exists because the pipeline records what it
 * wrote.
 *
 * The attack it forecloses: an artist calls the attach endpoint with a storage
 * path they chose, and the quality gate, the safety screening, the EXIF
 * stripping and the re-encode all happened on a different file, or on no file
 * at all.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";

/**
 * True when this exact path was written by this pipeline for this artwork.
 *
 * Matched against the `derivatives_stored` event's recorded paths rather than
 * against the storage bucket's contents: the bucket answers "does an object
 * exist here", which is precisely the question an attacker who put one there
 * would like asked.
 */
export async function isPipelineProduced(
  sql: Sql,
  artworkId: string,
  path: string,
): Promise<boolean> {
  const row = await sql.maybeOne<{ found: boolean }>(
    `select true as found
       from upload_events
      where artwork_id = $1
        and event = 'derivatives_stored'
        and (
          detail ->> 'originalPath'  = $2 or
          detail ->> 'displayPath'   = $2 or
          detail ->> 'thumbnailPath' = $2
        )
      limit 1`,
    [artworkId, path],
  );
  return row?.found === true;
}

/**
 * Refuse a path the pipeline did not produce.
 *
 * `forbidden`, matching what `artworks.attachImage` raises for a path outside
 * the artwork's prefix: both are "you may not attach this", and a caller
 * handling one should handle the other the same way.
 */
export async function assertPipelineProduced(
  sql: Sql,
  artworkId: string,
  paths: readonly string[],
): Promise<void> {
  const strays: string[] = [];
  for (const path of paths) {
    if (!(await isPipelineProduced(sql, artworkId, path))) strays.push(path);
  }

  if (strays.length > 0) {
    throw AppError.forbidden(
      "ניתן לצרף ליצירה רק קבצים שנוצרו בתהליך ההעלאה עצמו.",
      {
        code: "uploads.path_not_produced_by_pipeline",
        details: { artworkId, strays },
      },
    );
  }
}
