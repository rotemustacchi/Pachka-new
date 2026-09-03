/**
 * /studio/artworks/[artworkId] — the artwork upload form.
 *
 * Task 3.3's tail. The route reads the session, loads the artist's own artwork,
 * and renders the module's form. Every rule lives in `artworks`.
 *
 * `findOwnArtwork` answers `not_found` for an artwork belonging to somebody
 * else, and this route turns that into the same 404 a genuinely absent id gets.
 * That is the module's decision, not a softening of it: SECURITY.md S3-29 says
 * identifiers must not be a directory, and "this one is not yours" is a lookup
 * oracle. Distinguishing the two here would undo the module's care.
 *
 * A visitor who is not signed in is redirected to sign in, because the studio
 * is a surface every artist knows exists.
 */
import { notFound } from "next/navigation";
import { isAppError } from "@/shared/errors";
import {
  ARTWORK_STATUS_LABELS,
  findOwnArtwork,
  imagesFor,
  listingLimits,
  type ArtworkWithAvailability,
} from "@/modules/artworks";
import { currentUserId, signedInOrRedirect } from "../../../_lib/viewer";
import { artworksDeps } from "../../deps";
import { UploadForm } from "./UploadForm";
import { valuesOf } from "./values";

export const dynamic = "force-dynamic";

export const metadata = { title: "עריכת יצירה — פאצ׳קה" };

interface PageProps {
  readonly params: Promise<{ readonly artworkId: string }>;
}

export default async function ArtworkEditorPage({ params }: PageProps) {
  const { artworkId } = await params;
  const artistId = signedInOrRedirect(await currentUserId());

  // A malformed id is a 404, not a 500: Postgres raises a type error on a
  // non-uuid, and an error page that differs from the not-found page is another
  // way to tell a prober they got the shape right.
  if (!/^[0-9a-f-]{36}$/i.test(artworkId)) notFound();

  const deps = artworksDeps();

  let found: ArtworkWithAvailability;
  try {
    found = await findOwnArtwork(deps, artistId, artworkId);
  } catch (error) {
    if (isAppError(error) && error.kind === "not_found") notFound();
    throw error;
  }

  const { artwork } = found;
  const [images, limits] = await Promise.all([
    imagesFor(deps.db, artworkId),
    listingLimits(deps.db),
  ]);

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-6 py-12 sm:px-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="m-0 text-[34px] font-black tracking-[-.015em]">
          {artwork.title ?? "יצירה חדשה"}
        </h1>
        <span className="text-sm text-ink-muted">{ARTWORK_STATUS_LABELS[artwork.status]}</span>
      </div>

      <p className="m-0 max-w-[640px] text-[15px] font-light text-ink-soft">
        מלאו את הפרטים בקצב שלכם. אפשר לשמור טיוטה חלקית ולחזור אליה — הפרסום נפתח רק כשכל שדות
        החובה מלאים.
      </p>

      <UploadForm
        artworkId={artwork.id}
        initialValues={valuesOf(artwork)}
        images={images.map((image) => ({
          id: image.id,
          altText: image.altText,
          isPrimary: image.isPrimary,
        }))}
        limits={limits}
        editable={artwork.status !== "removed" && artwork.status !== "sold"}
        statusLabel={ARTWORK_STATUS_LABELS[artwork.status]}
      />
    </div>
  );
}
