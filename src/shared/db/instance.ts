/**
 * The process-wide database client.
 *
 * Created lazily so that importing anything from `shared/db` does not open a
 * connection — build-time module evaluation and unit tests must not need a
 * database. Integration tests never use this: they get their own client from
 * the test harness, pointed at their own database.
 */
import { serverEnv } from "@/shared/config/env";
import { createDatabase } from "./client";
import type { Database } from "./types";

let instance: Database | undefined;

export function getDatabase(): Database {
  if (!instance) {
    instance = createDatabase({
      connectionString: serverEnv().DATABASE_URL,
      // Vercel's free tier runs many short-lived lambdas against Supabase's
      // pooler; a small per-instance pool keeps the total connection count down.
      max: Number(process.env["DATABASE_POOL_MAX"] ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return instance;
}

/** Test/teardown seam: drop the singleton so the next call rebuilds it. */
export async function resetDatabase(): Promise<void> {
  const previous = instance;
  instance = undefined;
  await previous?.end();
}
