/**
 * Reviews — tasks 2.8 and 2.9.
 *
 * The eligibility rule spans the orders module, which accounts may not depend
 * on -- it is the one module in ARCHITECTURE.md's table with no outgoing edges.
 * So accounts takes it as a port (`OrderEligibility`). Two implementations are
 * tested here: the fail-closed default, and the SQL one that reads the orders
 * tables. While the orders migration has not landed, the latter is exercised
 * against a MINIMAL stand-in `orders` / `fulfilments` pair created inside the
 * test's own throwaway database -- the columns accounts reads and nothing more,
 * written down as a contract in src/modules/accounts/README.md.
 *
 * Everything else here — the unique constraint, the rating bounds, the
 * self-review check, the published flag, the aggregate — is real behaviour of
 * the real table, tested against real Postgres.
 */
import { describe, expect, it } from "vitest";
import { asAnon, useTestDatabase, withPrivilegedConnection, type TestDatabase } from "../harness";
import { FakeAuthGateway } from "../fakes/auth-gateway";
import {
  denyAllOrders,
  editReview,
  getArtistReviews,
  register,
  restoreReviewsForOrder,
  sqlOrderEligibility,
  submitReview,
  summarise,
  suspendAccount,
  upgradeToArtist,
  withdrawReviewsForReturnedOrder,
  type AccountsDeps,
  type OrderEligibility,
} from "@/modules/accounts";
import { giveArtistAnArtwork } from "../support/accounts-artwork-fixture";
import type { Database } from "@/shared/db";

const PASSWORD = "a-long-enough-passphrase";

/** Allows everything. Stands in for the orders module during these tests. */
const allowAllOrders: OrderEligibility = {
  async hasDeliveredOrder() {
    return true;
  },
};

function deps(db: Database): AccountsDeps & { auth: FakeAuthGateway } {
  return { db, auth: new FakeAuthGateway() };
}

async function account(db: Database, email: string, name: string): Promise<string> {
  const d = deps(db);
  await register(d, { email, password: PASSWORD, displayName: name });
  return d.auth.idFor(email);
}

async function artistAccount(db: Database): Promise<string> {
  const d = deps(db);
  await register(d, { email: "yael@example.com", password: PASSWORD, displayName: "Yael" });
  const userId = d.auth.idFor("yael@example.com");
  await upgradeToArtist(d, userId, {
    displayName: "Yael Schwartz",
    biography: "Painter from Tel Aviv.",
    city: "Tel Aviv",
  });
  return userId;
}

const ORDER = "8a1f0000-0000-4000-8000-000000000001";

describe("leaving a review", () => {
  const database = useTestDatabase();

  it("stores it against the artist and the order", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    const review = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 5,
      body: "הגיע ארוז מצוין ובדיוק בזמן.",
    });

    expect(review).toMatchObject({ artistId, buyerId, orderId: ORDER, rating: 5 });
  });

  it("attributes it to the buyer's display name", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    const review = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 5,
    });

    expect(review.buyerDisplayName).toBe("Michal R.");
  });

  it("accepts a rating with no text", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    const review = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 4,
    });

    expect(review.body).toBe("");
  });
});

