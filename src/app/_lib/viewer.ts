/**
 * Who is asking, in a page.
 *
 * `(accounts)/deps.ts` already answers this for Server Actions and Route
 * Handlers, and this is deliberately NOT a copy of it. Two things differ, and
 * both are forced by the context:
 *
 *   1. A Server Component may not write cookies. Next throws if you try, so the
 *      cookie adapter here has a no-op `setAll` -- a page reads the session, it
 *      does not refresh it. Passing `(accounts)`' writable adapter into a page
 *      render is the mistake this function exists to prevent.
 *   2. A page needs "nobody is signed in" as a VALUE, not as a thrown error,
 *      because what happens next differs by surface: the artist's studio sends
 *      a visitor to sign in, and an admin surface returns not-found instead
 *      (see `src/app/admin/access.ts`).
 *
 * `getUser()` rather than `getSession()`, for the same reason `requireUserId`
 * gives: the former revalidates the token with the auth server, the latter
 * trusts whatever is in the cookie.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/shared/db";

/** The signed-in account's id, or `null`. Never read from a parameter. */
export async function currentUserId(): Promise<string | null> {
  const store = await cookies();

  const client = createSupabaseServerClient({
    getAll: () => store.getAll(),
    setAll: () => {
      /* a page render cannot write cookies; see the header */
    },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

/**
 * The signed-in id, or a redirect to sign-in.
 *
 * Takes the id rather than reading it, so the decision -- "no session means go
 * and sign in" -- is testable without a request scope. `redirect()` works by
 * throwing, so the `never` return is real: nothing after it runs.
 */
export function signedInOrRedirect(userId: string | null): string {
  if (userId === null) redirect(SIGN_IN_PATH);
  return userId;
}

/**
 * Where an unauthenticated visitor is sent.
 *
 * `/sign-in` is the route that exists (`src/app/(accounts)/sign-in`). Note that
 * `shared/ui`'s SiteHeader links to `/login`, which does not; that is reported
 * rather than fixed here, because the header is not this agent's file.
 */
export const SIGN_IN_PATH = "/sign-in";
