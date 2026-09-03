/**
 * How a subtotal is split into platform commission and artist net.
 *
 * THE CONFLICT THIS FILE RESOLVES
 * -------------------------------
 * The repository defines commission rounding twice, and the two definitions
 * disagree on real money.
 *
 *   SECURITY.md S0-5 item 6:
 *     commission = floor(subtotal_agorot * rate_bp / 10000)
 *     net        = subtotal_agorot - commission
 *
 *   shared/money.splitCommission(subtotal, rate: 0..1):
 *     commission = roundHalfAwayFromZero(subtotal * rate)
 *     net        = subtotal - commission
 *
 * They differ whenever `subtotal * rate_bp` is an exact odd multiple of 5000 --
 * the halfway case. At the configured 1500 bp, the smallest example is a
 * subtotal of 10 agorot: 10 * 1500 / 10000 = 1.5, which floors to 1 and rounds
 * to 2. The artist is paid 9 agorot under one rule and 8 under the other, and
 * both rules are written down as authoritative.
 *
 * There is a second, quieter problem with the `shared/money` version, and it is
 * the reason basis points exist in this codebase at all. It takes a `number`
 * rate in [0, 1], so 1500 bp must first become 0.15 -- which is not
 * representable in binary floating point. `splitCommission` knows this and
 * defends with `Number(x.toFixed(9))`, a correction that works for the
 * magnitudes in front of it and is not a proof. ARCHITECTURE.md's "money is an
 * integer count of agorot, never a float" is not satisfied by a float that has
 * been rounded back to look like an integer.
 *
 * RESOLUTION
 * ----------
 * `SECURITY.md` wins on the rule -- it is the document that says where the rule
 * lives and it is the one the order's own `commission_rate_bp` column was
 * designed around -- and this file implements it in INTEGER ARITHMETIC ONLY.
 * No division of one float by another happens anywhere below. `payouts` is the
 * first module where the disagreement is spendable, so this is where it is
 * settled, and it is settled by proof rather than by preference: see
 * `commission.test.ts`, which enumerates the rule against a completely
 * independent BigInt oracle over every rate in [0, 5000] bp against small
 * amounts, every amount up to 200,000 agorot against the rates that matter, and
 * every exact halfway case that exists -- 4.2 million splits, no sampling.
 *
 * REPORTED, NOT RESOLVED SILENTLY: this belongs in `shared/money` as
 * `splitCommissionBp`, so that `orders`, `shipping`'s refund path and this
 * module cannot drift. `shared/**` is outside this module's write boundary, so
 * the implementation lives here and the request goes to the lead architect.
 * `shared/money.splitCommission` is NOT called from this module.
 *
 * WHAT HAPPENS BELOW ZERO
 * -----------------------
 * S0-5 defines the rule for a sale, whose subtotal is never negative. An
 * adjusting entry's is: a correction that reverses a sale carries the negative
 * of it (`artist-payouts`, *Correction recorded*). `Math.floor` is the wrong
 * answer there, and the reason is arithmetic rather than taste.
 *
 * At 1500 bp, a sale of 10 agorot splits 1 / 9. Reversing it means splitting
 * -10. Under floor, floor(-1.5) = -2, giving -2 / -8: the sale and its own
 * reversal sum to a commission of -1 and a net of +1. One agora has been
 * invented, in a table whose entire purpose is that none ever is.
 *
 * So the sign is applied to the MAGNITUDE: the split of -n is exactly the
 * negation of the split of n, always. For every non-negative subtotal -- which
 * is every subtotal S0-5 is talking about -- this is bit-for-bit `floor`, so
 * nothing about the security requirement is weakened. Below zero it is
 * truncation toward zero, which is the only choice under which reversing an
 * entry restores the balance exactly. `commission.test.ts` proves both halves.
 */
import { AppError } from "@/shared/errors";
import { agorot, type Agorot } from "@/shared/money";

/** Basis points in one whole. 1500 bp = 15%. */
export const BASIS_POINTS_PER_UNIT = 10_000;

/**
 * The widest rate this function will act on.
 *
 * Not the same number as `CONFIG_BOUNDS["platform.commission_rate_bp"]`, which
 * caps the *configurable* rate at 5000 bp so that a compromised admin session
 * cannot set a 100% commission (SECURITY.md S1-16). This is the arithmetic
 * ceiling: above 10000 bp the commission exceeds the subtotal and the artist's
 * net goes negative, which is not a rounding question but a nonsense one. Both
 * bounds exist because they fail for different reasons, and a rate that got
 * past the config bound -- a hand-edited row, a restored backup -- still cannot
 * get past this one.
 */
const MAX_RATE_BP = 10_000;

export interface CommissionSplit {
  /** What the platform keeps. Same sign as the subtotal. */
  readonly commissionAgorot: Agorot;
  /** What the artist is owed. The remainder, so the two always reconstruct the subtotal. */
  readonly netAgorot: Agorot;
}

