/**
 * The listing lifecycle state machine.
 *
 * artwork-listings, "Listing lifecycle": an artwork occupies exactly one of
 * `draft`, `published`, `sold`, `unlisted`, `removed`. Only `published`
 * artworks appear in the catalog and the matchmaker. An artist may move their
 * own artwork between `draft`, `published` and `unlisted`. Only an admin may set
 * `removed`, and a removed artwork is not restorable by the artist.
 *
 * WHY THE EDGES ARE DATA
 * ----------------------
 * The alternative is an `if` in each of five functions, and the failure mode of
 * that is a sixth function somewhere else that sets a status without consulting
 * any of them. Stating the machine as a table means `canTransition` is the only
 * question anybody has to ask, and the test that asserts every state pair
 * behaves as the spec says can be written against the table rather than against
 * whichever paths somebody remembered to cover.
 *
 * `orders.transition()` does the same job for orders (ARCHITECTURE.md: "Order
 * state changes go through one function"). This is that pattern for listings.
 *
 * `removed` IS TERMINAL
 * ---------------------
 * Not just artist-terminal. moderation-admin: takedown "SHALL immediately
 * withdraw it from the catalog, the matchmaker, and the artist's ability to
 * republish", and lifting a suspension restores previously published artworks
 * "excluding any individually removed". If an admin could move a removed
 * artwork back to published, "excluding any individually removed" would have no
 * stable meaning -- the suspension-lift path would have to distinguish a
 * takedown from a reinstated takedown, and nothing records that. One-way is
 * what both specs describe, so one-way is what this encodes.
 */
import { AppError } from "@/shared/errors";
import type { ArtworkStatus } from "./types";

/** Who is asking for the change. Not a role string: the machine branches on it. */
export type Actor =
  /** The artist who owns the listing. */
  | "artist"
  /** A platform admin, acting through moderation. */
  | "admin"
  /**
   * PACHKA itself, with no person behind it: the sale that exhausts an edition,
   * the cancellation that returns a unit. Not reachable from any route.
   */
  | "system";

interface Edge {
  readonly to: ArtworkStatus;
  readonly by: readonly Actor[];
  /** Why this edge exists, quoted back to a caller that is refused a different one. */
  readonly note: string;
}

/**
 * Every permitted transition, keyed by the state being left.
 *
 * A state pair absent from this table is refused. That is deliberate: a machine
 * that defaults to permitting is a machine where forgetting to think about a
 * pair silently allows it.
 */
const EDGES: Readonly<Record<ArtworkStatus, readonly Edge[]>> = {
  draft: [
    {
      to: "published",
      by: ["artist", "admin"],
      note: "An artist publishes their own draft once it is complete.",
    },
    { to: "removed", by: ["admin"], note: "An admin may take down a draft." },
  ],

  published: [
    {
      to: "unlisted",
      by: ["artist", "admin"],
      note: "An artist may withdraw a listing they own.",
    },
    {
      to: "draft",
      by: ["artist", "admin"],
      note: "An artist may take a listing back to draft to rework it.",
    },
    {
      to: "sold",
      by: ["system"],
      note: "Set by reconciliation when derived availability reaches zero, never by hand.",
    },
    { to: "removed", by: ["admin"], note: "Admin takedown." },
  ],

  unlisted: [
    { to: "published", by: ["artist", "admin"], note: "An artist may relist their own artwork." },
    { to: "draft", by: ["artist", "admin"], note: "An artist may take a listing back to draft." },
    { to: "removed", by: ["admin"], note: "Admin takedown." },
  ],

  sold: [
    {
      to: "published",
      by: ["system"],
      note:
        "An edition returns to published when a cancelled or expired order frees a unit. " +
        "Reconciliation decides this from derived availability; it is not an artist action.",
    },
    { to: "removed", by: ["admin"], note: "Admin takedown, which does not affect orders already placed." },
  ],

  // Terminal. See the file header.
  removed: [],
};

export interface TransitionRequest {
  readonly from: ArtworkStatus;
  readonly to: ArtworkStatus;
  readonly by: Actor;
}

export type TransitionVerdict =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: string; readonly code: string };

/**
 * Decide one transition.
 *
 * Returns a verdict rather than throwing, so that a caller assembling several
 * checks -- the dashboard deciding which buttons to render, for instance -- can
 * ask without exception handling. `assertTransition` is the throwing form.
 */
export function canTransition({ from, to, by }: TransitionRequest): TransitionVerdict {
  if (from === to) {
    // Not an error, and not a state change either. Treating it as permitted
    // makes "publish an already-published artwork" idempotent, which is what a
    // double-clicked button should do.
    return { permitted: true };
  }

  if (from === "removed") {
    return {
      permitted: false,
      code: "artworks.removed_is_terminal",
      reason:
        "This artwork was removed by a platform admin and cannot be republished. " +
        "If you believe the removal was a mistake, reply to the notice you received.",
    };
  }

  const edge = EDGES[from].find((candidate) => candidate.to === to);
  if (!edge) {
    return {
      permitted: false,
      code: "artworks.transition_not_permitted",
      reason: `An artwork cannot move from ${from} to ${to}.`,
    };
  }

  if (!edge.by.includes(by)) {
    return {
      permitted: false,
      code: "artworks.transition_not_permitted_for_actor",
      reason:
        by === "artist" && edge.by.includes("admin") && !edge.by.includes("artist")
          ? `Only a platform admin can move an artwork from ${from} to ${to}.`
          : `Moving an artwork from ${from} to ${to} is not something ${by === "system" ? "the system" : `an ${by}`} does. ${edge.note}`,
    };
  }

  return { permitted: true };
}

/** `canTransition`, as an exception. Throws `conflict`, because the input is fine and the state refuses it. */
export function assertTransition(request: TransitionRequest): void {
  const verdict = canTransition(request);
  if (verdict.permitted) return;

  throw AppError.conflict(verdict.reason, {
    code: verdict.code,
    details: { from: request.from, to: request.to, by: request.by },
  });
}

/** Every state an actor could move this artwork to right now. Drives the dashboard's buttons. */
export function permittedTransitions(from: ArtworkStatus, by: Actor): readonly ArtworkStatus[] {
  return EDGES[from].filter((edge) => edge.by.includes(by)).map((edge) => edge.to);
}

/** Whether the artwork is visible on public surfaces. The catalog and matchmaker ask this. */
export function isPubliclyListed(status: ArtworkStatus): boolean {
  return status === "published";
}

/**
 * Whether a buyer may open a detail page for it at all.
 *
 * catalog-browse: sold and unlisted artworks render read-only with no purchase
 * action; a removed one returns not-found. So `removed` and `draft` are the two
 * that do not exist as far as a buyer is concerned.
 */
export function isBuyerVisible(status: ArtworkStatus): boolean {
  return status === "published" || status === "sold" || status === "unlisted";
}

export const ARTWORK_STATUS_LABELS: Readonly<Record<ArtworkStatus, string>> = {
  draft: "טיוטה",
  published: "מפורסם",
  sold: "נמכר",
  unlisted: "הוסר מהתצוגה",
  removed: "הוסר על ידי הצוות",
};
