/**
 * /artworks/[artworkId] — the artwork detail page.
 *
 * catalog-browse requires this page to carry, in one place: all images, the
 * full specification set, the taxonomy classification, the artist's display
 * name linking to their profile, availability, an estimated shipping cost range
 * and the return policy summary. That list is not a wish list. The MVP has no
 * buyer-to-artist messaging, so a buyer who cannot find the dimensions here
 * cannot find them anywhere, and therefore cannot buy — the specification set
 * is load-bearing, not decoration.
 *
 * WHAT THIS ROUTE COMPOSES, AND WHY IT IS THE ONE DOING IT
 * -------------------------------------------------------
 * `catalog` may call `artworks` and `accounts` and nothing else. Three of the
 * things the page needs belong to modules it may not import, so all three
 * arrive as props built here:
 *
 *   • `returnTerms`  — `shipping.returnTerms(db)`. Handed straight across: its
 *     `ReturnTerms` is assignable to `CatalogReturnTerms` as it stands, so
 *     there is no adapter and nothing to keep in step.
 *   • `shippingRange` — derived from `shipping`'s rate table; see `_shipping/range.ts`.
 *   • `purchaseAction` — `orders` owns the cart. Passed UNCONDITIONALLY: the
 *     view renders the slot only when the artwork is purchasable, so the check
 *     is in one place and a route cannot forget it.
 *
 * WHAT THIS ROUTE DOES NOT DECIDE
 * -------------------------------
 * Visibility. `findCatalogArtwork` raises `not_found` for a draft, a removed
 * artwork and a suspended artist's work, and resolves sold and unlisted ones so
 * they render read-only — which is the split catalog-browse asks for, stated
 * once inside the module rather than copied onto this side of the boundary.
 * This route turns every one of those into the same 404, for the reason the
 * artist route gives: three different answers would be an enumeration oracle.
 *
 * `reportHref` is deliberately absent. design/Artwork.dc.html does show a
 * "דיווח על היצירה" link and `moderation.fileReport` is ready for it, but the
 * public reporting ROUTE does not exist yet, and the view omits the link when
 * the prop is. A link to a 404 is worse than no link. Reported upstream.
 */
import { notFound } from "next/navigation";
import { ArtworkDetailView, findCatalogArtwork } from "@/modules/catalog";
import { isAppError } from "@/shared/errors";
import { getDatabase } from "@/shared/db";
import { catalogDeps } from "@/app/_lib/deps";
import { renderDetailImage } from "@/app/_lib/images";
import { loadReturnTerms } from "@/app/_shipping/load";
import { shippingRangeFor } from "@/app/_shipping/range";
import { AddToCartForm } from "@/app/_cart/AddToCartForm";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly artworkId: string }>;
}

export default async function ArtworkPage({ params }: PageProps) {
  const { artworkId } = await params;

  const detail = await findCatalogArtwork(catalogDeps(), artworkId).catch((error: unknown) => {
    if (isAppError(error) && error.kind === "not_found") notFound();
    throw error;
  });

  const db = getDatabase();
  const [returnTerms, shippingRange] = await Promise.all([
    loadReturnTerms(),
    shippingRangeFor(db, detail.artwork),
  ]);

  return (
    <ArtworkDetailView
      artwork={detail.artwork}
      artist={detail.artist}
      artistProfileIsPublic={detail.artistProfileIsPublic}
      returnTerms={returnTerms}
      shippingRange={shippingRange}
      purchaseAction={<AddToCartForm artworkId={detail.artwork.id} />}
      renderImage={renderDetailImage}
    />
  );
}
