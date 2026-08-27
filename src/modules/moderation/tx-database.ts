/**
 * Present a transaction as a `Database`, so a module API that takes one can be
 * called inside somebody else's transaction.
 *
 * This exists for one reason, and it is the reason SECURITY.md S1-14 item 3
 * gives: the audit row must be written in the SAME transaction as the action it
 * records. `accounts.suspendAccount` takes an `AccountsDeps` whose `db` is a
 * `Database`, and it issues `deps.db.query(...)` -- which checks out a
 * connection from the pool. Called from inside a moderation transaction, that
 * would be a second connection and a second transaction: the suspension would
 * commit on its own, and a failed audit insert would roll back nothing.
 *
 * Wrapping the live `Tx` puts those statements on the one connection that is
 * already holding the transaction open. `withTransaction` runs the callback
 * against the same handle rather than opening anything, which is what the real
 * client does for a nested call anyway (it takes a savepoint).
 *
 * Note what this deliberately does NOT do: `end()` is a no-op, because the
 * caller owns the pool and a callee closing it would be a bug that only shows
 * up under load.
 */
import type { Database, Tx } from "@/shared/db";

export function txAsDatabase(tx: Tx): Database {
  return {
    query: (text, params) => tx.query(text, params),
    maybeOne: (text, params) => tx.maybeOne(text, params),
    one: (text, params) => tx.one(text, params),
    withTransaction: (fn) => fn(tx),
    end: async () => {
      /* the caller owns the pool */
    },
  };
}
