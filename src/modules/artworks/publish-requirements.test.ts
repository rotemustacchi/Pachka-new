/**
 * The publish gate.
 *
 * The property worth testing is not "it catches a missing weight" -- it is that
 * it catches ALL of them in one pass. artwork-listings requires publication to
 * be blocked with every missing field listed, and the approved upload design
 * puts a live remaining-count on the button, which is only possible if this is
 * a complete survey rather than a short-circuit.
 */
import { describe, expect, it } from "vitest";
import {
  isReadyToPublish,
  missingForPublication,
  remainingRequirementCount,
  toFieldErrors,
  type PublishCandidate,
} from "./publish-requirements";

const COMPLETE: PublishCandidate = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג.",
  priceAgorot: 125_000,
  heightMm: 1000,
  widthMm: 700,
  depthMm: null,
  weightGrams: 1850,
  materials: "אקריליק על בד פשתן",
  isFramed: null,
  leadTimeDays: 5,
  medium: "textile_clothing",
  styles: ["minimalist"],
  moods: ["calm"],
  originality: { declaredBy: "artist-1", declaredAt: "2026-08-27T00:00:00.000Z" },
  aiAssisted: false,
  inventoryType: "unique",
  madeToOrder: false,
  productionLeadTimeDays: null,
};

const fields = (candidate: PublishCandidate) =>
  missingForPublication(candidate).map((requirement) => requirement.field);

describe("a complete listing", () => {
  it("is ready to publish", () => {
    expect(missingForPublication(COMPLETE)).toEqual([]);
    expect(isReadyToPublish(COMPLETE)).toBe(true);
    expect(remainingRequirementCount(COMPLETE)).toBe(0);
  });
});

describe("collecting every missing field", () => {
  /**
   * The spec's scenario, exactly: dimensions, weight and lead time all absent,
   * and the answer names all of them. An artist told about one field at a time
   * is made to do three round trips to learn one thing.
   */
  it("names dimensions, weight and lead time together rather than the first one", () => {
    const missing = fields({
      ...COMPLETE,
      heightMm: null,
      widthMm: null,
      weightGrams: null,
      leadTimeDays: null,
    });

    expect(missing).toEqual(["heightMm", "widthMm", "weightGrams", "leadTimeDays"]);
  });

  it("names an empty listing's fields all at once", () => {
    const empty: PublishCandidate = {
      title: null,
      description: null,
      priceAgorot: null,
      heightMm: null,
      widthMm: null,
      depthMm: null,
      weightGrams: null,
      materials: null,
      isFramed: null,
      leadTimeDays: null,
      medium: null,
      styles: [],
      moods: [],
      originality: null,
      aiAssisted: null,
      inventoryType: "unique",
      madeToOrder: false,
      productionLeadTimeDays: null,
    };

    expect(fields(empty)).toEqual([
      "title",
      "description",
      "priceAgorot",
      "medium",
      "styles",
      "moods",
      "heightMm",
      "widthMm",
      "weightGrams",
      "materials",
      "leadTimeDays",
      "originality",
      "aiAssisted",
    ]);
  });

  /** The count on the publish button: "נותרו 2 שדות חובה לפני פרסום". */
  it("counts what remains", () => {
    expect(remainingRequirementCount({ ...COMPLETE, weightGrams: null, materials: null })).toBe(2);
  });

  it("gives every missing field a message the form can render in place", () => {
    const missing = missingForPublication({ ...COMPLETE, weightGrams: null, title: null });

    for (const requirement of missing) {
      expect(requirement.message.length).toBeGreaterThan(0);
    }
    expect(Object.keys(toFieldErrors(missing)).sort()).toEqual(["title", "weightGrams"].sort());
  });

  it("treats whitespace-only text as missing", () => {
    // "   " in a title field is not a title, and the database's own
    // `length(btrim(title)) >= 2` check would refuse it anyway -- better to say
    // so on the form than to fail at the last moment.
    expect(fields({ ...COMPLETE, title: "   ", materials: "\t\n" })).toEqual([
      "title",
      "materials",
    ]);
  });
});

