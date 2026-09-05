/**
 * Wiring, not logic.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. Building
 * the dependencies a module needs is part of "call a module API" — the module
 * does not reach into `next/headers` itself, because the correct cookie adapter
 * differs by context and deciding that is a routing concern.
 */
import { cookies } from "next/headers";
import { getDatabase, createSupabaseServerClient, createSupabaseServiceRoleClient } from "@/shared/db";
import { createSupabaseAuthGateway, type AccountsDeps } from "@/modules/accounts";
import { AppError } from "@/shared/errors";

/**
 * Dependencies for a Server Action or Route Handler — a context that may both
 * read cookies and write the refreshed session back.
 */
export async function accountsDeps(): Promise<AccountsDeps> {
  const store = await cookies();

  const client = createSupabaseServerClient({
    getAll: () => store.getAll(),
    setAll: (toSet) => {
      for (const { name, value, options } of toSet) store.set(name, value, options);
    },
  });

  return {
    db: getDatabase(),
    auth: createSupabaseAuthGateway({
      client,
      // Lazily: a request that never needs admin access never builds a
      // service-role client, and that client throws if the key is absent.
      admin: createSupabaseServiceRoleClient,
    }),
  };
}

/**
 * The client IP, for rate limiting.
 *
 * Read from the proxy headers Vercel sets. It is only ever hashed before it is
 * stored (SECURITY.md's log-redaction rule puts raw client IPs on the
 * never-stored list), and it is a rate-limit key and never an authorization
 * input — a spoofed value buys a slightly larger quota and nothing else.
 */
export async function requestIp(): Promise<string | undefined> {
  const { headers } = await import("next/headers");
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
}

/**
 * The signed-in account's id, from the session — never from a parameter.
 *
 * This exists because of a mistake that is easy to make with Server Actions:
 * binding the user's id into the action with `.bind(null, userId)`. That value
 * travels to the browser and comes back with the request, which makes identity
 * an INPUT to the action rather than a fact about it. An attacker replays the
 * action with somebody else's id and upgrades their account, or overwrites
 * their profile. Next.js encrypts bound arguments, but a security property that
 * depends on a framework's serialisation detail is one framework upgrade from
 * being a vulnerability.
 *
 * `getUser()` rather than `getSession()`: the former revalidates the token with
 * the auth server, the latter trusts whatever is in the cookie.
 */
/**
 * The signed-in user, or null.
 *
 * `requireUserId` throws, which is right for an action but wrong for a page:
 * a page needs to decide what to RENDER for a visitor who is not signed in,
 * and it cannot do that from an exception. Without this, /become-an-artist
 * showed its whole form to anonymous visitors and only refused them after they
 * had filled it in.
 */
export async function currentUserId(): Promise<string | null> {
  const store = await cookies();
  const client = createSupabaseServerClient({
    getAll: () => store.getAll(),
    setAll: (toSet) => {
      for (const { name, value, options } of toSet) store.set(name, value, options);
    },
  });

  const { data, error } = await client.auth.getUser();
  return error || !data.user ? null : data.user.id;
}

export async function requireUserId(): Promise<string> {
  const store = await cookies();
  const client = createSupabaseServerClient({
    getAll: () => store.getAll(),
    setAll: (toSet) => {
      for (const { name, value, options } of toSet) store.set(name, value, options);
    },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw AppError.forbidden("Please sign in first.", { code: "accounts.not_signed_in" });
  }
  return data.user.id;
}
