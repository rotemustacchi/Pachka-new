/**
 * The cart, as the buyer sees it.
 *
 * A Server Component: it renders a `CartView` that `orders.revalidateCart` has
 * just re-read from the database, and it holds no state of its own. That is
 * what `checkout-orders` means by "the cart SHALL revalidate availability and
 * price on every view" — the numbers here were read this request, not carried
 * over from when the line was added.
 *
 * IT RENDERS THE TWO SPEC SCENARIOS AND DECIDES NEITHER
 * ----------------------------------------------------
 * *Artwork sells while in another buyer's cart*: the line "is marked
 * unavailable, is excluded from the total, and cannot be checked out".
 * *Price changed since adding*: "the cart shows the current price and flags
 * that it changed".
 *
 * Both facts arrive on the line — `available`, `unavailableReason`,
 * `priceChanged` — and the subtotal `orders` computes already excludes the
 * unavailable ones. So this component makes no availability judgement and sums
 * nothing: a total added up here would be a second answer to what is owed, and
 * the two would eventually differ.
 */
import { formatAgorot } from "@/shared/money";
import { Badge, Card } from "@/shared/ui";
import type { CartLine, CartView } from "@/modules/orders";
import { removeFromCart } from "@/app/_cart/actions";

/** Why a line cannot be bought, in words rather than a code. */
const UNAVAILABLE_LABELS: Readonly<Record<NonNullable<CartLine["unavailableReason"]>, string>> = {
  sold: "נמכרה",
  withdrawn: "הוסרה מהמכירה",
  not_enough_stock: "אין מספיק במלאי",
  not_priced: "אין מחיר",
};

function Line({ line }: { readonly line: CartLine }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule py-4 last:border-b-0">
      <div className="flex flex-col gap-1">
        <span className={line.available ? "text-[15px] font-bold text-ink" : "text-[15px] font-bold text-ink-muted line-through"}>
          {line.title ?? "יצירה"}
        </span>

        {line.quantity > 1 ? (
          <span className="numeric text-[13px] text-ink-muted">כמות: {line.quantity}</span>
        ) : null}

        {line.unavailableReason !== null ? (
          <Badge variant="tag">{UNAVAILABLE_LABELS[line.unavailableReason]}</Badge>
        ) : null}

        {line.priceChanged && line.priceWhenAddedAgorot !== null ? (
          // Flagged, not silently re-priced. The buyer is being asked to agree
          // to a number they did not see when they added the piece.
          <span className="text-[13px] text-ink-soft">
            המחיר השתנה מאז שהוספתם ליצירה לעגלה
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-4">
        <span className="numeric text-[15px] text-ink">
          {line.unitPriceAgorot === null ? "—" : formatAgorot(line.lineTotalAgorot)}
        </span>
        <form action={removeFromCart}>
          <input type="hidden" name="artworkId" value={line.artworkId} />
          <button type="submit" className="text-[13px] text-ink-muted underline hover:text-ink">
            הסרה
          </button>
        </form>
      </div>
    </li>
  );
}

export interface CartSummaryProps {
  readonly cart: CartView;
}

export function CartSummary({ cart }: CartSummaryProps) {
  if (cart.lines.length === 0) {
    return (
      <Card className="p-6">
        <p className="m-0 text-[15px] text-ink-soft">העגלה ריקה.</p>
        <a href="/catalog" className="mt-3 inline-flex border-b border-rule pb-1 text-[15px] text-ink">
          לעיון בקטלוג
        </a>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h2 className="m-0 mb-2 text-base font-bold text-ink">העגלה</h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {cart.lines.map((line) => (
          <Line key={line.artworkId} line={line} />
        ))}
      </ul>

      <p className="mt-4 flex justify-between border-t border-rule pt-3 text-[15px] font-bold text-ink">
        <span>סכום ביניים</span>
        {/* `orders` excluded the unavailable lines from this figure. */}
        <span className="numeric">{formatAgorot(cart.subtotalAgorot)}</span>
      </p>

      {cart.unavailableArtworkIds.length > 0 ? (
        <p role="status" className="m-0 mt-3 text-[13px] leading-[1.6] text-ink-soft">
          יצירות שכבר אינן זמינות אינן נכללות בסכום ולא ייכללו בהזמנה.
        </p>
      ) : null}
    </Card>
  );
}
