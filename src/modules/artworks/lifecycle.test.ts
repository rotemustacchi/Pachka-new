/**
 * The lifecycle state machine, exhaustively.
 *
 * The machine is a table, so the test is written against every state pair
 * rather than against the paths somebody remembered. That is the point of
 * stating it as data: a pair nobody thought about shows up here as a row in the
 * matrix rather than as a gap.
 */
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/errors";
import {
  assertTransition,
  canTransition,
  isBuyerVisible,
  isPubliclyListed,
  permittedTransitions,
  type Actor,
} from "./lifecycle";
import { ARTWORK_STATUSES, type ArtworkStatus } from "./types";

const ACTORS: readonly Actor[] = ["artist", "admin", "system"];

describe("what an artist may do", () => {
  /**
   * artwork-listings: "An artist MAY move their own artwork between `draft`,
   * `published`, and `unlisted`." All six of those edges, stated one by one.
   */
  it.each([
    ["draft", "published"],
    ["published", "unlisted"],
    ["published", "draft"],
    ["unlisted", "published"],
    ["unlisted", "draft"],
  ] as const)("moves %s -> %s", (from, to) => {
    expect(canTransition({ from, to, by: "artist" }).permitted).toBe(true);
  });

  /** "Only an admin MAY set `removed`." */
  it.each(["draft", "published", "unlisted"] as const)(
    "cannot remove their own artwork from %s",
    (from) => {
      const verdict = canTransition({ from, to: "removed", by: "artist" });

      expect(verdict.permitted).toBe(false);
      expect(verdict.permitted === false && verdict.reason).toMatch(/admin/i);
    },
  );

  /** `sold` is set by reconciliation from derived availability, never by hand. */
  it("cannot mark an artwork sold", () => {
    expect(canTransition({ from: "published", to: "sold", by: "artist" }).permitted).toBe(false);
  });

  it("cannot move an artwork out of sold", () => {
    expect(canTransition({ from: "sold", to: "published", by: "artist" }).permitted).toBe(false);
    expect(canTransition({ from: "sold", to: "unlisted", by: "artist" }).permitted).toBe(false);
  });
});

describe("removed", () => {
  /**
   * artwork-listings: "a `removed` artwork SHALL NOT be restorable by the
   * artist". moderation-admin goes further -- lifting a suspension restores
   * previously published artworks "excluding any individually removed" -- which
   * only has a stable meaning if removal is one-way for everyone.
   */
  it.each(ACTORS)("is terminal for %s", (actor) => {
    for (const to of ARTWORK_STATUSES) {
      if (to === "removed") continue;
      expect(
        canTransition({ from: "removed", to, by: actor }).permitted,
        `removed -> ${to} by ${actor} must be refused`,
      ).toBe(false);
    }
  });

  it("explains itself to the artist rather than saying only 'not permitted'", () => {
    const verdict = canTransition({ from: "removed", to: "published", by: "artist" });

    expect(verdict.permitted).toBe(false);
    expect(verdict.permitted === false && verdict.code).toBe("artworks.removed_is_terminal");
    expect(verdict.permitted === false && verdict.reason).toMatch(/admin/);
  });

  it("offers an artist no actions at all", () => {
    expect(permittedTransitions("removed", "artist")).toEqual([]);
  });
});

describe("the machine as a whole", () => {
  /**
   * A pair absent from the table is refused. This asserts the default is
   * "refuse", across every state pair and every actor -- so that forgetting to
   * think about a pair cannot silently allow it.
   */
  it("refuses every pair it does not explicitly permit", () => {
    const permitted: string[] = [];

    for (const from of ARTWORK_STATUSES) {
      for (const actor of ACTORS) {
        for (const to of permittedTransitions(from, actor)) {
          permitted.push(`${from}->${to} by ${actor}`);
        }
      }
    }

    expect([...permitted].sort()).toEqual(
      [
        "draft->published by admin",
        "draft->published by artist",
        "draft->removed by admin",
        "published->draft by admin",
        "published->draft by artist",
        "published->removed by admin",
        "published->sold by system",
        "published->unlisted by admin",
        "published->unlisted by artist",
        "sold->published by system",
        "sold->removed by admin",
        "unlisted->draft by admin",
        "unlisted->draft by artist",
        "unlisted->published by admin",
        "unlisted->published by artist",
        "unlisted->removed by admin",
      ].sort(),
    );
  });

  /** A double-clicked publish button should not be an error. */
  it.each(ARTWORK_STATUSES)("treats %s -> itself as a permitted no-op", (status) => {
    expect(canTransition({ from: status, to: status, by: "artist" }).permitted).toBe(true);
  });

  it("throws a conflict, not a validation error, when refusing", () => {
    // The input is well-formed; it is the current state that refuses it.
    expect(() => assertTransition({ from: "removed", to: "published", by: "artist" })).toThrow(
      AppError,
    );

    try {
      assertTransition({ from: "removed", to: "published", by: "artist" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as AppError).kind).toBe("conflict");
    }
  });

  it("does not throw for a permitted transition", () => {
    expect(() => assertTransition({ from: "draft", to: "published", by: "artist" })).not.toThrow();
  });
});

describe("visibility", () => {
  /** "Only `published` artworks appear in the catalog and matchmaker results." */
  it.each(ARTWORK_STATUSES)("lists %s publicly only when it is published", (status) => {
    expect(isPubliclyListed(status)).toBe(status === "published");
  });

  /**
   * catalog-browse: sold and unlisted artworks render read-only with no
   * purchase action, and a removed one returns not-found. A draft never existed
   * as far as a buyer is concerned.
   */
  it.each([
    ["published", true],
    ["sold", true],
    ["unlisted", true],
    ["draft", false],
    ["removed", false],
  ] as const)("makes %s reachable on a detail page: %s", (status, expected) => {
    expect(isBuyerVisible(status as ArtworkStatus)).toBe(expected);
  });
});