/**
 * Split `subtotal` at `rateBp` basis points.
 *
 * `commissionAgorot + netAgorot === subtotal`, exactly, for every input this
 * function accepts. There is exactly one rounding decision -- the commission --
 * and the net absorbs whatever it left, which is what makes the identity an
 * invariant instead of a coincidence.
 *
 * @param subtotal the ITEM subtotal in agorot, excluding shipping
 *   (`artist-payouts`, *Shipping excluded from commission*). Passing a figure
 *   that includes shipping is the bug this parameter's name exists to prevent;
 *   `orders` keeps `itemsSubtotalAgorot` and `shippingAgorot` on separate
 *   columns so a caller has to choose deliberately.
 * @param rateBp basis points, snapshotted at placement. Never recomputed from
 *   current configuration: SECURITY.md S0-5 item 3, and `artist-payouts`,
 *   *Rate changes later*.
 */
export function splitCommissionBp(subtotal: Agorot, rateBp: number): CommissionSplit {
  assertRate(rateBp);

  // The subtotal arrives as `Agorot`, so it is already a safe whole number --
  // but this function is the one place in the module that multiplies money, and
  // a guard here is cheaper than an audit later.
  if (!Number.isSafeInteger(subtotal)) {
    throw AppError.validation(
      `A subtotal must be a whole, safely representable number of agorot, got ${subtotal}`,
      { code: "payouts.subtotal_not_integer", details: { subtotal } },
    );
  }

  const negative = subtotal < 0;
  const magnitude = negative ? -subtotal : subtotal;

  // THE ARITHMETIC, AND WHY IT IS WRITTEN THIS WAY.
  //
  // The naive form is `Math.floor(magnitude * rateBp / 10000)`, and it is
  // wrong twice over. `magnitude * rateBp` overflows the safe-integer range for
  // a subtotal above ~9e11 at 10000 bp -- inside the range S0-5's own property
  // test uses, which goes to 1e11 -- and the intermediate division is a float
  // division whose result is then floored, which is precisely the "reintroduce
  // the float that basis points exist to eliminate" this file exists to avoid.
  //
  // Instead, decompose. With magnitude = 10000q + r and 0 <= r < 10000:
  //
  //   floor(magnitude * rateBp / 10000) = q * rateBp + floor(r * rateBp / 10000)
  //
  // an exact identity over the integers. Both terms are computed without a
  // single inexact operation:
  //
  //   * `q * rateBp` is bounded above by `magnitude` itself, because
  //     q <= magnitude / 10000 and rateBp <= 10000. It is therefore a safe
  //     integer whenever the subtotal is, which is guaranteed above.
  //   * `r * rateBp` is at most 9999 * 10000 < 10^8, exact in a double by an
  //     enormous margin. The floor of its quotient is taken by subtracting the
  //     remainder before dividing, so the division has an exact integer result
  //     and no rounding mode is ever consulted.
  const q = (magnitude - (magnitude % BASIS_POINTS_PER_UNIT)) / BASIS_POINTS_PER_UNIT;
  const r = magnitude % BASIS_POINTS_PER_UNIT;
  const low = r * rateBp;
  const magnitudeCommission = q * rateBp + (low - (low % BASIS_POINTS_PER_UNIT)) / BASIS_POINTS_PER_UNIT;

  const commission = negative ? -magnitudeCommission : magnitudeCommission;

  // The net is the REMAINDER, never a second rounded product. This is the line
  // that makes the invariant hold; changing it to `magnitude * (1 - rate)` would
  // reintroduce every problem this file describes.
  return {
    commissionAgorot: agorot(commission),
    netAgorot: agorot(subtotal - commission),
  };
}

/**
 * The commission on a fulfilment, stated the way the ledger records it.
 *
 * A thin wrapper with one job: name the two figures a caller must not confuse.
 * `orders` deliberately keeps `itemsSubtotalAgorot` and `shippingAgorot` apart
 * (`artist-payouts`: "commission is calculated on the artwork price only"), and
 * this signature makes passing the wrong one a type error rather than a quiet
 * overcharge of the artist by 15% of their postage.
 */
export function commissionOnFulfilment(input: {
  readonly itemsSubtotalAgorot: Agorot;
  readonly commissionRateBp: number;
}): CommissionSplit {
  return splitCommissionBp(input.itemsSubtotalAgorot, input.commissionRateBp);
}

function assertRate(rateBp: number): void {
  if (typeof rateBp !== "number" || !Number.isInteger(rateBp)) {
    throw AppError.validation(
      `A commission rate is a whole number of basis points, got ${rateBp}`,
      { code: "payouts.rate_not_integer", details: { rateBp } },
    );
  }
  if (rateBp < 0 || rateBp > MAX_RATE_BP) {
    throw AppError.validation(
      `A commission rate must be between 0 and ${MAX_RATE_BP} basis points, got ${rateBp}`,
      { code: "payouts.rate_out_of_range", details: { rateBp } },
    );
  }
}
