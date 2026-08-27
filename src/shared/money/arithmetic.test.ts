import { describe, expect, it } from "vitest";
import { isAppError } from "@/shared/errors";
import { addAgorot, multiplyAgorot, splitCommission, subtractAgorot } from "./arithmetic";
import { agorot } from "./types";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw, but it did not throw.");
}

describe("addAgorot() / subtractAgorot()", () => {
  it("adds two amounts", () => {
    expect(addAgorot(agorot(100), agorot(50))).toBe(150);
  });

  it("subtracts two amounts, allowing a negative result", () => {
    expect(subtractAgorot(agorot(50), agorot(100))).toBe(-50);
  });

  it("rejects an overflow past the safe integer range", () => {
    const error = captureError(() =>
      addAgorot(agorot(Number.MAX_SAFE_INTEGER), agorot(10)),
    );
    expect(isAppError(error) && error.kind).toBe("validation");
  });
});

describe("multiplyAgorot()", () => {
  it("multiplies by an integer quantity", () => {
    expect(multiplyAgorot(agorot(1_000), 3)).toBe(3_000);
  });

  it("rejects a non-integer quantity", () => {
    const error = captureError(() => multiplyAgorot(agorot(1_000), 2.5));
    expect(isAppError(error) && error.kind).toBe("validation");
  });
});

describe("splitCommission() — the commission + net === subtotal invariant", () => {
  it("splits an even amount exactly", () => {
    const { commission, net } = splitCommission(agorot(10_000), 0.15);
    expect(commission).toBe(1_500);
    expect(net).toBe(8_500);
    expect(commission + net).toBe(10_000);
  });

  it("documents the round-half-away-from-zero rule on an exact half-agora boundary", () => {
    // 5 agorot * 0.5 = 2.5 agorot exactly -> rounds away from zero to 3.
    const { commission, net } = splitCommission(agorot(5), 0.5);
    expect(commission).toBe(3);
    expect(net).toBe(2);
    expect(commission + net).toBe(5);
  });

  it("never loses or invents an agora across a spread of odd amounts and rates", () => {
    const subtotals = [1, 3, 7, 11, 99, 101, 1_301, 4_999, 10_000_007];
    const rates = [0, 0.01, 0.15, 0.2, 0.333, 0.5, 0.999, 1];

    for (const subtotal of subtotals) {
      for (const rate of rates) {
        const { commission, net } = splitCommission(agorot(subtotal), rate);
        expect(commission + net).toBe(subtotal);
      }
    }
  });

  it("holds for a negative subtotal (a payout ledger reversal)", () => {
    const { commission, net } = splitCommission(agorot(-10_000), 0.15);
    expect(commission + net).toBe(-10_000);
  });

  it("a zero rate assigns nothing to commission", () => {
    const { commission, net } = splitCommission(agorot(10_000), 0);
    expect(commission).toBe(0);
    expect(net).toBe(10_000);
  });

  it("a rate of 1 assigns everything to commission", () => {
    const { commission, net } = splitCommission(agorot(10_000), 1);
    expect(commission).toBe(10_000);
    expect(net).toBe(0);
  });

  it("rejects a rate outside [0, 1]", () => {
    expect(isAppError(captureError(() => splitCommission(agorot(100), 1.5)))).toBe(true);
    expect(isAppError(captureError(() => splitCommission(agorot(100), -0.1)))).toBe(true);
  });

  it("rejects a non-finite rate", () => {
    expect(isAppError(captureError(() => splitCommission(agorot(100), Number.NaN)))).toBe(true);
  });
});
