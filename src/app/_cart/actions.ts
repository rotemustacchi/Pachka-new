"use server";

/**
 * The cart's write surface.
 *
 * Server Actions rather than a Client Component, for the reason every view in
 * `catalog` and `matchmaker` gives: a Client Component's props are serialized
 * into the RSC flight payload and land in the HTML (SECURITY.md S1-8). A cart
 * needs none of that. It also means adding to the cart works with JavaScript
 * disabled, which matters on the page an uncommitted visitor reaches first.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT MONEY OR AVAILABILITY
 * ---------------------------------------------------------
 * `addToCart` reads the artwork through `catalog.findCatalogArtwork` and takes
 * the price from the row. The form carries an artwork id and nothing else — no
 * price, no artist, no quantity beyond a small integer — because a field for a
 * price here is a field an attacker fills in. Whether the piece can be bought
 * at all is `artwork.purchasable`, which is `artworks`' own derivation
 * (published AND units available), not a status comparison repeated on this
 * side.
 *
 * And none of it is binding. Adding to a cart reserves nothing; the prices and
 * the availability are re-derived under the row lock in `orders.beginCheckout`,
 * where they must be.
 */
import { redirect } from "next/navigation";
import { findCatalogArtwork } from "@/modules/catalog";
import { isAppError } from "@/shared/errors";
import { catalogDeps } from "@/app/_lib/deps";
import { readCart, withLine, withoutLine, writeCart } from "./cart";

export const CHECKOUT_PATH = "/checkout";

function artworkPath(artworkId: string): string {
  return `/artworks/${artworkId}`;
}

function idFrom(form: FormData): string {
  const value = form.get("artworkId");
  return typeof value === "string" ? value : "";
}

/**
 * Add an artwork to the cart, then show the cart.
 *
 * A piece that cannot be bought sends the visitor back to its own page rather
 * than into a cart line that checkout would refuse. That page renders it
 * read-only and marked unavailable, with no purchase action — which is what
 * catalog-browse asks for and is a truer answer than an error banner.
 */
export async function addToCart(form: FormData): Promise<void> {
  const artworkId = idFrom(form);
  if (artworkId === "") redirect(CHECKOUT_PATH);

  let purchasable = false;
  let priceAgorot = 0;

  try {
    const { artwork } = await findCatalogArtwork(catalogDeps(), artworkId);
    purchasable = artwork.purchasable;
    priceAgorot = artwork.priceAgorot;
  } catch (error) {
    // A not-found artwork is not an error page here: the visitor followed a
    // link to something that has been removed, and the artwork route already
    // answers that case identically for every reason it could be true.
    if (isAppError(error) && error.kind === "not_found") redirect(CHECKOUT_PATH);
    throw error;
  }

  if (!purchasable) redirect(artworkPath(artworkId));

  await writeCart(
    withLine(await readCart(), { artworkId, quantity: 1, priceWhenAddedAgorot: priceAgorot }),
  );
  redirect(CHECKOUT_PATH);
}

export async function removeFromCart(form: FormData): Promise<void> {
  await writeCart(withoutLine(await readCart(), idFrom(form)));
  redirect(CHECKOUT_PATH);
}

/** Emptied once an order exists; the wish has become a reservation. */
export async function clearCart(): Promise<void> {
  await writeCart([]);
}
