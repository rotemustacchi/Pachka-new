/**
 * The cart, and the two things it must never do.
 *
 * `checkout-orders`, "Cart": "The system SHALL allow a buyer to hold multiple
 * artworks in a cart. Adding an artwork to a cart SHALL NOT reserve it. The cart
 * SHALL revalidate availability and price on every view, and SHALL clearly mark
 * any line whose artwork has become unavailable or changed price."
 *
 * WHERE THE CART LIVES
 * --------------------
 * Not in a table. There is no `carts` table in ARCHITECTURE.md's ownership map,
 * and adding one would claim ownership of a table the contract does not grant.
 * More to the point, it would not buy anything: adding to a cart reserves
 * nothing, so a cart line is a wish, and a wish is worth exactly what it is
 * worth whether it is stored on a server or in a cookie.
 *
 * So the cart's CONTENTS are the client's — a list of artwork ids and
 * quantities — and the cart's TRUTH is this function, which re-reads every price
 * and every availability from the database on every view. That division is what
 * makes the spec's two scenarios work, and it is also what makes them safe: a
 * client-held cart cannot lie about a price, because no price it holds is ever
 * used. `priceWhenAddedAgorot` below is compared and then discarded, exactly as
 * `checkout.ts` does with the displayed total (SECURITY.md S0-5 item 5).
 *
 * NO LOCK, NO TRANSACTION, DELIBERATELY
 * -------------------------------------
 * This is a read. Taking `SELECT ... FOR UPDATE` here would hold a row lock for
 * as long as a browser tab is open on a cart page — which is the inventory
 * hostage of SECURITY.md S1-17, self-inflicted. A cart's answer is a snapshot
 * and is allowed to be stale by the time the buyer clicks confirm; that is
 * precisely why `beginCheckout` re-derives everything under the lock rather than
 * trusting anything decided here.
 */
import { addAgorot, multiplyAgorot, zeroAgorot, type Agorot } from "@/shared/money";
import type { Sql } from "@/shared/db";
import {
  availabilityFor,
  toArtwork,
  ARTWORK_COLUMNS,
  ZERO_DEMAND,
  type ArtworkRow,
} from "@/modules/artworks";
import { sqlInventoryDemand } from "./demand";

/** One line as the client holds it. Ids and quantities; no money that is believed. */
export interface CartLineInput {
  readonly artworkId: string;
  readonly quantity?: number;
  /**
   * The unit price displayed when the buyer added it. Compared so the cart can
   * say "this changed"; never used as an amount.
   */
  readonly priceWhenAddedAgorot?: number;
}

export interface CartLine {
  readonly artworkId: string;
  readonly artistId: string;
  readonly title: string | null;
  readonly quantity: number;
  /** The CURRENT price, read just now. `checkout-orders`: "the cart shows the current price". */
  readonly unitPriceAgorot: Agorot | null;
  readonly lineTotalAgorot: Agorot;
  /** Can this line be bought right now, in this quantity? */
  readonly available: boolean;
  readonly availableUnits: number;
  /**
   * `checkout-orders`, *Price changed since adding*: "the cart shows the current
   * price and flags that it changed". False when the buyer supplied no
   * comparison price — an unknown is not a change.
   */
  readonly priceChanged: boolean;
  readonly priceWhenAddedAgorot: number | null;
  /** Why the line cannot be bought, for the badge next to it. */
  readonly unavailableReason: "sold" | "withdrawn" | "not_enough_stock" | "not_priced" | null;
}

export interface CartView {
  readonly lines: readonly CartLine[];
  /**
   * Available lines only. `checkout-orders`, *Artwork sells while in another
   * buyer's cart*: the unavailable line "is marked unavailable, is excluded from
   * the total, and cannot be checked out".
   */
  readonly subtotalAgorot: Agorot;
  /** True when at least one line can still be bought. */
  readonly checkoutable: boolean;
  /** Lines with a changed price. Non-empty means the buyer must be shown the change. */
  readonly changedArtworkIds: readonly string[];
  readonly unavailableArtworkIds: readonly string[];
}

/**
 * Re-read a cart against the database.
 *
 * Two queries regardless of how many lines there are: one for the artworks and
 * one, batched, for the demand. An artist dashboard learned the same lesson —
 * `demandForMany` exists for exactly this.
 *
 * An artwork that has been REMOVED is simply absent from the result: moderation
 * takedown is one-way and terminal for every role (ARCHITECTURE.md), and
 * catalog-browse requires a removed artwork to return not-found. Leaving it in
 * the cart marked "unavailable" would keep a takedown visible to whoever had it
 * in their cart when it happened.
 */
