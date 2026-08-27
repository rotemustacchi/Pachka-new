/** Row shape returned by a query. Modules narrow this with their own types. */
export type Row = Record<string, unknown>;

export interface QueryResult<T> {
  readonly rows: T[];
  readonly rowCount: number;
}

/** Anything you can run SQL against: the pool, or a transaction. */
export interface Sql {
  query<T = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Convenience for the very common "one row or nothing" read. */
  maybeOne<T = Row>(text: string, params?: readonly unknown[]): Promise<T | null>;
  /** Like `maybeOne` but throws `notFound` when there is no row. */
  one<T = Row>(text: string, params?: readonly unknown[]): Promise<T>;
}

/**
 * A transaction handle. Every statement issued through it runs on ONE dedicated
 * connection, which is what makes `select ... for update` mean anything: the
 * lock is held by this connection until the transaction commits or rolls back.
 */
export interface Tx extends Sql {
  /** Roll back at the end of the callback even if it returns normally. */
  rollbackOnly(): void;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel;
  readonly readOnly?: boolean;
}

export interface Database extends Sql {
  /**
   * Run `fn` inside a transaction on a single dedicated connection.
   *
   * Commits when `fn` resolves, rolls back when it throws, and always returns
   * the connection to the pool. Nested calls join the outer transaction via a
   * savepoint rather than opening a second one.
   */
  withTransaction<T>(fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Close every pooled connection. Call in process shutdown and in tests. */
  end(): Promise<void>;
}
