/**
 * `withTransaction`, against a real database.
 *
 * The orders module builds inventory reservation on this helper, and
 * ARCHITECTURE.md is unambiguous about how: "SELECT ... FOR UPDATE on the
 * artwork row inside a transaction. There is no application-level lock, no
 * optimistic retry loop, no advisory-lock substitute." That only works if
 * `withTransaction` hands the callback one connection and keeps it for the
 * whole transaction, so the last group of tests races two genuinely concurrent
 * transactions and asserts exactly one wins.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../harness";
import { AppError } from "@/shared/errors";

describe("withTransaction", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    await database.db.query("create table probe (id integer primary key, note text)");
  });

  afterEach(async () => {
    await database.drop();
  });

  const notes = async (): Promise<string[]> => {
    const { rows } = await database.db.query<{ note: string }>(
      "select note from probe order by id",
    );
    return rows.map((r) => r.note);
  };

  it("commits the work when the callback returns", async () => {
    const returned = await database.db.withTransaction(async (tx) => {
      await tx.query("insert into probe (id, note) values (1, 'kept')");
      return "result";
    });

    expect(returned).toBe("result");
    expect(await notes()).toEqual(["kept"]);
  });

  it("rolls everything back when the callback throws", async () => {
    await expect(
      database.db.withTransaction(async (tx) => {
        await tx.query("insert into probe (id, note) values (1, 'doomed')");
        throw AppError.conflict("nope");
      }),
    ).rejects.toMatchObject({ kind: "conflict" });

    expect(await notes()).toEqual([]);
  });

  it("rolls back on request without throwing", async () => {
    const returned = await database.db.withTransaction(async (tx) => {
      await tx.query("insert into probe (id, note) values (1, 'discarded')");
      tx.rollbackOnly();
      return "still returned";
    });

    expect(returned).toBe("still returned");
    expect(await notes()).toEqual([]);
  });

  it("returns the connection to the pool after a failure", async () => {
    // A transaction that leaves its connection in a failed state would poison
    // the pool and every later query in the process would fail.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(
        database.db.withTransaction(async (tx) => {
          await tx.query("insert into probe (id, note) values (1, 'x')");
          await tx.query("select this_function_does_not_exist()");
        }),
      ).rejects.toThrow();
    }

    await database.db.query("insert into probe (id, note) values (99, 'after')");
    expect(await notes()).toEqual(["after"]);
  });

  describe("nesting", () => {
    it("joins the outer transaction rather than starting a second one", async () => {
      await expect(
        database.db.withTransaction(async (outer) => {
          await outer.query("insert into probe (id, note) values (1, 'outer')");
          await database.db.withTransaction(async (inner) => {
            await inner.query("insert into probe (id, note) values (2, 'inner')");
          });
          throw new Error("outer fails after the inner one committed");
        }),
      ).rejects.toThrow(/outer fails/);

      // If the inner call had opened its own transaction on its own connection,
      // 'inner' would have survived the outer rollback.
      expect(await notes()).toEqual([]);
    });

    it("lets an inner failure be caught without losing the outer work", async () => {
      await database.db.withTransaction(async (outer) => {
        await outer.query("insert into probe (id, note) values (1, 'outer')");
        await expect(
          database.db.withTransaction(async (inner) => {
            await inner.query("insert into probe (id, note) values (2, 'inner')");
            throw new Error("inner fails");
          }),
        ).rejects.toThrow(/inner fails/);
        await outer.query("insert into probe (id, note) values (3, 'after')");
      });

      expect(await notes()).toEqual(["outer", "after"]);
    });
  });

  it("honours the requested isolation level", async () => {
    const level = await database.db.withTransaction(
      async (tx) => {
        const { rows } = await tx.query<{ transaction_isolation: string }>(
          "show transaction_isolation",
        );
        return rows[0]?.transaction_isolation;
      },
      { isolationLevel: "serializable" },
    );

    expect(level).toBe("serializable");
  });

  it("refuses to write in a read-only transaction", async () => {
    await expect(
      database.db.withTransaction(
        async (tx) => tx.query("insert into probe (id, note) values (1, 'nope')"),
        { readOnly: true },
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });
});

describe("SELECT ... FOR UPDATE under genuine concurrency", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    // Stands in for the artwork row the orders module will lock. Availability
    // is derived in the real schema (ARCHITECTURE.md); a single counter here is
    // enough to observe whether the lock serialises the two transactions.
    await database.db.query("create table unique_item (id integer primary key, sold boolean not null default false)");
    await database.db.query("insert into unique_item (id) values (1)");
  });

  afterEach(async () => {
    await database.drop();
  });

  /** One buyer's attempt to claim the single available unit. */
  const claim = async (label: string, gate: Promise<void>): Promise<string> =>
    database.db.withTransaction(async (tx) => {
      const row = await tx.one<{ sold: boolean }>(
        "select sold from unique_item where id = 1 for update",
      );
      // Both attempts reach the lock before either commits. Whichever gets the
      // lock second must see the first one's committed write, not the stale row.
      await gate;
      if (row.sold) throw AppError.conflict(`${label} lost`);
      await tx.query("update unique_item set sold = true where id = 1");
      return label;
    });

  it("lets exactly one of two concurrent claims succeed", async () => {
    // Release both attempts only once both have been issued, so they really do
    // overlap. No sleeps: the barrier resolves on a promise, not a timer.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = claim("first", gate);
    const second = claim("second", gate);
    release();

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ kind: "conflict" });

    const row = await database.db.one<{ sold: boolean }>("select sold from unique_item where id = 1");
    expect(row.sold).toBe(true);
  });

  it("lets exactly one of ten concurrent claims succeed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const attempts = Array.from({ length: 10 }, (_, i) => claim(`buyer-${i}`, gate));
    release();

    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(9);
  });

  it("blocks a second transaction until the first commits", async () => {
    const order: string[] = [];

    let firstHasLock!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      firstHasLock = resolve;
    });
    let allowCommit!: () => void;
    const commitAllowed = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });

    const holder = database.db.withTransaction(async (tx) => {
      await tx.query("select sold from unique_item where id = 1 for update");
      order.push("first-locked");
      firstHasLock();
      await commitAllowed;
      await tx.query("update unique_item set sold = true where id = 1");
      order.push("first-committed");
    });

    await lockTaken;

    const waiter = database.db.withTransaction(async (tx) => {
      await tx.query("select sold from unique_item where id = 1 for update");
      order.push("second-locked");
    });

    // The waiter cannot proceed while the holder has the row. Prove it by
    // letting the event loop drain: if the lock were not held, `second-locked`
    // would already be in `order`.
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["first-locked"]);

    allowCommit();
    await Promise.all([holder, waiter]);

    expect(order).toEqual(["first-locked", "first-committed", "second-locked"]);
  });
});
