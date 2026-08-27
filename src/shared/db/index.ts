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
  type LintFinding,
  type Migration,
  type MigrationStatus,
} from "./migrations";
