"use client";

/**
 * "New artwork" — a form rather than a link, because creating a draft is a
 * write. A GET link that inserts a row is the classic prefetch hazard: the
 * browser (or a crawler, or a link preview) follows it and the artist finds
 * empty drafts they never asked for.
 */
import { useActionState } from "react";
import { Button } from "@/shared/ui";
import { createDraftAction } from "./actions";

export function NewArtworkButton() {
  // `createDraftAction` redirects on success, so this state only ever holds the
  // pending flag; there is no message to render.
  const [, create, creating] = useActionState(async () => {
    await createDraftAction();
  }, null);

  return (
    <form action={create}>
      <Button type="submit" disabled={creating}>
        {creating ? "פותח טיוטה…" : "יצירה חדשה"}
      </Button>
    </form>
  );
}
