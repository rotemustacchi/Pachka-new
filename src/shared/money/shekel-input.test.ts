import { describe, expect, it } from "vitest";
import { isAppError } from "@/shared/errors";
import { parseAgorot } from "./shekel-input";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw, but it did not throw.");
}

describe("parseAgorot() — accepted forms", () => {
  it.each([
    ["1250", 125_000],
    ["1,250", 125_000],
    ["1250.50", 125_050],
    ["1250.5", 125_050],
    ["₪1,250.50", 125_050],
    ["₪1250", 125_000],
    ["1250₪", 125_000],
    ["  1250  ", 125_000],
    ["₪ 480", 48_000], // formatAgorotCompact's own output must round-trip
    ["0", 0],
    ["0.05", 5],
  ])("parses %s as %i agorot", (input, expected) => {
    expect(parseAgorot(input)).toBe(expected);
  });

  it("accepts a leading minus sign by default", () => {
    expect(parseAgorot("-50")).toBe(-5_000);
  });

  it("accepts a leading plus sign", () => {
    expect(parseAgorot("+50")).toBe(5_000);
  });
});

describe("parseAgorot() — rejected forms", () => {
  it("rejects an empty string", () => {
    const error = captureError(() => parseAgorot(""));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a whitespace-only string", () => {
    const error = captureError(() => parseAgorot("   "));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects garbage text", () => {
    const error = captureError(() => parseAgorot("not a number"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects more than two decimal places rather than rounding", () => {
    const error = captureError(() => parseAgorot("12.345"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects an incorrect thousands grouping", () => {
    const error = captureError(() => parseAgorot("12,34"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a bare sign", () => {
    const error = captureError(() => parseAgorot("-"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a doubled sign", () => {
    const error = captureError(() => parseAgorot("--50"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a negative amount when the caller opts out of negatives", () => {
    const error = captureError(() => parseAgorot("-50", { allowNegative: false }));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("accepts a negative amount when the caller allows it explicitly", () => {
    expect(parseAgorot("-50", { allowNegative: true })).toBe(-5_000);
  });
});
