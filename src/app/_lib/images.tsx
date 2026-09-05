/**
 * How an artwork image becomes a URL, and how it is rendered.
 *
 * `artworks.ArtworkCard`, `catalog.CatalogView`, `catalog.ArtworkDetailView` and
 * `certificates.CertificateDocument` all take a `renderImage` prop rather than
 * reaching for `next/image` themselves, and every one of them gives the same
 * reason: the loader is configured for the Supabase Storage bucket, which is a
 * deployment decision and therefore the app's. This file is that decision, made
 * once, so the four surfaces cannot disagree about where an image lives.
 *
 * WHAT THE `src` HANDED TO THESE FUNCTIONS ACTUALLY IS
 * ---------------------------------------------------
 * A storage KEY, not a URL: `artwork_images.display_path` /
 * `thumbnail_path` / `original_path`, as `uploads` wrote them. So the loader's
 * whole job is to turn a key into a public URL against the display bucket.
 *
 * WHY THE LOADER IGNORES `width`
 * ------------------------------
 * Because the resizing already happened. `uploads`' pipeline derives a display
 * image and a thumbnail at upload time and stores both, and the views already
 * choose between them — `ArtworkDetailView` asks for `thumbnailPath` for the
 * strip and `displayPath` for the hero. Asking the storage layer for a third
 * size at request time would either need Supabase's image-transformation
 * endpoint (a plan-dependent feature, so a broken image where it is absent) or
 * silently serve the same bytes anyway.
 *
 * So PACHKA optimises at upload, not per request, and this loader says so by
 * returning one URL per key. That is not the same thing as falling back to a
 * bare `<img>`, which is what `ArtworkCard` warns against: the derivative being
 * served is already the small one.
 *
 * ORIGINALS ARE NOT REACHABLE FROM HERE. `ORIGINALS_BUCKET` is deliberately not
 * imported. The originals bucket holds the artist's full-resolution file, and
 * the public read path is the display bucket only.
 */
import Image from "next/image";
import type { ReactNode } from "react";
import { publicEnv } from "@/shared/config";
import { DISPLAY_BUCKET } from "@/modules/uploads";

/**
 * A storage key to its public URL.
 *
 * An `http`-prefixed value is passed through untouched, so a seeded fixture or
 * a future CDN-hosted path keeps working without a second code path.
 */
export function storageUrl(key: string): string {
  if (key.startsWith("http://") || key.startsWith("https://")) return key;

  const base = publicEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
  const path = key.replace(/^\/+/, "");
  return `${base}/storage/v1/object/public/${DISPLAY_BUCKET}/${path}`;
}

/** The `next/image` loader. See the header for why `width` is not used. */
export function artworkImageLoader({ src }: { readonly src: string }): string {
  return storageUrl(src);
}

/**
 * A card image.
 *
 * Explicit `width`/`height` rather than `fill`, because `fill` needs the
 * nearest positioned ancestor to be the image box — and in `ArtworkCard` the
 * positioned ancestor is the whole `Card`, so a filled image would cover the
 * title and the price. The intrinsic numbers are the 4:5 ratio the card's own
 * container states; CSS decides the displayed size.
 */
export function renderCardImage({ src, alt }: { readonly src: string; readonly alt: string }): ReactNode {
  return (
    <Image
      loader={artworkImageLoader}
      src={src}
      alt={alt}
      width={480}
      height={600}
      className="h-full w-full object-cover"
    />
  );
}

/**
 * A detail-page image.
 *
 * `primary` is the hero; everything else is a thumbnail in the strip beneath
 * it. Only the hero is `priority` — it is the largest contentful paint on the
 * page, and marking five images priority marks none of them.
 */
export function renderDetailImage({
  src,
  alt,
  primary,
}: {
  readonly src: string;
  readonly alt: string;
  readonly primary: boolean;
}): ReactNode {
  return (
    <Image
      loader={artworkImageLoader}
      src={src}
      alt={alt}
      width={primary ? 900 : 200}
      height={primary ? 1125 : 250}
      priority={primary}
      className="h-auto w-full object-cover"
    />
  );
}

/**
 * The certificate's image of the work.
 *
 * Smaller and never `priority`: the document's headline is its declaration
 * text, not the picture.
 */
export function renderCertificateImage({
  src,
  alt,
}: {
  readonly src: string;
  readonly alt: string;
}): ReactNode {
  return (
    <Image
      loader={artworkImageLoader}
      src={src}
      alt={alt}
      width={480}
      height={600}
      className="h-auto w-full object-cover"
    />
  );
}
