import { describe, expect, it } from "vitest";
import { agorot } from "./types";
import { formatAgorot, formatAgorotCompact } from "./format";

describe("formatAgorot()", () => {
  it("formats the canonical example from ARCHITECTURE.md", () => {
    expect(formatAgorot(agorot(125_000))).toBe("₪1,250.00");
  });

  it("always shows two decimal places, even for a whole-shekel amount", () => {
    expect(formatAgorot(agorot(0))).toBe("₪0.00");
    expect(formatAgorot(agorot(100))).toBe("₪1.00");
  });

  it("shows a single agora correctly", () => {
    expect(formatAgorot(agorot(5))).toBe("₪0.05");
  });

  it("groups thousands", () => {
    expect(formatAgorot(agorot(123_456_789))).toBe("₪1,234,567.89");
  });

  it("prefixes a negative amount with a minus sign before the currency sign", () => {
    expect(formatAgorot(agorot(-5_000))).toBe("-₪50.00");
  });

  it("does not depend on the ambient Node locale", () => {
    // toLocaleString would use a "," grouping / "." decimal only under some
    // locales; this asserts the exact output regardless of what is installed.
    expect(formatAgorot(agorot(48_000))).toBe("₪480.00");
  });
});

describe("formatAgorotCompact()", () => {
  it("matches the approved design's card price treatment (design/Catalog.dc.html)", () => {
    expect(formatAgorotCompact(agorot(48_000))).toBe("₪ 480");
    expect(formatAgorotCompact(agorot(125_000))).toBe("₪ 1,250");
    expect(formatAgorotCompact(agorot(200_00))).toBe("₪ 200");
  });

  it("has no decimal places", () => {
    expect(formatAgorotCompact(agorot(48_050))).not.toContain(".");
  });

  it("rounds half away from zero for display", () => {
    // 480.50 -> 481, documented as lossy display-only rounding
    expect(formatAgorotCompact(agorot(48_050))).toBe("₪ 481");
  });

  it("prefixes a negative amount with a minus sign", () => {
    expect(formatAgorotCompact(agorot(-48_000))).toBe("-₪ 480");
  });
});
