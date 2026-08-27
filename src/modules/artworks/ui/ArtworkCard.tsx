/**
 * The artwork card, as it appears in the catalog and in matchmaker results.
 *
 * design/Catalog.dc.html: image, title, artist name, price, and -- where it
 * applies -- the "נוצר בעזרת AI" corner label and the dimmed "נמכר" treatment.
 *
 * The two states worth being careful about:
 *
 * SOLD. catalog-browse requires a sold artwork to render read-only with no
 * purchase action. The card carries no action at all, so "read-only" here means
 * the visual treatment plus the fact that nothing on it is a buy control -- the
 * `SoldOverlay` from `shared/ui` is the approved dimmed-plus-pill composition.
 *
 * AI-ASSISTED. The label is not optional decoration; it is the disclosure
 * artwork-listings requires on the card AND the detail page. It renders through
 * the same component the detail page uses so the two cannot drift.
 */
import type { ReactNode } from "react";
import { Card, SoldOverlay } from "@/shared/ui";
import type { PublicArtwork } from "../serialize";
import { AiAssistedLabel } from "./AiAssistedLabel";

export interface ArtworkCardProps {
  readonly artwork: PublicArtwork;
  /** The artist's display name, already shaped by `accounts.toPublicArtist()`. */
  readonly artistName: string;
  /**
   * How to render the image.
   *
   * Required, and injected rather than chosen here, because `next/image` needs
   * a loader configured for the Supabase Storage bucket -- which is the app's
   * decision, not this module's. Falling back to a bare `<img>` was the
   * alternative and is worse: it would silently ship an unoptimised original
   * on the catalog page, which is the one page where image weight decides
   * whether the site feels fast.
   */
  readonly renderImage: (image: { src: string; alt: string }) => ReactNode;
}

export function ArtworkCard({ artwork, artistName, renderImage }: ArtworkCardProps) {
  const primary = artwork.images.find((image) => image.isPrimary) ?? artwork.images[0];
  const alt = primary?.altText ?? artwork.title;

  const body = (
    <Card className="relative overflow-hidden">
      {/* The corner label is absolutely positioned by its own variant, so the
          card is the positioned ancestor it needs. */}
      <AiAssistedLabel aiAssisted={artwork.aiAssisted} />

      <div className="aspect-[4/5] w-full overflow-hidden bg-paper-deep">
        {primary ? renderImage({ src: primary.displayPath, alt }) : null}
      </div>

      <div className="flex flex-col gap-1 p-4">
        <h3 className="text-base font-bold text-ink">{artwork.title}</h3>
        <p className="text-sm text-ink-muted">{artistName}</p>
        <p className="text-base text-ink">{artwork.priceFormatted}</p>
      </div>
    </Card>
  );

  // `soldOut` rather than `status === "sold"`: an edition whose last unit is
  // held by an in-progress checkout is not purchasable either, and a card that
  // says otherwise sends a buyer to a detail page that refuses them.
  return artwork.soldOut ? <SoldOverlay>{body}</SoldOverlay> : body;
}
