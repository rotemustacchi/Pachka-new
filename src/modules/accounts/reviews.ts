/**
 * Reviews: one per completed order, editable, public on the artist's profile.
 *
 * THE CROSS-MODULE PROBLEM, AND HOW IT IS HANDLED
 * ----------------------------------------------
 * Review eligibility is a fact about orders: "this buyer has a delivered order
 * from this artist". ARCHITECTURE.md's dependency table says `accounts` may
 * call nothing -- it is the one module with no outgoing edges -- and the orders
 * module does not exist yet regardless.
 *
 * So eligibility is a port. `submitReview` takes an `OrderEligibility` and asks
 * it; it does not import from orders and never will. Two implementations ship
 * here:
 *
 *   `denyAllOrders`  the default, and what you get if you forget to pass one.
 *                    Refuses every review. Failing closed is the only safe
 *                    default for a check whose whole job is to refuse.
 *
 *   `sqlOrderEligibility`  reads the orders module's tables directly. Reading
 *                    across a module boundary is permitted -- ARCHITECTURE.md
 *                    forbids WRITES to another module's tables and expects
 *                    foreign keys across them. It resolves the tables at call
 *                    time and fails closed while they do not exist, so nothing
 *                    here breaks before orders ships and nothing silently opens
 *                    up either.
 *
 * The column names it assumes are written down in the accounts README as a
 * contract for the orders team, and there is a test asserting the fail-closed
 * behaviour so a mismatch surfaces as a failing test rather than as reviews
 * that quietly stop working.
 */
import { z } from "zod";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { SCANNER_VERSION, explainFindings, scanForContactDetails } from "./contact-scanner";

export interface ReviewEligibilityQuery {
  readonly orderId: string;
  readonly artistId: string;
  readonly buyerId: string;
}

export interface OrderEligibility {
  /** True when this buyer has a delivered order from this artist. */
  hasDeliveredOrder(db: Sql, query: ReviewEligibilityQuery): Promise<boolean>;
}

/** The default. Refuses everything, on purpose. */
export const denyAllOrders: OrderEligibility = {
  async hasDeliveredOrder() {
    return false;
  },
};

/**
 * Reads `orders` and `fulfilments` if they exist.
 *
 * The order carries the buyer and the delivered state (checkout-orders, "Order
 * state machine"); the fulfilment carries the artist, because one order splits
 * into a fulfilment per artist. Both must line up for the review to be allowed.
 */
export const sqlOrderEligibility: OrderEligibility = {
  async hasDeliveredOrder(db, { orderId, artistId, buyerId }) {
    const present = await db.one<{ ready: boolean }>(
      `select to_regclass('public.orders') is not null
          and to_regclass('public.fulfilments') is not null as ready`,
    );
    if (!present.ready) return false;

    try {
      const row = await db.maybeOne<{ ok: boolean }>(
        `select true as ok
           from public.orders o
           join public.fulfilments f on f.order_id = o.id
          where o.id = $1
            and o.buyer_id = $3
            and f.artist_id = $2
            and o.status = 'delivered'
          limit 1`,
        [orderId, artistId, buyerId],
      );
      return row !== null;
    } catch {
      // The tables exist but do not have the columns assumed above. Fail
      // closed, loudly in the test suite, rather than throwing at a buyer.
      return false;
    }
  },
};

export interface Review {
  readonly id: string;
  readonly orderId: string;
  readonly artistId: string;
  readonly buyerId: string;
  readonly buyerDisplayName: string;
  readonly rating: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface ReviewSummary {
  /** Mean rating to one decimal place, or null when there are none. */
  readonly average: number | null;
  readonly count: number;
}

export interface ArtistReviews {
  readonly reviews: readonly Review[];
  readonly summary: ReviewSummary;
}

export interface SubmitReviewInput {
  readonly orderId: string;
  readonly artistId: string;
  readonly buyerId: string;
  readonly rating: number;
  readonly body?: string;
}

const RatingSchema = z
  .number()
  .int("Please choose a whole number of stars.")
  .min(1, "Please choose between 1 and 5 stars.")
  .max(5, "Please choose between 1 and 5 stars.");

const BodySchema = z.string().trim().max(2000, "Please use at most 2000 characters.");

function validate(input: SubmitReviewInput): { rating: number; body: string } {
  const fields: Record<string, string[]> = {};

  const rating = RatingSchema.safeParse(input.rating);
  if (!rating.success) fields.rating = rating.error.issues.map((i) => i.message);

  const body = BodySchema.safeParse(input.body ?? "");
  if (!body.success) fields.body = body.error.issues.map((i) => i.message);

  if (body.success && body.data) {
    // Review text is buyer-written and lands on a public page, so it is scanned
    // like every other public free-text field (SECURITY.md S2-19 item 1 names
    // review text explicitly).
    const findings = scanForContactDetails(body.data);
    if (findings.length > 0) fields.body = [explainFindings(findings)];
  }

  if (Object.keys(fields).length > 0) {
    throw AppError.fieldsInvalid(fields, { code: "accounts.review_invalid" });
  }

  return { rating: rating.data!, body: body.data! };
}

/**
 * Leave a review.
 *
 * Rejects a buyer with no delivered order from that artist, and rejects a
 * second review on the same order -- the two rejection scenarios the spec
 * names. The duplicate is caught by a unique constraint rather than by a
 * read-then-write, because two submissions racing each other would both pass a
 * read-then-write check.
 */
export async function submitReview(
  db: Sql,
  eligibility: OrderEligibility,
  input: SubmitReviewInput,
): Promise<Review> {
  const { rating, body } = validate(input);

  if (input.artistId === input.buyerId) {
    // SECURITY.md S2-24: an account holds both roles by design, so this is a
    // real path, not a theoretical one.
    throw AppError.forbidden("You cannot review your own work.", {
      code: "accounts.self_review",
    });
  }

  const allowed = await eligibility.hasDeliveredOrder(db, {
    orderId: input.orderId,
    artistId: input.artistId,
    buyerId: input.buyerId,
  });

  if (!allowed) {
    throw AppError.forbidden(
      "Only a buyer with a delivered order from this artist can leave a review.",
      { code: "accounts.review_not_eligible" },
    );
  }

  try {
    const row = await db.one<{ id: string; created_at: Date }>(
      `insert into reviews (order_id, artist_id, buyer_id, rating, body, scanner_version)
       values ($1, $2, $3, $4, $5, $6)
       returning id, created_at`,
      [input.orderId, input.artistId, input.buyerId, rating, body, SCANNER_VERSION],
    );

    const display = await db.one<{ display_name: string }>(
      "select display_name from profiles where user_id = $1",
      [input.buyerId],
    );

    return {
      id: row.id,
      orderId: input.orderId,
      artistId: input.artistId,
      buyerId: input.buyerId,
      buyerDisplayName: display.display_name,
      rating,
      body,
      createdAt: row.created_at.toISOString(),
    };
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      // The spec's "Duplicate review" scenario: rejected, and the buyer is
      // offered the edit path instead. The error carries no constraint name and
      // no row detail -- SECURITY.md S2-26.
      throw AppError.conflict("You have already reviewed this order. You can edit that review.", {
        code: "accounts.review_already_exists",
      });
    }
    throw cause;
  }
}

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

