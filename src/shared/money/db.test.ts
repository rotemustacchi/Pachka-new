import { describe, expect, it } from "vitest";
import { isAppError } from "@/shared/errors";
import { fromDbValue, toDbValue } from "./db";
import { agorot } from "./types";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw, but it did not throw.");
}

describe("fromDbValue() / toDbValue() round trip", () => {
  it("round-trips a positive value", () => {
    const value = agorot(125_000);
    expect(fromDbValue(toDbValue(value))).toBe(value);
  });

  it("round-trips zero", () => {
    expect(fromDbValue(toDbValue(agorot(0)))).toBe(0);
  });

  it("round-trips a negative value (a ledger adjusting entry)", () => {
    expect(fromDbValue(toDbValue(agorot(-5_000)))).toBe(-5_000);
  });

  it("round-trips the largest safely representable value", () => {
    const value = agorot(Number.MAX_SAFE_INTEGER);
    expect(fromDbValue(toDbValue(value))).toBe(value);
  });
});

describe("fromDbValue() rejections", () => {
  it("rejects a value larger than Number.MAX_SAFE_INTEGER rather than mangling it", () => {
    // Number.MAX_SAFE_INTEGER is 9007199254740991; this is two past it.
    const tooLarge = "9007199254740993";
    const error = captureError(() => fromDbValue(tooLarge));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a value more negative than -Number.MAX_SAFE_INTEGER", () => {
    const error = captureError(() => fromDbValue("-9007199254740993"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a non-integer string — a bigint column never contains one", () => {
    const error = captureError(() => fromDbValue("12.5"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects garbage", () => {
    const error = captureError(() => fromDbValue("abc"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });
});

describe("toDbValue()", () => {
  it("renders a plain integer string with no grouping or currency sign", () => {
    expect(toDbValue(agorot(125_000))).toBe("125000");
  });

  it("renders a negative amount with a leading minus", () => {
    expect(toDbValue(agorot(-5_000))).toBe("-5000");
  });
});
