/**
 * Supabase client factories — auth and storage ONLY.
 *
 * Module data access does NOT go through this file. It goes through
 * `shared/db` (`./client.ts`, node-postgres) instead, because reservation
 * correctness needs `select ... for update` held across statements inside
 * one transaction, which PostgREST cannot express (see the header comment on
 * `./client.ts` and `db/README.md`, "Two access paths, and why"). Everything
 * created here is constrained by row-level security — the service-role
 * client is the one deliberate exception, and it is gated hard below.
 */
import { createBrowserClient, createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/shared/config/env";

/**
 * Browser client, using the public anon key. Safe to call from Client
 * Components. RLS is the only thing standing between this client and the
 * data (db/README.md) — write and test policies as though this key is
 * public, because it is.
 */
export function createSupabaseBrowserClient(): SupabaseClient {
  const env = publicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Server client for Server Components, Server Actions, and Route Handlers.
 * Still the anon key — still subject to RLS — but backed by the request's
 * auth cookies via `@supabase/ssr`, so `auth.uid()` resolves to the signed-in
 * user rather than nobody.
 *
 * The caller supplies the cookie adapter rather than this module reaching
 * into `next/headers` itself, because the correct adapter differs by
 * context: a Server Component can only read cookies (omit `setAll`), while a
 * Server Action or Route Handler can also write the refreshed session back
 * (`getAll/setAll` both from `next/headers`' `cookies()`). Deciding which one
 * applies is a routing concern, and `app/` owns routing.
 */
export function createSupabaseServerClient(cookies: CookieMethodsServer): SupabaseClient {
  const env = publicEnv();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies,
  });
}

/**
 * Service-role client: bypasses row-level security entirely. Server-only,
 * on purpose, enforced twice:
 *
 *   - throws if called where `window` exists, so a bundling mistake that
 *     drags this into a client bundle fails immediately instead of shipping
 *     a full-access key to a browser;
 *   - throws if `SUPABASE_SERVICE_ROLE_KEY` is unset, rather than silently
 *     falling back to the anon key and quietly losing the access this call
 *     was presumably made for.
 *
 * There is no legitimate reason for module code to use this — it exists for
 * the handful of server-only operations (storage administration, auth user
 * management) that genuinely need to bypass RLS. Module data access still
 * goes through `shared/db`.
 */
export function createSupabaseServiceRoleClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error(
      "createSupabaseServiceRoleClient() was called in the browser. " +
        "The service-role key must never reach a client bundle.",
    );
  }

  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv();
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Refusing to fall back to the anon key: " +
        "code that asked for the service-role client is relying on RLS-bypassing access it will not get.",
    );
  }

  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv();
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
