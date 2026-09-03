/**
 * Wiring for the admin surfaces.
 *
 * Two builders, because a page and a Server Action live in different worlds: a
 * page may read cookies and may not write them, an action may do both. Handing
 * a page the writable adapter is the mistake `_lib/viewer.ts` describes.
 *
 * What is deliberately absent:
 *
 *   • `uploads` — the module exists in the tree but publishes no `index.ts`
 *     yet, and nothing outside a module may import a deeper path
 *     (ARCHITECTURE.md). So `listQueue` falls back to `noFlaggedUploads` and
 *     the queue shows reports only. Wiring it is one line here once that file
 *     lands.
 *   • `mailer` — absent means an artist's takedown notice is recorded as
 *     undelivered rather than silently dropped, which is the module's own
 *     stated behaviour. `takeDownArtwork` returns `artistNotified: false` and
 *     the page says so.
 *   • `payouts` — not shipped; suspension reports outstanding payouts as
 *     unavailable rather than as zero.
 *
 * All three are seams, not defaults dressed up as answers.
 */
import { cookies } from "next/headers";
import { getDatabase, createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/shared/db";
import { publicEnv } from "@/shared/config";
import { createSupabaseAuthGateway, type AuthGateway } from "@/modules/accounts";
import { depsWithoutOrdersOrMatchmaker } from "@/modules/artworks";
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
    // Takedown hands this on to `removeArtwork`. The demand source is the
    // zero-reporting stand-in until `orders` ships, which takedown does not
    // consult in any case: a takedown deliberately ignores reservations.
    artworks: depsWithoutOrdersOrMatchmaker(db),
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