describe("reviews that must be rejected", () => {
  const database = useTestDatabase();

  it("rejects a buyer with no delivered order from that artist", async () => {
    // accounts-and-profiles, "Non-purchaser attempts a review".
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    await expect(
      submitReview(database.db, denyAllOrders, {
        orderId: ORDER,
        artistId,
        buyerId,
        rating: 5,
      }),
    ).rejects.toMatchObject({ kind: "forbidden", code: "accounts.review_not_eligible" });
  });

  it("stores nothing when the buyer is not eligible", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    await expect(
      submitReview(database.db, denyAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 }),
    ).rejects.toThrow();

    const { rowCount } = await database.db.query("select 1 from reviews");
    expect(rowCount).toBe(0);
  });

  it("rejects a second review on the same order", async () => {
    // accounts-and-profiles, "Duplicate review on one order".
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });

    await expect(
      submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 1 }),
    ).rejects.toMatchObject({ kind: "conflict", code: "accounts.review_already_exists" });
  });

  it("offers the edit path in the duplicate message", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });

    await expect(
      submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 1 }),
    ).rejects.toThrow(/edit/i);
  });

  it("leaks no constraint name in the duplicate message", async () => {
    // SECURITY.md S2-26: raw driver detail never crosses to a client.
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });

    const message = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 1,
    }).catch((error: Error) => error.message);

    for (const word of ["constraint", "violates", "duplicate key", "reviews_one_per"]) {
      expect(String(message).toLowerCase()).not.toContain(word);
    }
  });

  it("rejects an artist reviewing themselves", async () => {
    // SECURITY.md S2-24: one account holds both roles by design, so this is a
    // real path. The database check backs up the block in orders.
    const artistId = await artistAccount(database.db);

    await expect(
      submitReview(database.db, allowAllOrders, {
        orderId: ORDER,
        artistId,
        buyerId: artistId,
        rating: 5,
      }),
    ).rejects.toMatchObject({ kind: "forbidden", code: "accounts.self_review" });
  });

  it.each([0, 6, -1, 2.5])("rejects a rating of %s", async (rating) => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    await expect(
      submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("rejects review text containing contact details", async () => {
    // SECURITY.md S2-19 item 1 names review text explicitly: it is buyer-written
    // free text on a public surface, so it is scanned like any other.
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    await expect(
      submitReview(database.db, allowAllOrders, {
        orderId: ORDER,
        artistId,
        buyerId,
        rating: 5,
        body: "אפשר להשיג אותה ישירות ב 050-123-4567",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("editing a review", () => {
  const database = useTestDatabase();

  it("replaces the rating and the text", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    const created = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 5,
      body: "מצוין",
    });

    const edited = await editReview(database.db, {
      reviewId: created.id,
      buyerId,
      rating: 3,
      body: "בסדר",
    });

    expect(edited).toMatchObject({ id: created.id, rating: 3, body: "בסדר" });
  });

  it("creates no second row", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    const created = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 5,
    });

    await editReview(database.db, { reviewId: created.id, buyerId, rating: 2 });

    const { rowCount } = await database.db.query("select 1 from reviews");
    expect(rowCount).toBe(1);
  });

  it("refuses to edit somebody else's review", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    const otherId = await account(database.db, "ori@example.com", "Ori K.");
    const created = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 5,
    });

    await expect(
      editReview(database.db, { reviewId: created.id, buyerId: otherId, rating: 1 }),
    ).rejects.toMatchObject({ kind: "not_found" });

    const row = await database.db.one<{ rating: number }>(
      "select rating from reviews where id = $1",
      [created.id],
    );
    expect(Number(row.rating)).toBe(5);
  });

  it("rejects contact details introduced by an edit", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    const created = await submitReview(database.db, allowAllOrders, {
      orderId: ORDER,
      artistId,
      buyerId,
      rating: 5,
    });

    await expect(
      editReview(database.db, {
        reviewId: created.id,
        buyerId,
        rating: 5,
        body: "yael@gmail.com",
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});

describe("a review whose order is returned", () => {
  const database = useTestDatabase();

  it("disappears from the artist's public reviews", async () => {
    // SECURITY.md S2-24 item 4, resolving spec gap SPEC-H: the spec says nothing
    // about what happens to a review when its order is later returned.
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });

    await withdrawReviewsForReturnedOrder(database.db, ORDER);

    const { reviews } = await getArtistReviews(database.db, artistId);
    expect(reviews).toEqual([]);
  });

  it("is retained for admin review rather than deleted", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });

    await withdrawReviewsForReturnedOrder(database.db, ORDER);

    const row = await database.db.one<{ published: boolean; rating: number }>(
      "select published, rating from reviews where order_id = $1",
      [ORDER],
    );
    expect(row.published).toBe(false);
    expect(Number(row.rating)).toBe(5);
  });

  it("is invisible to an anonymous visitor through the data API", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });
    await withdrawReviewsForReturnedOrder(database.db, ORDER);

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query("select * from reviews");
      return result.rows;
    });

    expect(rows).toEqual([]);
  });

  it("comes back if the return is cancelled", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });
    await withdrawReviewsForReturnedOrder(database.db, ORDER);

    await restoreReviewsForOrder(database.db, ORDER);

    const { reviews } = await getArtistReviews(database.db, artistId);
    expect(reviews).toHaveLength(1);
  });
});

