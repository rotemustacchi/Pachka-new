/**
 * Who has to confirm packaging, and the insurance the MVP does not sell.
 */
import { describe, expect, it } from "vitest";
import { packagingObligationFor } from "./packaging";

describe("packagingObligationFor()", () => {
  it("applies to ceramics and objects however the taxonomy spells it", () => {
    for (const medium of ["ceramics and objects", "ceramics_and_objects", "Ceramics And Objects"]) {
      const obligation = packagingObligationFor({ medium });
      expect(obligation.required, medium).toBe(true);
      expect(obligation.reason, medium).toBe("medium");
    }
  });

  it("applies to anything the artist marked fragile, whatever its medium", () => {
    const obligation = packagingObligationFor({ medium: "photography", fragile: true });
    expect(obligation.required).toBe(true);
    expect(obligation.reason).toBe("artist_marked");
  });

  it("does not apply to an unmarked print", () => {
    const obligation = packagingObligationFor({ medium: "painting and illustration" });
    expect(obligation.required).toBe(false);
    expect(obligation.requirements).toEqual([]);
  });

  it("states requirements the artist can actually comply with, not advice", () => {
    const codes = packagingObligationFor({ fragile: true }).requirements.map((r) => r.code);
    expect(codes).toContain("double_wall_box");
    expect(codes).toContain("immobilise");
    expect(codes).toContain("fragile_marking");
  });

  it("offers no breakage insurance, fragile or not", () => {
    // "The MVP SHALL NOT offer breakage insurance." Asserted on both branches
    // so that adding one to either would fail here.
    expect(packagingObligationFor({ fragile: true }).breakageInsuranceOffered).toBe(false);
    expect(packagingObligationFor({ medium: "jewelry" }).breakageInsuranceOffered).toBe(false);
  });
});
