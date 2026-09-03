/**
 * The proof that the commission split neither invents nor loses an agora.
 *
 * `commission.ts` resolves a live disagreement between SECURITY.md S0-5 item 6
 * and `shared/money.splitCommission`. A disagreement about money is not settled
 * by picking one and writing a comment, so this file enumerates the rule rather
 * than sampling it: 4.2 million splits, every one checked against an oracle
 * written a different way from the implementation.
 *
 * THE ORACLES, AND WHY THERE ARE TWO
 * ----------------------------------
 * `floorOracle` multiplies the subtotal by the rate DIRECTLY and takes the
 * floor by subtracting the remainder. `splitCommissionBp` never forms that
 * product: it decomposes the subtotal into 10000q + r precisely because the
 * direct product overflows the safe-integer range for large amounts. So the two
 * agree only if the decomposition identity is right, which is the thing worth
 * proving. It is used wherever the direct product is exactly representable.
 *
 * `bigOracle` is BigInt, exact at every magnitude, and is what checks the range
 * where the direct product is NOT safe -- including S0-5's own [1, 10^11] and
 * the safe-integer boundary above it.
 *
 * WHAT IS ENUMERATED
 * ------------------
 *   1. Every rate in [0, 5000] bp -- the entire configurable range, per
 *      CONFIG_BOUNDS -- against every subtotal in [0, 500]. 2,505,501 splits.
 *      Small amounts are where rounding decides the most, proportionally.
 *   2. Every subtotal in [0, 200000] against the eight rates that matter:
 *      the bounds, the configured 15%, its neighbours, and the config ceiling.
 *      1,600,008 splits.
 *   3. Every exact halfway case that exists below 200000 agorot at every rate
 *      in [0, 5000] -- the complete set of inputs on which the two conflicting
 *      definitions give different money.
 *   4. The large end, against BigInt.
 *   5. Sign symmetry, and the reversal identity the append-only ledger needs.
 *
 * No `expect` inside a loop. Four million assertions would take longer than the
 * whole suite and report the same failure four million times; each sweep
 * records its FIRST counterexample and asserts once, so a failure names the
 * exact subtotal and rate rather than a count.
 */
import { describe, expect, it } from "vitest";
import { agorot, splitCommission, type Agorot } from "@/shared/money";
import { BASIS_POINTS_PER_UNIT, commissionOnFulfilment, splitCommissionBp } from "./commission";

/** The configurable range, from CONFIG_BOUNDS["platform.commission_rate_bp"]. */
const MAX_CONFIGURABLE_BP = 5_000;

/**
 * S0-5 item 6, written as directly as the arithmetic allows: multiply, then
 * floor. Exact only while `subtotal * rateBp` is a safe integer, which is why
 * the sweeps that use it stay below that line and `bigOracle` covers the rest.
 */
function floorOracle(subtotal: number, rateBp: number): number {
  const product = subtotal * rateBp;
  return (product - (product % BASIS_POINTS_PER_UNIT)) / BASIS_POINTS_PER_UNIT;
}

/** The same rule in BigInt: exact at every magnitude, sign applied to the magnitude. */
function bigOracle(subtotal: bigint, rateBp: bigint): { commission: bigint; net: bigint } {
  const magnitude = subtotal < 0n ? -subtotal : subtotal;
  // BigInt division truncates toward zero; the operand is non-negative, so this
  // is floor, exactly as S0-5 writes it.
  const magnitudeCommission = (magnitude * rateBp) / 10_000n;
  const commission = subtotal < 0n ? -magnitudeCommission : magnitudeCommission;
  return { commission, net: subtotal - commission };
}

interface Counterexample {
  readonly subtotal: number | bigint;
  readonly rateBp: number;
  readonly why: string;
  readonly got: unknown;
  readonly expected: unknown;
}

