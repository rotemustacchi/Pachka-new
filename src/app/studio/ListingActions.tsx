"use client";

/**
 * The lifecycle buttons on one dashboard row.
 *
 * A Client Component because the interesting outcome is a REFUSAL that has to
 * land next to the button that caused it: "this artwork is being bought right
 * now and cannot be withdrawn until that order completes or expires". A plain
 * `<form action={...}>` would surface that as an error page, which loses the
 * sentence and the artist's place in the list.
 *
 * It receives three scalars and no row. React serialises the whole prop object
 * of a Client Component into the payload embedded in the HTML (SECURITY.md
 * S1-8), so what it is not given cannot leak -- and the artwork id is already
 * in the artist's own URL space.
 *
 * Which buttons exist is decided by the state machine, not here:
 * `permittedTransitions` is what fills `availableActions` on the row.
 */
import { useActionState } from "react";
import { Button } from "@/shared/ui";
import { IDLE, type FormState } from "../_lib/form-state";
import { returnToDraftAction, unlistArtworkAction } from "./actions";

export interface ListingActionsProps {
  readonly artworkId: string;
  readonly canUnlist: boolean;
  readonly canReturnToDraft: boolean;
}

export function ListingActions({ artworkId, canUnlist, canReturnToDraft }: ListingActionsProps) {
  const [unlisted, unlist, unlisting] = useActionState(unlistArtworkAction, IDLE);
  const [drafted, draft, drafting] = useActionState(returnToDraftAction, IDLE);

  const spoken: FormState = unlisted.status === "idle" ? drafted : unlisted;

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        {canUnlist ? (
          <form action={unlist}>
            <input type="hidden" name="artworkId" value={artworkId} />
            <Button type="submit" variant="secondary" disabled={unlisting}>
              {unlisting ? "מסיר…" : "הסרה מהקטלוג"}
            </Button>
          </form>
        ) : null}

        {canReturnToDraft ? (
          <form action={draft}>
            <input type="hidden" name="artworkId" value={artworkId} />
            <Button type="submit" variant="secondary" disabled={drafting}>
              {drafting ? "מחזיר…" : "החזרה לטיוטה"}
            </Button>
          </form>
        ) : null}
      </div>

      {spoken.status !== "idle" && spoken.message ? (
        <p
          role="status"
          aria-live="polite"
          className={[
            "m-0 border-s-4 px-3 py-2 text-[13px]",
            spoken.status === "error"
              ? "border-alert bg-card text-alert"
              : "border-affirm bg-card text-ink-soft",
          ].join(" ")}
        >
          {spoken.message}
        </p>
      ) : null}
    </div>
  );
}