export async function revalidateCart(
  db: Sql,
  input: readonly CartLineInput[],
): Promise<CartView> {
  const wanted = new Map<string, CartLineInput>();
  for (const line of input) {
    if (typeof line.artworkId === "string" && line.artworkId !== "") {
      wanted.set(line.artworkId, line);
    }
  }

  if (wanted.size === 0) {
    return {
      lines: [],
      subtotalAgorot: zeroAgorot,
      checkoutable: false,
      changedArtworkIds: [],
      unavailableArtworkIds: [],
    };
  }

  const ids = [...wanted.keys()];
  const { rows } = await db.query<ArtworkRow>(
    `select ${ARTWORK_COLUMNS} from artworks where id = any($1::uuid[]) and status <> 'removed'`,
    [ids],
  );

  const artworks = rows.map(toArtwork);
  const demand = await sqlInventoryDemand.demandForMany(
    db,
    artworks.map((artwork) => artwork.id),
  );

  const lines: CartLine[] = [];
  let subtotal = zeroAgorot;
  const changed: string[] = [];
  const unavailable: string[] = [];

  // Iterated over the CLIENT's order, so a cart does not silently reorder
  // itself between views, and skipping the absent (removed) ones.
  for (const artworkId of ids) {
    const artwork = artworks.find((candidate) => candidate.id === artworkId);
    if (!artwork) continue;

    const request = wanted.get(artworkId);
    const quantity = Math.max(1, Math.trunc(request?.quantity ?? 1));
    const availability = availabilityFor(
      artwork,
      demand.get(artwork.id) ?? ZERO_DEMAND,
    );

    const unitPriceAgorot = artwork.priceAgorot;
    const enough = availability.availableUnits >= quantity;
    const available = availability.purchasable && enough && unitPriceAgorot !== null;

    const unavailableReason: CartLine["unavailableReason"] = available
      ? null
      : unitPriceAgorot === null
        ? "not_priced"
        : artwork.status === "sold" || availability.soldOut
          ? "sold"
          : artwork.status !== "published"
            ? "withdrawn"
            : "not_enough_stock";

    const priceWhenAddedAgorot = request?.priceWhenAddedAgorot ?? null;
    const priceChanged =
      priceWhenAddedAgorot !== null &&
      unitPriceAgorot !== null &&
      priceWhenAddedAgorot !== unitPriceAgorot;

    // Through `multiplyAgorot` rather than a bare `*`, so the product is
    // validated as money rather than cast into being it (`shared/money`).
    const lineTotalAgorot =
      available && unitPriceAgorot !== null
        ? multiplyAgorot(unitPriceAgorot, quantity)
        : zeroAgorot;

    if (available) subtotal = addAgorot(subtotal, lineTotalAgorot);
    if (priceChanged) changed.push(artwork.id);
    if (!available) unavailable.push(artwork.id);

    lines.push({
      artworkId: artwork.id,
      artistId: artwork.artistId,
      title: artwork.title,
      quantity,
      unitPriceAgorot,
      lineTotalAgorot,
      available,
      availableUnits: availability.availableUnits,
      priceChanged,
      priceWhenAddedAgorot,
      unavailableReason,
    });
  }

  return {
    lines,
    subtotalAgorot: subtotal,
    checkoutable: lines.some((line) => line.available),
    changedArtworkIds: changed,
    unavailableArtworkIds: unavailable,
  };
}

/**
 * The lines a buyer can actually take to checkout, in the shape
 * `beginCheckout` wants.
 *
 * The current price travels along as `displayedUnitPriceAgorot` — as an
 * integrity check, so that a price which changes between this call and the
 * confirm aborts the checkout instead of surprising the buyer. It is compared
 * under the artwork row lock and then discarded (SECURITY.md S0-5 item 5).
 */
export function checkoutableLines(
  cart: CartView,
): Array<{ artworkId: string; quantity: number; displayedUnitPriceAgorot: number }> {
  return cart.lines
    .filter((line) => line.available && line.unitPriceAgorot !== null)
    .map((line) => ({
      artworkId: line.artworkId,
      quantity: line.quantity,
      displayedUnitPriceAgorot: Number(line.unitPriceAgorot),
    }));
}
