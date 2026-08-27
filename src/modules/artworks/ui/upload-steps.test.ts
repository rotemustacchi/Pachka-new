/**
 * The step model.
 *
 * The property that matters most is the last one in this file: the form's idea
 * of "what is missing" is the SAME function the server runs at publish time. A
 * second list of required fields maintained alongside the first is how a button
 * ends up saying "ready" while the server says "four fields missing".
 */
import { describe, expect, it } from "vitest";
import { missingForPublication, type PublishCandidate } from "../publish-requirements";
import {
  allMissing,
  canPublish,
  firstIncompleteStep,
  publishButtonCaption,
  remainingCount,
  stepAfter,
  stepBefore,
  stepStatuses,
  STEP_ORDER,
  type UploadFormState,
} from "./upload-steps";

const COMPLETE_CANDIDATE: PublishCandidate = {
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

const READY: UploadFormState = { candidate: COMPLETE_CANDIDATE, imageCount: 1 };

const withCandidate = (overrides: Partial<PublishCandidate>): UploadFormState => ({
  ...READY,
  candidate: { ...COMPLETE_CANDIDATE, ...overrides },
});

describe("the four steps", () => {
  it("are always all present, in order, complete or not", () => {
    const statuses = stepStatuses(withCandidate({ title: null }));

    expect(statuses.map((step) => step.id)).toEqual([...STEP_ORDER]);
    expect(statuses).toHaveLength(4);
  });

  it("cover images, classification, specifications and declarations", () => {
    expect([...STEP_ORDER]).toEqual([
      "images",
      "classification",
      "specifications",
      "declarations",
    ]);
  });

  it("are all complete for a finished listing with an image", () => {
    expect(stepStatuses(READY).every((step) => step.complete)).toBe(true);
    expect(canPublish(READY)).toBe(true);
    expect(remainingCount(READY)).toBe(0);
  });
});

describe("routing a missing field to its step", () => {
  it("puts the classification axes on the classification step", () => {
    const statuses = stepStatuses(withCandidate({ medium: null, styles: [], moods: [] }));
    const classification = statuses.find((step) => step.id === "classification");

    expect(classification?.missing.map((requirement) => requirement.field)).toEqual([
      "medium",
      "styles",
      "moods",
    ]);
    expect(classification?.complete).toBe(false);
  });

  it("puts the specification fields on the specifications step", () => {
    const statuses = stepStatuses(withCandidate({ weightGrams: null, leadTimeDays: null }));
    const specifications = statuses.find((step) => step.id === "specifications");

    expect(specifications?.missing.map((requirement) => requirement.field)).toEqual([
      "weightGrams",
      "leadTimeDays",
    ]);
  });

  it("puts both declarations on the declarations step", () => {
    const statuses = stepStatuses(withCandidate({ originality: null, aiAssisted: null }));
    const declarations = statuses.find((step) => step.id === "declarations");

    expect(declarations?.missing.map((requirement) => requirement.field)).toEqual([
      "originality",
      "aiAssisted",
    ]);
  });

  /**
   * Images are not part of the server's publish gate -- they live in another
   * table written by another module -- so the step model states the requirement
   * itself rather than pretending `missingForPublication` covers it.
   */
  it("asks for at least one image on the images step", () => {
    const statuses = stepStatuses({ candidate: COMPLETE_CANDIDATE, imageCount: 0 });
    const images = statuses.find((step) => step.id === "images");

    expect(images?.complete).toBe(false);
    expect(images?.missing.map((requirement) => requirement.field)).toEqual(["images"]);
  });

  it("treats one image as enough", () => {
    const statuses = stepStatuses({ candidate: COMPLETE_CANDIDATE, imageCount: 1 });

    expect(statuses.find((step) => step.id === "images")?.complete).toBe(true);
  });
});

describe("the publish button caption", () => {
  it("says only 'publish' when nothing is missing", () => {
    expect(publishButtonCaption(READY)).toBe("פרסום");
  });

  /** Hebrew is inflected: "נותרו 1 שדות" would be wrong. */
  it("uses the singular for exactly one missing field", () => {
    expect(publishButtonCaption(withCandidate({ weightGrams: null }))).toBe(
      "נותר שדה חובה אחד לפני פרסום",
    );
  });

  /** The design's own string: "נותרו 2 שדות חובה לפני פרסום". */
  it("counts the plural, as the approved design does", () => {
    expect(publishButtonCaption(withCandidate({ weightGrams: null, materials: null }))).toBe(
      "נותרו 2 שדות חובה לפני פרסום",
    );
  });

  it("counts a missing image alongside missing fields", () => {
    const state: UploadFormState = {
      candidate: { ...COMPLETE_CANDIDATE, weightGrams: null },
      imageCount: 0,
    };

    expect(remainingCount(state)).toBe(2);
  });
});

describe("where the form opens", () => {
  it("opens on the first step still waiting for something", () => {
    expect(firstIncompleteStep(withCandidate({ aiAssisted: null }))).toBe("declarations");
    expect(firstIncompleteStep(withCandidate({ medium: null }))).toBe("classification");
    expect(firstIncompleteStep({ candidate: COMPLETE_CANDIDATE, imageCount: 0 })).toBe("images");
  });

  it("opens on the earliest incomplete step when several are waiting", () => {
    const state: UploadFormState = {
      candidate: { ...COMPLETE_CANDIDATE, medium: null, aiAssisted: null },
      imageCount: 1,
    };

    expect(firstIncompleteStep(state)).toBe("classification");
  });

  it("opens on the last step when the listing is ready", () => {
    expect(firstIncompleteStep(READY)).toBe("declarations");
  });
});

describe("moving between steps", () => {
  it("walks forwards and stops at the end", () => {
    expect(stepAfter("images")).toBe("classification");
    expect(stepAfter("specifications")).toBe("declarations");
    expect(stepAfter("declarations")).toBeNull();
  });

  it("walks backwards and stops at the start", () => {
    expect(stepBefore("declarations")).toBe("specifications");
    expect(stepBefore("images")).toBeNull();
  });
});

describe("the form and the server agree", () => {
  /**
   * The whole reason the step model derives from `missingForPublication`
   * instead of keeping its own list. If these two ever disagree, the button
   * says "ready" and the publish call returns a list of missing fields the
   * artist cannot see anywhere on the form.
   */
  it("reports exactly what the server's publish gate reports, plus images", () => {
    const candidate: PublishCandidate = {
      ...COMPLETE_CANDIDATE,
      title: null,
      medium: null,
      weightGrams: null,
      aiAssisted: null,
    };

    const serverSays = missingForPublication(candidate).map((r) => r.field);
    const formSays = allMissing({ candidate, imageCount: 1 }).map((r) => r.field);

    expect([...formSays].sort()).toEqual([...serverSays].sort());
  });

  it("says nothing is missing exactly when the server would publish it", () => {
    expect(canPublish(READY)).toBe(true);
    expect(missingForPublication(COMPLETE_CANDIDATE)).toEqual([]);
  });
});