describe("the aggregate rating", () => {
  const database = useTestDatabase();

  async function threeReviews(db: Database): Promise<string> {
    const artistId = await artistAccount(db);
    const ratings = [5, 4, 5];
    for (const [index, rating] of ratings.entries()) {
      const buyerId = await account(db, `buyer${index}@example.com`, `Buyer ${index}`);
      await submitReview(db, allowAllOrders, {
        orderId: `8a1f0000-0000-4000-8000-00000000000${index + 1}`,
        artistId,
        buyerId,
        rating,
      });
    }
    return artistId;
  }

  it("averages the published reviews to one decimal", async () => {
    const artistId = await threeReviews(database.db);

    const { summary } = await getArtistReviews(database.db, artistId);

    expect(summary).toEqual({ average: 4.7, count: 3 });
  });

  it("excludes a withdrawn review from both the average and the count", async () => {
    const artistId = await threeReviews(database.db);

    await withdrawReviewsForReturnedOrder(database.db, "8a1f0000-0000-4000-8000-000000000002");

    const { summary } = await getArtistReviews(database.db, artistId);
    expect(summary).toEqual({ average: 5, count: 2 });
  });

  it("is null with no reviews, rather than zero", async () => {
    // Zero would render as a zero-star artist, which is not what "no reviews
    // yet" means.
    const artistId = await artistAccount(database.db);

    const { summary } = await getArtistReviews(database.db, artistId);

    expect(summary).toEqual({ average: null, count: 0 });
  });

  it("agrees with the reviews it is listed above", async () => {
    const artistId = await threeReviews(database.db);

    const { reviews, summary } = await getArtistReviews(database.db, artistId);

    expect(summarise(reviews)).toEqual(summary);
  });

  it("lists newest first", async () => {
    const artistId = await threeReviews(database.db);

    const { reviews } = await getArtistReviews(database.db, artistId);

    const times = reviews.map((r) => new Date(r.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("reviews through the data API", () => {
  const database = useTestDatabase();

  it("are readable by an anonymous visitor once the artist is public", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });
    await giveArtistAnArtwork(database.db, artistId);

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query<{ rating: number }>("select rating from reviews");
      return result.rows;
    });

    expect(rows).toHaveLength(1);
  });

  it("cannot be written by a signed-in user", async () => {
    // Eligibility spans the orders module and is enforced server-side, so there
    // is no data-API write path at all -- stricter than the policy matrix.
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    const { asUser } = await import("../harness");
    await expect(
      asUser(database.dataApi, buyerId, (tx) =>
        tx.query(
          "insert into reviews (order_id, artist_id, buyer_id, rating) values ($1, $2, auth.uid(), 5)",
          [ORDER, artistId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("show the reviewer's display name, which means their profile row stays readable", async () => {
    // `profiles` is scoped to accounts with a public presence. A buyer who has
    // never listed anything is not public -- but the moment their review is
    // displayed on an artist's page, their display name is on that page, and a
    // hidden profile row would render the review anonymously. The spec requires
    // attribution ("Reviews SHALL be attributed to the buyer's display name").
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });
    await giveArtistAnArtwork(database.db, artistId);

    const names = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query<{ display_name: string }>(
        "select display_name from profiles where user_id = $1",
        [buyerId],
      );
      return result.rows.map((r) => r.display_name);
    });

    expect(names).toEqual(["Michal R."]);
  });

  it("stop exposing the reviewer once the review is withdrawn", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });
    await giveArtistAnArtwork(database.db, artistId);

    await withdrawReviewsForReturnedOrder(database.db, ORDER);

    const names = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query<{ display_name: string }>(
        "select display_name from profiles where user_id = $1",
        [buyerId],
      );
      return result.rows.map((r) => r.display_name);
    });

    expect(names).toEqual([]);
  });

  it("are hidden for a suspended artist", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await submitReview(database.db, allowAllOrders, { orderId: ORDER, artistId, buyerId, rating: 5 });
    await suspendAccount(deps(database.db), artistId, "Repeated takedowns");

    const rows = await asAnon(database.dataApi, async (tx) => {
      const result = await tx.query("select * from reviews");
      return result.rows;
    });

    expect(rows).toEqual([]);
  });
});

