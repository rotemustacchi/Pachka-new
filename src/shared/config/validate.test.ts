import { describe, expect, it } from "vitest";
import { isAppError } from "@/shared/errors";
import { assertConfigValueMatchesType } from "./validate";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw, but it did not throw.");
}

describe("assertConfigValueMatchesType()", () => {
  it("accepts an integer for 'integer'", () => {
    expect(() => assertConfigValueMatchesType("k", "integer", 30)).not.toThrow();
  });

  it("rejects a non-integer number for 'integer'", () => {
    const error = captureError(() => assertConfigValueMatchesType("k", "integer", 30.5));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects a string for 'integer'", () => {
    const error = captureError(() => assertConfigValueMatchesType("k", "integer", "30"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("accepts a float for 'number'", () => {
    expect(() => assertConfigValueMatchesType("k", "number", 0.15)).not.toThrow();
  });

  it("rejects a string for 'number'", () => {
    const error = captureError(() => assertConfigValueMatchesType("k", "number", "0.15"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("rejects NaN/Infinity for 'number'", () => {
    expect(isAppError(captureError(() => assertConfigValueMatchesType("k", "number", Number.NaN)))).toBe(
      true,
    );
    expect(
      isAppError(
        captureError(() => assertConfigValueMatchesType("k", "number", Number.POSITIVE_INFINITY)),
      ),
    ).toBe(true);
  });

  it("accepts a string for 'string'", () => {
    expect(() => assertConfigValueMatchesType("k", "string", "ILS")).not.toThrow();
  });

  it("rejects a number for 'string'", () => {
    const error = captureError(() => assertConfigValueMatchesType("k", "string", 5));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("accepts a boolean for 'boolean' and rejects everything else", () => {
    expect(() => assertConfigValueMatchesType("k", "boolean", true)).not.toThrow();
    const error = captureError(() => assertConfigValueMatchesType("k", "boolean", "true"));
    expect(isAppError(error) && error.kind).toBe("validation");
  });

  it("accepts anything for 'json'", () => {
    expect(() => assertConfigValueMatchesType("k", "json", { any: "shape" })).not.toThrow();
    expect(() => assertConfigValueMatchesType("k", "json", [1, 2, 3])).not.toThrow();
    expect(() => assertConfigValueMatchesType("k", "json", null)).not.toThrow();
  });

  it("names the offending key in the error message", () => {
    const error = captureError(() =>
      assertConfigValueMatchesType("platform.commission_rate_bp", "integer", "oops"),
    );
    expect(isAppError(error) && error.message).toContain("platform.commission_rate_bp");
  });
});