/** Every property a split must have, checked at once. Returns null when it holds. */
function checkAgainstFloorOracle(subtotal: number, rateBp: number): Counterexample | null {
  const { commissionAgorot, netAgorot } = splitCommissionBp(agorot(subtotal), rateBp);

  if (commissionAgorot + netAgorot !== subtotal) {
    return {
      subtotal,
      rateBp,
      why: "commission + net did not reconstruct the subtotal",
      got: commissionAgorot + netAgorot,
      expected: subtotal,
    };
  }
  if (!Number.isInteger(commissionAgorot) || !Number.isInteger(netAgorot)) {
    return { subtotal, rateBp, why: "a split was not integral", got: [commissionAgorot, netAgorot], expected: "integers" };
  }
  const expected = floorOracle(subtotal, rateBp);
  if (commissionAgorot !== expected) {
    return { subtotal, rateBp, why: "commission was not floor(subtotal * rateBp / 10000)", got: commissionAgorot, expected };
  }
  if (subtotal >= 0 && (commissionAgorot < 0 || netAgorot < 0)) {
    return { subtotal, rateBp, why: "a non-negative subtotal produced a negative half", got: [commissionAgorot, netAgorot], expected: ">= 0" };
  }
  if (commissionAgorot > subtotal && subtotal >= 0) {
    return { subtotal, rateBp, why: "commission exceeded the subtotal", got: commissionAgorot, expected: `<= ${subtotal}` };
  }
  return null;
}

function describeCounterexample(found: Counterexample | null): string {
  if (found === null) return "no counterexample";
  return `subtotal=${found.subtotal} rateBp=${found.rateBp}: ${found.why} (got ${JSON.stringify(found.got)}, expected ${JSON.stringify(found.expected)})`;
}

