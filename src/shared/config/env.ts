/**
 * Environment configuration.
 *
 * Two surfaces, deliberately separated: `serverEnv()` may only be called on the
 * server and carries secrets; `publicEnv()` is safe in the browser and contains
 * nothing that is not already visible to a user. Reading a server variable from
 * a client component is then a type-and-runtime error rather than a leak.
 *
 * Parsed lazily and cached, so importing this module never throws at build time
 * for a variable that is only needed at request time.
 */
import { z } from "zod";

const serverSchema = z.object({
  /** Direct PostgreSQL connection used by `shared/db`. */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Service-role key: full access, server only, never sent to the browser. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  /** Anon key. Public by design; RLS is what protects the data behind it. */
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;

function fail(what: string, error: z.ZodError): never {
  const lines = error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(
    [`${what} is misconfigured:`, ...lines, "", "See .env.example for the full list."].join("\n"),
  );
}

let cachedServer: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() was called in the browser. Use publicEnv() there.");
  }
  if (!cachedServer) {
    const parsed = serverSchema.safeParse(process.env);
    if (!parsed.success) fail("Server environment", parsed.error);
    cachedServer = parsed.data;
  }
  return cachedServer;
}

let cachedPublic: PublicEnv | undefined;

export function publicEnv(): PublicEnv {
  if (!cachedPublic) {
    // Referenced as literal property accesses so Next's build-time inlining
    // can replace them in the client bundle.
    const parsed = publicSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    });
    if (!parsed.success) fail("Public environment", parsed.error);
    cachedPublic = parsed.data;
  }
  return cachedPublic;
}

/** Test seam: forget parsed values so a test can change process.env. */
export function resetEnvCache(): void {
  cachedServer = undefined;
  cachedPublic = undefined;
}
