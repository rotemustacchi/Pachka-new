/**
 * Quoting shipping at checkout.
 *
 * Three rules from `shipping-and-returns` meet here, and the third is the one
 * that costs real money if it is wrong:
 *
 *   • the cost comes from the configured rate table and **no carrier API is
 *     called** -- there is no HTTP client in this module, by construction;
 *   • an address matching no zone blocks checkout;
 *   • "the system charges shipping **per fulfilment** using the largest
 *     applicable size tier, **not the sum** of the individual tiers." Two
 *     artworks from one artist travel in one parcel, so summing their tiers
 *     charges a buyer twice for a box that was posted once.
 *
 * `orders` calls this inside its reservation transaction, which is why every
 * function here takes `Sql` rather than a `Database`: the quote must be decided
 * against the same snapshot as the price and the stock (SECURITY.md S0-5).
 *
 * Nothing in the request body may carry a zone, a tier or an amount. The
 * signature is the enforcement: `QuoteLine` has no field for a price, and the
 * tier code comes from the artwork row the server read, not from the client.
 */
import { AppError } from "@/shared/errors";
import { addAgorot, zeroAgorot } from "@/shared/money";
import type { Sql } from "@/shared/db";
import { rateFor } from "./rate-table";
import { listTiers } from "./tiers";
import { resolveZone } from "./zones";
import type { DeliveryAddress, FulfilmentQuote, QuoteLine, ShippingQuote } from "./types";

export interface QuoteRequest {
  readonly address: DeliveryAddress;
  readonly lines: readonly QuoteLine[];
}

export async function quoteShipping(db: Sql, request: QuoteRequest): Promise<ShippingQuote> {
  const lines = request.lines ?? [];
  if (lines.length === 0) {
    throw AppError.validation("A shipping quote needs at least one artwork", {
      code: "shipping.empty_quote",
    });
  }

  // Checked before the zone lookup: an artwork that cannot ship at a standard
  // rate is a fact about the cart, and telling the buyer to fix their address
  // first would send them round a loop that ends in the same refusal.
  const needQuote = lines.filter((line) => line.requiresShippingQuote === true || line.sizeTierCode === null);
  if (needQuote.length > 0) {
    throw AppError.validation(
      "One or more artworks in this order are larger than any standard parcel size and need an individual shipping quote.",
      {
        code: "shipping.requires_quote",
        details: { artworkIds: needQuote.map((line) => line.artworkId) },
      },
    );
  }

  const zone = await resolveZone(db, request.address);

  const tiers = await listTiers(db);
  const byCode = new Map(tiers.map((tier) => [tier.code, tier]));

  // Group by artist: one fulfilment per artist (`checkout-orders` splits an
  // order that way), so one parcel and one charge per artist.
  const largestPerArtist = new Map<string, { ordinal: number; tierId: string; tierCode: string }>();
  for (const line of lines) {
    const tier = line.sizeTierCode === null ? undefined : byCode.get(line.sizeTierCode);
    if (!tier) {
      throw AppError.notFound(`No active shipping tier with code "${String(line.sizeTierCode)}"`, {
        code: "shipping.unknown_tier",
        details: { artworkId: line.artworkId, tierCode: line.sizeTierCode },
      });
    }

    const current = largestPerArtist.get(line.artistId);
    if (!current || tier.ordinal > current.ordinal) {
      largestPerArtist.set(line.artistId, {
        ordinal: tier.ordinal,
        tierId: tier.id,
        tierCode: tier.code,
      });
    }
  }

  const fulfilments: FulfilmentQuote[] = [];
  let total = zeroAgorot;
  // Sorted so that two identical carts quote in an identical order -- a quote
  // is compared against a displayed total, and a stable shape makes that
  // comparison mean something.
  for (const artistId of [...largestPerArtist.keys()].sort()) {
    const chosen = largestPerArtist.get(artistId);
    if (!chosen) continue;
    const amountAgorot = await rateFor(db, zone.id, chosen.tierId);
    fulfilments.push({ artistId, tierCode: chosen.tierCode, amountAgorot });
    total = addAgorot(total, amountAgorot);
  }

  return {
    zoneCode: zone.code,
    zoneDisplayName: zone.displayName,
    fulfilments,
    totalAgorot: total,
  };
}