/**
 * Edit an existing review. The spec's duplicate scenario "offers to edit the
 * existing review", so there has to be something to offer.
 */
export async function editReview(
  db: Sql,
  input: { reviewId: string; buyerId: string; rating: number; body?: string },
): Promise<Review> {
  const { rating, body } = validate({
    orderId: "",
    artistId: "",
    buyerId: input.buyerId,
    rating: input.rating,
    body: input.body,
  });

  const row = await db.maybeOne<{
    id: string;
    order_id: string;
    artist_id: string;
    created_at: Date;
  }>(
    `update reviews
        set rating = $3, body = $4, scanner_version = $5
      where id = $1 and buyer_id = $2
      returning id, order_id, artist_id, created_at`,
    [input.reviewId, input.buyerId, rating, body, SCANNER_VERSION],
  );

  if (!row) {
    // Not-found rather than forbidden for someone else's review: whether a
    // given review id exists is not something to confirm to a stranger.
    throw AppError.notFound("No such review.", { code: "accounts.no_such_review" });
  }

  const display = await db.one<{ display_name: string }>(
    "select display_name from profiles where user_id = $1",
    [input.buyerId],
  );

  return {
    id: row.id,
    orderId: row.order_id,
    artistId: row.artist_id,
    buyerId: input.buyerId,
    buyerDisplayName: display.display_name,
    rating,
    body,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Hide every review attached to an order whose return has completed.
 *
 * Called by the shipping module when a return finishes. Hidden, not deleted:
 * SECURITY.md S2-24 item 4 requires the row be retained for admin review, and a
 * pattern of order-review-return is exactly the evidence an operator needs.
 */
export async function withdrawReviewsForReturnedOrder(db: Sql, orderId: string): Promise<number> {
  const { rowCount } = await db.query(
    "update reviews set published = false where order_id = $1 and published",
    [orderId],
  );
  return rowCount;
}

/** Undo the above, if a return is cancelled. */
export async function restoreReviewsForOrder(db: Sql, orderId: string): Promise<number> {
  const { rowCount } = await db.query(
    "update reviews set published = true where order_id = $1 and not published",
    [orderId],
  );
  return rowCount;
}

interface ReviewRow {
  readonly id: string;
  readonly order_id: string;
  readonly artist_id: string;
  readonly buyer_id: string;
  readonly buyer_display_name: string;
  readonly rating: number;
  readonly body: string;
  readonly created_at: Date;
}

/**
 * Every published review for an artist, newest first, with the aggregate.
 *
 * The buyer's display name comes from `profiles`, which holds nothing but
 * public columns -- so joining it cannot widen this row into something that
 * must not be rendered.
 */
export async function getArtistReviews(db: Sql, artistId: string): Promise<ArtistReviews> {
  const { rows } = await db.query<ReviewRow>(
    `select r.id, r.order_id, r.artist_id, r.buyer_id,
            p.display_name as buyer_display_name,
            r.rating, r.body, r.created_at
       from reviews r
       join profiles p on p.user_id = r.buyer_id
      where r.artist_id = $1 and r.published
      order by r.created_at desc`,
    [artistId],
  );

  const reviews = rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    artistId: row.artist_id,
    buyerId: row.buyer_id,
    buyerDisplayName: row.buyer_display_name,
    rating: Number(row.rating),
    body: row.body,
    createdAt: row.created_at.toISOString(),
  }));

  return { reviews, summary: summarise(reviews) };
}

/**
 * Mean rating to one decimal.
 *
 * Computed here rather than in SQL so that the number rendered on the page and
 * the number derived from the listed reviews cannot disagree -- a page showing
 * "4.9 from 11 reviews" above a list whose average is 4.7 is the kind of bug
 * nobody reports and everybody notices.
 */
export function summarise(reviews: readonly Review[]): ReviewSummary {
  if (reviews.length === 0) return { average: null, count: 0 };

  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  return { average: Math.round((total / reviews.length) * 10) / 10, count: reviews.length };
}
