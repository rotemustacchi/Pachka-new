import { AppError } from "@/shared/errors";
import { agorot, type Agorot } from "./types";

export function addAgorot(a: Agorot, b: Agorot): Agorot {
  return agorot(a + b);
}

export function subtractAgorot(a: Agorot, b: Agorot): Agorot {
  return agorot(a - b);
}

/** Multiply an amount by an integer quantity — e.g. unit price × quantity ordered. */
export function multiplyAgorot(amount: Agorot, quantity: number): Agorot {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || !Number.isInteger(quantity)) {
    throw AppError.validation(`Quantity must be a whole number, got ${quantity}`, {
      code: "money.quantity_not_integer",
    });
  }
  return agorot(amount * quantity);
}

export interface CommissionSplit {
  readonly commission: Agorot;
  readonly net: Agorot;
}

/**
 * Split a subtotal into platform commission and artist net for a `rate`
 * such as `platform.commission_rate` (0.15, read through `shared/config`).
 *
 * Rounding rule — round half away from zero, applied ONLY to the
 * commission; `net` is always `subtotal - commission`, never rounded
 * independently. That is what makes `commission + net === subtotal` an
 * invariant rather than a coincidence: there is exactly one rounding
 * decision in this function, and the second figure absorbs whatever the
 * first one left over, so no agora can ever go missing or be double-counted.
 *
 * Half-away-from-zero (rather than banker's rounding) was chosen because
 * it is what a human operator reconciling the ledger by hand expects, and
 * because it treats a refund's negative subtotal symmetrically with a
 * sale's positive one — there is no special case for sign.
 */
export function splitCommission(subtotal: Agorot, rate: number): CommissionSplit {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw AppError.validation(
      `Commission rate must be a finite number between 0 and 1, got ${rate}`,
      { code: "money.invalid_rate" },
    );
  }

  const commission = agorot(roundHalfAwayFromZero(subtotal * rate));
  const net = agorot(subtotal - commission);
  return { commission, net };
}

function roundHalfAwayFromZero(x: number): number {
  // `.toFixed(9)` neutralises floating-point representation noise — e.g.
  // `1301 * 0.15 === 195.14999999999998`, not the mathematically exact
  // 195.15 — before deciding which side of ".5" the value rounds to.
  const corrected = Number(x.toFixed(9));
  return corrected < 0 ? -Math.round(-corrected) : Math.round(corrected);
}