describe("the classification requirements", () => {
  it("requires a medium, at least one style and at least one mood", () => {
    expect(fields({ ...COMPLETE, medium: null })).toContain("medium");
    expect(fields({ ...COMPLETE, styles: [] })).toContain("styles");
    expect(fields({ ...COMPLETE, moods: [] })).toContain("moods");
  });

  /** artwork-listings makes target space "zero or more". It is never required. */
  it("never requires a target space", () => {
    expect(missingForPublication(COMPLETE)).toEqual([]);
    expect(fields({ ...COMPLETE, styles: [] })).not.toContain("target_spaces");
  });

  /**
   * When no medium is chosen, the depth and framing questions do not apply yet.
   * Listing them would tell an artist to answer questions about a medium they
   * have not picked.
   */
  it("does not ask for depth or framing before a medium is chosen", () => {
    const missing = fields({ ...COMPLETE, medium: null, depthMm: null, isFramed: null });

    expect(missing).toContain("medium");
    expect(missing).not.toContain("depthMm");
    expect(missing).not.toContain("isFramed");
  });
});

describe("the conditional specification fields", () => {
  it("requires a depth for a three-dimensional medium", () => {
    expect(fields({ ...COMPLETE, medium: "ceramics_objects", depthMm: null })).toContain("depthMm");
    expect(fields({ ...COMPLETE, medium: "ceramics_objects", depthMm: 160 })).not.toContain(
      "depthMm",
    );
  });

  it("does not require a depth for a flat medium", () => {
    expect(fields({ ...COMPLETE, medium: "photography", depthMm: null })).not.toContain("depthMm");
  });

  it("requires the framing answer for a wall-mounted medium", () => {
    expect(fields({ ...COMPLETE, medium: "painting_illustration", isFramed: null })).toContain(
      "isFramed",
    );
  });

  it("accepts 'not framed' as a complete framing answer", () => {
    expect(fields({ ...COMPLETE, medium: "painting_illustration", isFramed: false })).not.toContain(
      "isFramed",
    );
  });

  it("does not ask a jeweller whether a ring is framed", () => {
    expect(fields({ ...COMPLETE, medium: "jewelry", depthMm: 10, isFramed: null })).not.toContain(
      "isFramed",
    );
  });

  it("requires a production lead time only for a made-to-order piece", () => {
    const edition = { ...COMPLETE, inventoryType: "edition" } as const;

    expect(fields({ ...edition, madeToOrder: true })).toContain("productionLeadTimeDays");
    expect(fields({ ...edition, madeToOrder: true, productionLeadTimeDays: 21 })).not.toContain(
      "productionLeadTimeDays",
    );
    expect(fields({ ...edition, madeToOrder: false })).not.toContain("productionLeadTimeDays");
  });

  /**
   * A one-of-a-kind piece that already exists is not made to order. Held as a
   * publish requirement rather than a table constraint so that a draft may
   * carry the combination while the artist is still switching between the two.
   */
  it("refuses a made-to-order unique piece, naming the field", () => {
    expect(
      fields({ ...COMPLETE, inventoryType: "unique", madeToOrder: true, productionLeadTimeDays: 21 }),
    ).toContain("madeToOrder");
  });
});

describe("the declarations", () => {
  it("blocks publication without the originality affirmation", () => {
    expect(fields({ ...COMPLETE, originality: null })).toContain("originality");
  });

  /**
   * The AI question has three states and only two of them are answers.
   * `false` is a complete answer; `null` is "never asked", and the spec makes
   * that a blocker in its own right.
   */
  it("blocks publication when the AI question is unanswered", () => {
    expect(fields({ ...COMPLETE, aiAssisted: null })).toContain("aiAssisted");
  });

  it.each([true, false])("accepts %s as a complete answer to the AI question", (answer) => {
    expect(fields({ ...COMPLETE, aiAssisted: answer })).not.toContain("aiAssisted");
  });

  it("asks the artist to answer rather than to declare AI use", () => {
    // The wording matters: an artist who used no AI must not read the message
    // as an accusation.
    const [requirement] = missingForPublication({ ...COMPLETE, aiAssisted: null });

    expect(requirement?.field).toBe("aiAssisted");
    expect(requirement?.message).toContain("לענות");
  });
});
