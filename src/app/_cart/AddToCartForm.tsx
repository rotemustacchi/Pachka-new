/**
 * The purchase control, as `catalog.ArtworkDetailView` expects it.
 *
 * It is a SLOT in that view, not a component the view owns, because the cart
 * belongs to `orders` and catalog may not import it — the dependency table
 * points `orders` at `artworks`, `accounts` and `shipping`, and nothing at
 * catalog. So the route composes it, which is the "routes parse input, call a
 * module API, and render" division the contract describes.
 *
 * WHY THERE IS NO `purchasable` CHECK HERE
 * ----------------------------------------
 * Because there must not be a second one. `ArtworkDetailView` renders this slot
 * only when `artwork.purchasable` is true, and its header is explicit that the
 * check lives there so "the slot cannot be filled by a route that forgot to
 * check". Repeating the test in this component would create a second answer to
 * the same question, and the two would eventually disagree.
 *
 * The button is `Button` from `shared/ui` — the approved brush-stroke treatment
 * from design/Artwork.dc.html — rather than a second copy of it.
 */
import { Button } from "@/shared/ui";
import { addToCart } from "./actions";

export interface AddToCartFormProps {
  readonly artworkId: string;
}

export function AddToCartForm({ artworkId }: AddToCartFormProps) {
  return (
    <form action={addToCart}>
      <input type="hidden" name="artworkId" value={artworkId} />
      <Button type="submit" variant="primary" className="w-full">
        הוספה לעגלה
      </Button>
    </form>
  );
}
