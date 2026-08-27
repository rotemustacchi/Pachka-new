/**
 * The PACHKA database client.
 *
 * Module code talks to Postgres through this, not through `@supabase/supabase-js`.
 * The reason is `select ... for update`: reserving a one-of-a-kind artwork is a
 * transactional problem (ARCHITECTURE.md, "Reservation is transactional") and
 * PostgREST gives no way to hold a row lock across statements. The Supabase JS
 * client remains the right tool for auth and storage — see `src/shared/db/supabase.ts`.
 *
 * Because this connects as the database owner, row-level security does not
 * constrain it. RLS is the boundary for the anon/authenticated keys used from
 * the browser; server-side module code is trusted and enforces its own rules.
 * Both layers are required — see `db/README.md`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { AppError } from "@/shared/errors";
import type {
  Database,
  IsolationLevel,
  QueryResult,
  Row,
  Sql,
  TransactionOptions,
  Tx,
} from "./types";

// `bigint` (OID 20) arrives as a string so that values above 2^53 survive.
// Money is agorot in a bigint column, so this matters: parse it deliberately at
// the call site (`shared/money`) rather than silently losing precision here.

interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

function sqlOn(target: Queryable): Sql {
  const query = async <T = Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> => {
    const result = await target.query(text, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  };

  const maybeOne = async <T = Row>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> => {
    const { rows } = await query<T>(text, params);
    if (rows.length > 1) {
      throw new Error(`Expected at most one row, got ${rows.length}`);
    }
    return rows[0] ?? null;
  };

  const one = async <T = Row>(text: string, params: readonly unknown[] = []): Promise<T> => {
    const row = await maybeOne<T>(text, params);
    if (row === null) throw AppError.notFound("Row not found");
    return row;
  };

  return { query, maybeOne, one };
}

const ISOLATION: Record<IsolationLevel, string> = {
  "read committed": "read committed",
  "repeatable read": "repeatable read",
  serializable: "serializable",
};

export function createDatabase(config: string | PoolConfig): Database {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);

  // An idle-client error (server restart, network drop) is emitted on the pool
  // and would otherwise be an unhandled 'error' event and crash the process.
  pool.on("error", () => {
    /* the client is discarded by pg; the next checkout gets a fresh one */
  });

  const poolSql = sqlOn(pool);

  // Tracks the transaction depth for the current connection, so a nested
  // `withTransaction` becomes a savepoint instead of a second `begin`.
  const depths = new WeakMap<PoolClient, number>();
  const active = new AsyncLocalStorage<PoolClient>();

  async function runTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const existing = active.getStore();
    if (existing) return runNested(existing, fn);

    const client = await pool.connect();
    depths.set(client, 1);
    const begin = ["begin"];
    if (options.isolationLevel) begin.push(`isolation level ${ISOLATION[options.isolationLevel]}`);
    if (options.readOnly) begin.push("read only");
    await client.query(begin.join(" "));

    let rollbackOnly = false;
    const tx: Tx = { ...sqlOn(client), rollbackOnly: () => void (rollbackOnly = true) };

    try {
      const result = await active.run(client, () => fn(tx));
      if (rollbackOnly) {
        await client.query("rollback");
      } else {
        await client.query("commit");
      }
      return result;
    } catch (cause) {
      try {
        await client.query("rollback");
      } catch {
        // The connection is already broken; releasing it with an error below
        // makes pg discard it rather than return a poisoned client to the pool.
      }
      throw cause;
    } finally {
      depths.delete(client);
      client.release();
    }
  }

  async function runNested<T>(client: PoolClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const depth = (depths.get(client) ?? 1) + 1;
    depths.set(client, depth);
    const name = `pachka_sp_${depth}`;
    await client.query(`savepoint ${name}`);

    let rollbackOnly = false;
    const tx: Tx = { ...sqlOn(client), rollbackOnly: () => void (rollbackOnly = true) };
    try {
      const result = await fn(tx);
      if (rollbackOnly) {
        await client.query(`rollback to savepoint ${name}`);
      } else {
        await client.query(`release savepoint ${name}`);
      }
      return result;
    } catch (cause) {
      await client.query(`rollback to savepoint ${name}`);
      throw cause;
    } finally {
      depths.set(client, depth - 1);
    }
  }

  return {
    ...poolSql,
    withTransaction: (fn, options = {}) => runTransaction(fn, options),
    end: () => pool.end(),
  };
}