describe("the SQL eligibility reader", () => {
  const database = useTestDatabase();

  /**
   * The columns accounts reads, and nothing more. See src/modules/accounts/README.md.
   *
   * Created only while the orders module has not landed its own migration --
   * ten teams write into one migrations directory, so this has to be a no-op
   * once the real tables arrive rather than a duplicate-table error. When they
   * do arrive, whoever notices these tests failing updates this helper to build
   * a delivered order the real way.
   */
  async function createStandInOrders(database: TestDatabase): Promise<void> {
    const db = database.db;
    const present = await db.one<{ present: boolean }>(
      "select to_regclass('public.orders') is not null as present",
    );
    if (present.present) return;

    // Created with owner credentials, like any other table, then given the
    // same shape every real table has: RLS on and forced, nothing for anon, and
    // an explicit policy for the role the server connects as. A stand-in that
    // was readable without a policy would be a softer table than the one it
    // stands in for, and the eligibility reader below would be proved against
    // conditions `orders` will not actually offer it.
    await withPrivilegedConnection(
      database,
      "applying schema, which the migration runner does with owner credentials",
      async (client) => {
        await client.query(
          "create table orders (id uuid primary key, buyer_id uuid not null, status text not null)",
        );
        await client.query(
          "create table fulfilments (id uuid primary key default gen_random_uuid(), order_id uuid not null, artist_id uuid not null)",
        );
        for (const table of ["orders", "fulfilments"]) {
          await client.query(`alter table ${table} enable row level security`);
          await client.query(`alter table ${table} force row level security`);
          await client.query(
            `create policy ${table}_stand_in on ${table} for select to anon using (false)`,
          );
          await client.query(
            `create policy ${table}_server on ${table} for all to service_role using (true) with check (true)`,
          );
          await client.query(
            `grant select, insert, update, delete on ${table} to service_role`,
          );
        }
      },
    );
  }

  it("fails closed while the orders tables do not exist", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");

    const allowed = await sqlOrderEligibility.hasDeliveredOrder(database.db, {
      orderId: ORDER,
      artistId,
      buyerId,
    });

    expect(allowed).toBe(false);
  });

  it("allows a buyer with a delivered order from that artist", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await createStandInOrders(database);
    await database.db.query("insert into orders (id, buyer_id, status) values ($1, $2, 'delivered')", [
      ORDER,
      buyerId,
    ]);
    await database.db.query("insert into fulfilments (order_id, artist_id) values ($1, $2)", [
      ORDER,
      artistId,
    ]);

    const allowed = await sqlOrderEligibility.hasDeliveredOrder(database.db, {
      orderId: ORDER,
      artistId,
      buyerId,
    });

    expect(allowed).toBe(true);
  });

  it("refuses when the order has not reached delivered", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await createStandInOrders(database);
    await database.db.query("insert into orders (id, buyer_id, status) values ($1, $2, 'shipped')", [
      ORDER,
      buyerId,
    ]);
    await database.db.query("insert into fulfilments (order_id, artist_id) values ($1, $2)", [
      ORDER,
      artistId,
    ]);

    const allowed = await sqlOrderEligibility.hasDeliveredOrder(database.db, {
      orderId: ORDER,
      artistId,
      buyerId,
    });

    expect(allowed).toBe(false);
  });

  it("refuses a different buyer's delivered order", async () => {
    const artistId = await artistAccount(database.db);
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    const strangerId = await account(database.db, "ori@example.com", "Ori K.");
    await createStandInOrders(database);
    await database.db.query("insert into orders (id, buyer_id, status) values ($1, $2, 'delivered')", [
      ORDER,
      buyerId,
    ]);
    await database.db.query("insert into fulfilments (order_id, artist_id) values ($1, $2)", [
      ORDER,
      artistId,
    ]);

    const allowed = await sqlOrderEligibility.hasDeliveredOrder(database.db, {
      orderId: ORDER,
      artistId,
      buyerId: strangerId,
    });

    expect(allowed).toBe(false);
  });

  it("refuses an artist who had no fulfilment on that order", async () => {
    const artistId = await artistAccount(database.db);
    const otherArtist = await account(database.db, "dana@example.com", "Dana L.");
    const buyerId = await account(database.db, "michal@example.com", "Michal R.");
    await createStandInOrders(database);
    await database.db.query("insert into orders (id, buyer_id, status) values ($1, $2, 'delivered')", [
      ORDER,
      buyerId,
    ]);
    await database.db.query("insert into fulfilments (order_id, artist_id) values ($1, $2)", [
      ORDER,
      artistId,
    ]);

    const allowed = await sqlOrderEligibility.hasDeliveredOrder(database.db, {
      orderId: ORDER,
      artistId: otherArtist,
      buyerId,
    });

    expect(allowed).toBe(false);
  });
});
