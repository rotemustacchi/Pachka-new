/**
 * Where the cart lives.
 *
 * `orders/cart.ts` settles the question and this file only implements its
 * answer: there is no `carts` table in ARCHITECTURE.md's ownership map, and
 * adding one would claim ownership of a table the contract does not grant. More
 * to the point it would buy nothing, because adding to a cart reserves nothing
 * — so a cart line is a wish, and a wish is worth the same whether it is stored
 * on a server or in a cookie.
 *
 * So the cart's CONTENTS are the client's, and its TRUTH is
 * `orders.revalidateCart`, which re-reads every price and every availability
 * from the database on every view. That division is what makes a client-held
 * cart safe: no price the cookie holds is ever used as an amount.
 *
 * WHAT IS IN THE COOKIE, AND WHY THE PRICE IS
 * -------------------------------------------
 * Artwork ids, quantities, and the unit price AS THE SERVER READ IT when the
 * line was added. That last field is `CartLineInput.priceWhenAddedAgorot`,
 * which `orders` describes as "compared and then discarded" — it exists so the
 * cart can satisfy `checkout-orders`' *Price changed since adding* scenario by
 * flagging a change, and it is never summed, never charged, and never sent to a
 * quote.
 *
 * It is written by `addToCart` from the artwork row rather than from the form,
 * so it is genuinely the price the server showed. A client that edits the
 * cookie can therefore make its own cart claim a price changed when it did not,
 * which is the entire blast radius of tampering with this value.
 *
 * NOT `httpOnly`, DELIBERATELY, AND NOT SENSITIVE
 * ----------------------------------------------
 * It holds artwork ids a visitor just browsed on public pages. There is no
 * identity in it, no address, and nothing whose disclosure means anything —
 * SECURITY.md's concern is PII accumulating without a path out, and the
 * cheapest way not to accumulate a field is not to have one. `sameSite: lax`
 * so a cross-site form post cannot seed somebody's cart.
 */
import { cookies } from "next/headers";
import type { CartLineInput } from "@/modules/orders";

export const CART_COOKIE = "pachka_cart";

/** A month. A wish does not go stale quickly, and nothing is held meanwhile. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * How many distinct lines a cookie may carry.
 *
 * Not a business rule — `orders` owns the real cap, which is on concurrent
 * RESERVATIONS per buyer and is enforced under the lock at checkout. This is
 * only a bound on a header, so a scripted client cannot grow the cookie until
 * the request is rejected by the edge.
 */
const MAX_LINES = 40;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the cookie.
 *
 * Every field is checked, and a value that fails is dropped rather than
 * defaulted: the cookie is client-controlled input and this is its trust
 * boundary. Anything malformed yields an empty cart instead of an error page —
 * a visitor whose cookie a browser extension mangled should see an empty cart,
 * not a 500.
 */
export function parseCart(raw: string | undefined): readonly CartLineInput[] {
  if (raw === undefined || raw === "") return [];

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];

  const lines: CartLineInput[] = [];
  for (const entry of decoded) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;

    const artworkId = candidate.artworkId;
    if (typeof artworkId !== "string" || !UUID.test(artworkId)) continue;
    if (lines.some((line) => line.artworkId === artworkId)) continue;

    const quantity = candidate.quantity;
    const price = candidate.priceWhenAddedAgorot;

    lines.push({
      artworkId,
      quantity:
        typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity > 0
          ? quantity
          : 1,
      ...(typeof price === "number" && Number.isSafeInteger(price) && price >= 0
        ? { priceWhenAddedAgorot: price }
        : {}),
    });

    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

export function serialiseCart(lines: readonly CartLineInput[]): string {
  return JSON.stringify(
    lines.slice(0, MAX_LINES).map((line) => ({
      artworkId: line.artworkId,
      quantity: line.quantity ?? 1,
      ...(line.priceWhenAddedAgorot === undefined
        ? {}
        : { priceWhenAddedAgorot: line.priceWhenAddedAgorot }),
    })),
  );
}

/** The cart as this request's cookie has it. Safe in a page render. */
export async function readCart(): Promise<readonly CartLineInput[]> {
  const store = await cookies();
  return parseCart(store.get(CART_COOKIE)?.value);
}

/**
 * Replace the cart.
 *
 * Only callable from a Server Action or Route Handler: a page render may not
 * write cookies, and Next throws if it tries. `_lib/viewer.ts` describes the
 * same split for the session cookie.
 */
export async function writeCart(lines: readonly CartLineInput[]): Promise<void> {
  const store = await cookies();

  if (lines.length === 0) {
    store.delete(CART_COOKIE);
    return;
  }

  store.set(CART_COOKIE, serialiseCart(lines), {
    path: "/",
    sameSite: "lax",
    maxAge: MAX_AGE_SECONDS,
  });
}

/**
 * Add one line, or raise its quantity if it is already there.
 *
 * Pure, so the merge rule is testable without a request scope — the same reason
 * `signedInOrRedirect` takes the user id rather than reading it.
 */
export function withLine(
  lines: readonly CartLineInput[],
  addition: CartLineInput,
): readonly CartLineInput[] {
  const existing = lines.find((line) => line.artworkId === addition.artworkId);
  if (existing === undefined) return [...lines, addition];

  return lines.map((line) =>
    line.artworkId === addition.artworkId
      ? {
          ...line,
          quantity: (line.quantity ?? 1) + (addition.quantity ?? 1),
          // The comparison price stays as it was when the line was FIRST added.
          // Refreshing it on every add would quietly erase the price change the
          // field exists to report.
          ...(line.priceWhenAddedAgorot === undefined
            ? {}
            : { priceWhenAddedAgorot: line.priceWhenAddedAgorot }),
        }
      : line,
  );
}

export function withoutLine(
  lines: readonly CartLineInput[],
  artworkId: string,
): readonly CartLineInput[] {
  return lines.filter((line) => line.artworkId !== artworkId);
}
