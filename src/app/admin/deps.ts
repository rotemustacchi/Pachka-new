/**
 * Wiring for the admin surfaces.
 *
 * Two builders, because a page and a Server Action live in different worlds: a
 * page may read cookies and may not write them, an action may do both. Handing
 * a page the writable adapter is the mistake `_lib/viewer.ts` describes.
 *
 * What is deliberately absent:
 *
 *   • `mailer` — absent means an artist's takedown notice is recorded as
 *     undelivered rather than silently dropped, which is the module's own
 *     stated behaviour. `takeDownArtwork` returns `artistNotified: false` and
 *     the page says so.
 *   • `payouts` — not shipped; suspension reports outstanding payouts as
 *     unavailable rather than as zero.
 *
 * Both are seams, not defaults dressed up as answers.
 *
 * What is no longer absent, and was:
 *
 *   • `uploads` — it publishes an `index.ts` now, so `listQueue` no longer
 *     falls back to `noFlaggedUploads`. Left unwired, the queue shows open
 *     reports only, and an upload the pipeline flagged for a human decision
 *     waits for a human who is never shown it.
 *   • `artworks` — its deps came from `depsWithoutOrdersOrMatchmaker` while
 *     `orders` and `matchmaker` did not exist. Both have shipped, so they now
 *     come from the composition root with the real demand and impression
 *     sources wired in.
 */
import { cookies } from "next/headers";
import { getDatabase, createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/shared/db";
import { publicEnv } from "@/shared/config";
import { createSupabaseAuthGateway, type AuthGateway } from "@/modules/accounts";
import { flaggedUploadSource } from "@/modules/uploads";
import { artworksDeps } from "@/app/_lib/deps";
import type { ModerationDeps } from "@/modules/moderation";

type CookieWrites = "allowed" | "forbidden";

async function authGateway(writes: CookieWrites): Promise<AuthGateway> {
  const store = await cookies();

  const client = createSupabaseServerClient({
    getAll: () => store.getAll(),
    setAll: (toSet) => {
      if (writes === "forbidden") return;
      for (const { name, value, options } of toSet) store.set(name, value, options);
    },
  });

  // Lazily: a request that never needs admin access never builds a
  // service-role client, and that client throws if the key is absent.
  return createSupabaseAuthGateway({ client, admin: createSupabaseServiceRoleClient });
}

async function moderationDeps(writes: CookieWrites): Promise<ModerationDeps> {
  const db = getDatabase();
  return {
    db,
    auth: await authGateway(writes),
    siteUrl: publicEnv().NEXT_PUBLIC_SITE_URL,
    // `uploads` now publishes an `index.ts`, so the queue no longer falls back
    // to `noFlaggedUploads`. Without this the admin queue shows open reports
    // only, and an upload the pipeline flagged for a human decision waits for a
    // human who is never shown it.
    uploads: flaggedUploadSource(),
    // Takedown hands this on to `removeArtwork`. The demand source is now the
    // real one from `orders` — takedown does not consult it in any case, since
    // a takedown deliberately ignores reservations, but every other artworks
    // call reached through these deps does, and `noDemand` would report every
    // artwork as fully available.
    artworks: artworksDeps(db),
  };
}

/** For a page render. */
export function moderationDepsForPage(): Promise<ModerationDeps> {
  return moderationDeps("forbidden");
}

/** For a Server Action, which may refresh the session. */
export function moderationDepsForAction(): Promise<ModerationDeps> {
  return moderationDeps("allowed");
}
