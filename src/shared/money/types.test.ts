import { describe, expect, it } from "vitest";
import { AppError, isAppError } from "@/shared/errors";
import { agorot, isAgorot, nonNegativeAgorot, zeroAgorot } from "./types";

function captureError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return error;
  }
  throw new Error("Expected the function to throw an AppError, but it did not throw.");
}

describe("agorot()", () => {
  it("accepts a positive whole number", () => {
    expect(agorot(125_000)).toBe(125_000);
  });

  it("accepts zero", () => {
    expect(agorot(0)).toBe(0);
  });

  it("accepts a negative whole number — the payout ledger needs adjusting entries", () => {
    expect(agorot(-5_000)).toBe(-5_000);
  });

  it("rejects a non-integer instead of rounding it", () => {
    const error = captureError(() => agorot(150.5));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain("150.5");
  });

  it("rejects NaN", () => {
    expect(captureError(() => agorot(Number.NaN)).kind).toBe("validation");
  });

  it("rejects Infinity", () => {
    expect(captureError(() => agorot(Number.POSITIVE_INFINITY)).kind).toBe("validation");
  });

  it("rejects a value beyond the safe integer range", () => {
    expect(captureError(() => agorot(Number.MAX_SAFE_INTEGER + 2)).kind).toBe("validation");
  });
});

describe("nonNegativeAgorot()", () => {
  it("accepts zero and positive amounts", () => {
    expect(nonNegativeAgorot(0)).toBe(0);
    expect(nonNegativeAgorot(100)).toBe(100);
  });

  it("rejects a negative amount", () => {
    const error = captureError(() => nonNegativeAgorot(-1));
    expect(error.kind).toBe("validation");
    expect(error.code).toBe("money.negative_not_allowed");
  });

  it("still enforces integer-ness", () => {
    expect(captureError(() => nonNegativeAgorot(1.1)).kind).toBe("validation");
  });
});

describe("isAgorot()", () => {
  it("is true for a value produced by agorot()", () => {
    expect(isAgorot(agorot(10))).toBe(true);
  });

  it("is false for a non-integer, NaN, or an unsafe magnitude", () => {
    expect(isAgorot(1.5)).toBe(false);
    expect(isAgorot(Number.NaN)).toBe(false);
    expect(isAgorot(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });

  it("is false for a non-number", () => {
    expect(isAgorot("100")).toBe(false);
  });
});

describe("zeroAgorot", () => {
  it("is exactly zero", () => {
    expect(zeroAgorot).toBe(0);
  });
});