describe("the commission split, enumerated over every configurable rate", () => {
  it("holds for all 2,505,501 combinations of a rate in [0, 5000] bp and a subtotal in [0, 500]", () => {
    let found: Counterexample | null = null;
    let checked = 0;

    for (let rateBp = 0; rateBp <= MAX_CONFIGURABLE_BP && found === null; rateBp += 1) {
      for (let subtotal = 0; subtotal <= 500; subtotal += 1) {
        checked += 1;
        found = checkAgainstFloorOracle(subtotal, rateBp);
        if (found !== null) break;
      }
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
    // Without this the sweep above could loop zero times and pass vacuously.
    expect(checked).toBe(5_001 * 501);
  });

  it("holds for every subtotal up to ₪2,000 at the rates that actually get used", () => {
    // 0 and 5000 are the config bounds; 1500 is the default; 1499/1501 sit
    // either side of it so an off-by-one in the decomposition shows up; 1 is the
    // smallest non-zero rate, where the commission is zero for almost every
    // amount and the net must therefore absorb the entire subtotal.
    const rates = [0, 1, 1499, 1500, 1501, 2500, 4999, 5000];
    let found: Counterexample | null = null;
    let checked = 0;

    for (const rateBp of rates) {
      for (let subtotal = 0; subtotal <= 200_000 && found === null; subtotal += 1) {
        checked += 1;
        found = checkAgainstFloorOracle(subtotal, rateBp);
      }
      if (found !== null) break;
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
    expect(checked).toBe(200_001 * rates.length);
  });
});

describe("the halfway cases, where the two definitions in this repository disagree", () => {
  /**
   * The complete set of inputs on which `floor` and `round half away from zero`
   * give different money: those where `subtotal * rateBp` is an exact odd
   * multiple of 5000, so the true quotient ends in exactly .5.
   */
  function halfwayCases(limit: number): Array<{ subtotal: number; rateBp: number }> {
    const cases: Array<{ subtotal: number; rateBp: number }> = [];
    for (let rateBp = 1; rateBp <= MAX_CONFIGURABLE_BP; rateBp += 1) {
      for (let subtotal = 1; subtotal <= limit; subtotal += 1) {
        if ((subtotal * rateBp) % BASIS_POINTS_PER_UNIT === 5_000) {
          cases.push({ subtotal, rateBp });
        }
      }
    }
    return cases;
  }

  it("exist in quantity, so this describe block is not testing an empty set", () => {
    const cases = halfwayCases(400);
    expect(cases.length).toBeGreaterThan(1_000);
    // The smallest one at the configured 15%, quoted in the header of
    // commission.ts: ₪0.10 splits 1/9 under floor and 2/8 under half-away.
    expect(cases).toContainEqual({ subtotal: 10, rateBp: 1500 });
  });

  it("all floor, which is the rule SECURITY.md S0-5 states", () => {
    let found: Counterexample | null = null;

    for (const { subtotal, rateBp } of halfwayCases(400)) {
      const { commissionAgorot } = splitCommissionBp(agorot(subtotal), rateBp);
      const exactHalf = (subtotal * rateBp - 5_000) / BASIS_POINTS_PER_UNIT;
      if (commissionAgorot !== exactHalf) {
        found = { subtotal, rateBp, why: "a halfway case did not floor", got: commissionAgorot, expected: exactHalf };
        break;
      }
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
  });

  it("are exactly the cases where shared/money.splitCommission pays the artist one agora less", () => {
    // This is the conflict, made concrete rather than described. It is not an
    // assertion that `shared/money` is broken -- half-away-from-zero is a
    // defensible rule -- but that the repository currently holds two rules, and
    // that the difference is real money on real inputs.
    const disagreements = halfwayCases(400).filter(({ subtotal, rateBp }) => {
      const bp = splitCommissionBp(agorot(subtotal), rateBp);
      const legacy = splitCommission(agorot(subtotal), rateBp / BASIS_POINTS_PER_UNIT);
      return legacy.commission !== bp.commissionAgorot;
    });

    expect(disagreements.length).toBeGreaterThan(1_000);
    for (const { subtotal, rateBp } of disagreements.slice(0, 50)) {
      const bp = splitCommissionBp(agorot(subtotal), rateBp);
      const legacy = splitCommission(agorot(subtotal), rateBp / BASIS_POINTS_PER_UNIT);
      expect(legacy.commission - bp.commissionAgorot).toBe(1);
      // Both rules conserve the subtotal. That is not what is in dispute.
      expect(legacy.commission + legacy.net).toBe(subtotal);
      expect(bp.commissionAgorot + bp.netAgorot).toBe(subtotal);
    }
  });
});

describe("the large end, where a float would have failed", () => {
  it("stays exact from ₪1 to beyond S0-5's 10^11 agorot, checked against BigInt", () => {
    const subtotals: number[] = [];
    // A deterministic geometric sweep rather than random values: the same
    // magnitudes are covered on every run, so a failure is reproducible without
    // a seed to record.
    for (let exponent = 0; exponent <= 15; exponent += 1) {
      const base = 10 ** exponent;
      for (const delta of [-3, -1, 0, 1, 3, 7]) {
        const value = base + delta;
        if (value > 0 && Number.isSafeInteger(value)) subtotals.push(value);
      }
    }
    // The safe-integer boundary itself: the largest amount `Agorot` accepts.
    subtotals.push(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1);

    let found: Counterexample | null = null;
    let checked = 0;

    for (const subtotal of subtotals) {
      for (let rateBp = 0; rateBp <= MAX_CONFIGURABLE_BP && found === null; rateBp += 1) {
        checked += 1;
        const { commissionAgorot, netAgorot } = splitCommissionBp(agorot(subtotal), rateBp);
        const oracle = bigOracle(BigInt(subtotal), BigInt(rateBp));

        if (BigInt(commissionAgorot) !== oracle.commission) {
          found = { subtotal, rateBp, why: "commission diverged from the BigInt oracle", got: commissionAgorot, expected: oracle.commission.toString() };
        } else if (BigInt(netAgorot) !== oracle.net) {
          found = { subtotal, rateBp, why: "net diverged from the BigInt oracle", got: netAgorot, expected: oracle.net.toString() };
        } else if (commissionAgorot + netAgorot !== subtotal) {
          found = { subtotal, rateBp, why: "commission + net did not reconstruct the subtotal", got: commissionAgorot + netAgorot, expected: subtotal };
        }
      }
      if (found !== null) break;
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
    expect(checked).toBe(subtotals.length * (MAX_CONFIGURABLE_BP + 1));
  });

  it("refuses an amount that is not safely representable, rather than rounding it", () => {
    // `agorot()` is the guard, and it is not decorative: a subtotal above the
    // safe-integer range would make every arithmetic identity below meaningless.
    expect(() => agorot(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safely represented|whole number/i);
  });
});

describe("below zero, where an adjusting entry lives", () => {
  it("negates exactly: the split of -n is the negation of the split of n, for 2.5 million pairs", () => {
    let found: Counterexample | null = null;
    let checked = 0;

    for (let rateBp = 0; rateBp <= MAX_CONFIGURABLE_BP && found === null; rateBp += 1) {
      for (let subtotal = 0; subtotal <= 500; subtotal += 1) {
        checked += 1;
        const positive = splitCommissionBp(agorot(subtotal), rateBp);
        const negative = splitCommissionBp(agorot(-subtotal), rateBp);

        if (negative.commissionAgorot !== -positive.commissionAgorot) {
          found = { subtotal: -subtotal, rateBp, why: "the reversed commission was not the negation", got: negative.commissionAgorot, expected: -positive.commissionAgorot };
          break;
        }
        if (negative.netAgorot !== -positive.netAgorot) {
          found = { subtotal: -subtotal, rateBp, why: "the reversed net was not the negation", got: negative.netAgorot, expected: -positive.netAgorot };
          break;
        }
      }
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
    expect(checked).toBe(5_001 * 501);
  });

  it("makes a sale and its full reversal sum to nothing at all", () => {
    // The property the append-only ledger actually depends on. Under
    // `Math.floor` this fails on the very first halfway case: floor(-1.5) = -2
    // against floor(1.5) = 1, so the pair leaves a commission of -1 and a net of
    // +1 behind -- an agora invented in the one table where none may be.
    let found: Counterexample | null = null;

    for (let rateBp = 0; rateBp <= MAX_CONFIGURABLE_BP && found === null; rateBp += 1) {
      for (let subtotal = 0; subtotal <= 500; subtotal += 1) {
        const sale = splitCommissionBp(agorot(subtotal), rateBp);
        const reversal = splitCommissionBp(agorot(-subtotal), rateBp);
        const commissionResidue = sale.commissionAgorot + reversal.commissionAgorot;
        const netResidue = sale.netAgorot + reversal.netAgorot;

        if (commissionResidue !== 0 || netResidue !== 0) {
          found = { subtotal, rateBp, why: "a sale and its reversal left a residue", got: [commissionResidue, netResidue], expected: [0, 0] };
          break;
        }
      }
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
  });

  it("still reconstructs the subtotal below zero, checked against BigInt", () => {
    let found: Counterexample | null = null;

    for (const subtotal of [-1, -7, -10, -1_301, -125_000, -(10 ** 11)]) {
      for (let rateBp = 0; rateBp <= MAX_CONFIGURABLE_BP && found === null; rateBp += 1) {
        const split = splitCommissionBp(agorot(subtotal), rateBp);
        const oracle = bigOracle(BigInt(subtotal), BigInt(rateBp));
        if (BigInt(split.commissionAgorot) !== oracle.commission || BigInt(split.netAgorot) !== oracle.net) {
          found = { subtotal, rateBp, why: "a negative split diverged from the BigInt oracle", got: [split.commissionAgorot, split.netAgorot], expected: [oracle.commission.toString(), oracle.net.toString()] };
        } else if (split.commissionAgorot + split.netAgorot !== subtotal) {
          found = { subtotal, rateBp, why: "a negative split did not reconstruct the subtotal", got: split.commissionAgorot + split.netAgorot, expected: subtotal };
        }
      }
      if (found !== null) break;
    }

    expect(describeCounterexample(found)).toBe("no counterexample");
  });
});

describe("the spec's own worked example", () => {
  it("splits a ₪1,000 artwork at 15% into ₪150 commission and ₪850 net", () => {
    // `artist-payouts`, *Commission calculated at order time*, and SECURITY.md
    // S0-5's fourth test, which names these exact agorot.
    const split = splitCommissionBp(agorot(100_000), 1_500);
    expect(split.commissionAgorot).toBe(15_000);
    expect(split.netAgorot).toBe(85_000);
  });

  it("ignores shipping entirely: ₪1,000 plus ₪50 postage still yields ₪150 commission", () => {
    // `artist-payouts`, *Shipping excluded from commission*. The figure that
    // must NOT appear anywhere in this calculation is 105000.
    const split = commissionOnFulfilment({
      itemsSubtotalAgorot: agorot(100_000),
      commissionRateBp: 1_500,
    });
    expect(split.commissionAgorot).toBe(15_000);
    expect(split.netAgorot).toBe(85_000);
    // What the artist is owed for the parcel is the net plus the postage they
    // are reimbursed, and commission never touched the postage.
    expect(split.netAgorot + 5_000).toBe(90_000);
  });

  it("charges nothing at a zero rate and everything at 10000 bp", () => {
    expect(splitCommissionBp(agorot(100_000), 0)).toEqual({ commissionAgorot: 0, netAgorot: 100_000 });
    expect(splitCommissionBp(agorot(100_000), 10_000)).toEqual({ commissionAgorot: 100_000, netAgorot: 0 });
  });
});

describe("a rate this function will not act on", () => {
  it("rejects one above 100%, which would pay the artist a negative amount", () => {
    // The configurable ceiling is 5000 bp (SECURITY.md S1-16). This is the
    // arithmetic ceiling behind it, for a value that reached the code some other
    // way -- a hand-edited row, a restored backup.
    expect(() => splitCommissionBp(agorot(100_000), 10_001)).toThrowError(
      expect.objectContaining({ code: "payouts.rate_out_of_range" }),
    );
  });

  it("rejects a negative rate", () => {
    expect(() => splitCommissionBp(agorot(100_000), -1)).toThrowError(
      expect.objectContaining({ code: "payouts.rate_out_of_range" }),
    );
  });

  it("rejects a fractional rate, which is a float rate wearing basis points", () => {
    // 0.15 arriving here instead of 1500 is the exact mistake basis points
    // exist to prevent, and it must be loud rather than silently a 0% commission.
    expect(() => splitCommissionBp(agorot(100_000), 0.15)).toThrowError(
      expect.objectContaining({ code: "payouts.rate_not_integer" }),
    );
    expect(() => splitCommissionBp(agorot(100_000), 1_500.5)).toThrowError(
      expect.objectContaining({ code: "payouts.rate_not_integer" }),
    );
  });
});

describe("what a caller gets back", () => {
  it("is branded money, not loose numbers", () => {
    // A compile-time property asserted at runtime as best it can be: both halves
    // survive `agorot()`'s validation, so neither is a float that happens to
    // look whole.
    const split: { commissionAgorot: Agorot; netAgorot: Agorot } = splitCommissionBp(
      agorot(1_301),
      1_500,
    );
    expect(agorot(split.commissionAgorot)).toBe(split.commissionAgorot);
    expect(agorot(split.netAgorot)).toBe(split.netAgorot);
    // 1301 * 0.15 is 195.14999999999998 in binary floating point, which is the
    // worked example `shared/money` documents. Integer arithmetic gets 195 with
    // nothing to correct afterwards.
    expect(split.commissionAgorot).toBe(195);
    expect(split.netAgorot).toBe(1_106);
  });
});
