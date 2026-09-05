/**
 * /orders/[orderId] — the buyer's own order.
 *
 * An unauthenticated visitor is sent to sign in rather than shown an empty
 * page: there is no version of this route that means anything without a
 * session, since the order is scoped to the buyer in SQL.
 *
 * A signed-in visitor asking for somebody else's order gets a 404, not a 403.
 * `buyerOrder` scopes by `buyer_id` in its WHERE clause and raises `not_found`,
 * so "this order is not yours" and "there is no such order" are the same
 * answer — a 403 would confirm that the id exists, which is exactly what a
 * prober wants to learn.
 */
import { notFound } from "next/navigation";
import { isAppError } from "@/shared/errors";
import { getDatabase } from "@/shared/db";
import { certificatesDeps, ordersDeps } from "@/app/_lib/deps";
import { currentUserId, signedInOrRedirect } from "@/app/_lib/viewer";
import { OrderScreen } from "./OrderScreen";

export const dynamic = "force-dynamic";
export const metadata = { title: "ההזמנה שלי — פאצ׳קה" };

interface PageProps {
  readonly params: Promise<{ readonly orderId: string }>;
}

export default async function OrderPage({ params }: PageProps) {
  const { orderId } = await params;
  const buyerId = signedInOrRedirect(await currentUserId());

  // A malformed id is a 404, not a 500. Postgres raises a type error on a
  // non-uuid, and an error page that differs from the not-found page is another
  // way to tell a prober they got the shape right.
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) notFound();

  const db = getDatabase();

  try {
    return await OrderScreen({
      orders: ordersDeps(db),
      certificates: certificatesDeps(db),
      buyerId,
      orderId,
    });
  } catch (error) {
    if (isAppError(error) && error.kind === "not_found") notFound();
    throw error;
  }
}
