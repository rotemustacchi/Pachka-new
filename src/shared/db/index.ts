/**
 * `shared/db` — the database client, the transaction helper, and the migration
 * runner. Every module imports Postgres access from here and nowhere else.
 */
export { createDatabase } from "./client";
export { getDatabase } from "./instance";
export type {
  Database,
  IsolationLevel,
  QueryResult,
  Row,
  Sql,
  TransactionOptions,
  Tx,
} from "./types";
export {
  lintMigrations,
  loadMigrations,
  migrate,
  migrationFilename,
  status as migrationStatus,
  MIGRATIONS_DIR,
  LEDGER_SCHEMA,
  LEDGER_TABLE,
  type LintFinding,
  type Migration,
  type MigrationStatus,
} from "./migrations";
// Auth and storage only — subject to RLS. Module data access does not use
// these; see the header comment in ./supabase.ts and db/README.md.
export {
  createSupabaseBrowserClient,
  createSupabaseServerClient,
  createSupabaseServiceRoleClient,
} from "./supabase";
