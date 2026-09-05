/**
 * The buyer's order page, fetch and render together.
 *
 * `certificates.PublicVerificationPage` makes the same choice for the same
 * reason: keeping the read beside the render is what lets an integration test
 * execute what the visitor actually receives, rather than proving something
 * about a component the route might feed differently.
 *
 * WHO MAY SEE THIS IS DECIDED IN SQL, NOT HERE
 * --------------------------------------------
 * `orders.buyerOrder` scopes by `buyer_id` in its own WHERE clause and raises
 * `not_found` otherwise — not fetch-then-check, because a fetch-then-check
 * leaves the row in memory and every such window is one refactor away from
 * being returned by accident. So this component has no permission test in it,
 * and could not add one that mattered.
 *
 * The artist's contact details cannot appear here either, and the protection is
 * structural rather than remembered: `BuyerOrderDetail` has no field that could
 * carry an email, a phone or a street address. The artist's NAME is a different
 * question and is allowed — an artist profile is a public page — so it arrives
 * through `accounts.toPublicArtist()`, the only sanctioned serializer, fetched
 * here because `orders` may not shape artist data for a buyer itself.
 *
 * THE PAYMENT STORY
 * -----------------
 * PACHKA launches with the manual adapter, so `awaiting_payment` is not a
 * transient state a payment page passes through: it is where every new order
 * sits until a person sees a bank transfer arrive. A buyer who is not told that
 * plainly will assume the order failed. `MANUAL_PAYMENT_INSTRUCTIONS` is the
 * module's own wording, rendered rather than restated.
 */
import { findPublicArtist } from "@/modules/accounts";
import {
  BuyerOrderView,
  buyerOrder,
  MANUAL_PAYMENT_INSTRUCTIONS,
  type OrdersDeps,
} from "@/modules/orders";
import { orderCertificates, type CertificatesDeps } from "@/modules/certificates";
import { Card } from "@/shared/ui";

export interface OrderScreenProps {
  readonly orders: OrdersDeps;
  readonly certificates: CertificatesDeps;
  readonly buyerId: string;
  readonly orderId: string;
}

/** Withheld-certificate reasons, in words. "No certificate" alone reads as a bug. */
const WITHHELD_LABELS: Readonly<Record<string, string>> = {
  not_paid: "התעודה תונפק לאחר קבלת התשלום ומסירת היצירה.",
  not_delivered: "התעודה תונפק עם מסירת היצירה.",
  cancelled: "ההזמנה בוטלה, ולכן לא תונפק תעודה.",
  returned: "היצירה הוחזרה, ולכן התעודה בוטלה.",
};

export async function OrderScreen({ orders, certificates, buyerId, orderId }: OrderScreenProps) {
  const detail = await buyerOrder(orders, buyerId, orderId);

  // One lookup per distinct artist, through the one sanctioned serializer. A
  // missing profile — an artist whose only piece has sold — leaves the entry
  // absent, and the view renders the neutral "האמן/ית" rather than an id.
  const artistIds = [...new Set(detail.parcels.map((parcel) => parcel.artistId))];
  const artists = await Promise.all(
    artistIds.map((id) => findPublicArtist(orders.db, id).then((artist) => [id, artist] as const)),
  );
  const artistNames: Record<string, string> = {};
  for (const [id, artist] of artists) {
    if (artist !== null) artistNames[id] = artist.displayName;
  }

  // Issues anything a delivered parcel is owed and does not have. Idempotent,
  // so a missed delivery hook costs a page view rather than a buyer's document.
  const entries = await orderCertificates(certificates, buyerId, orderId);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6 px-6 py-12 sm:px-12">
      <BuyerOrderView order={detail} artistNames={artistNames} />

      {detail.order.status === "awaiting_payment" ? (
        <Card className="p-5">
          <h2 className="m-0 mb-2 text-base font-bold text-ink">מה קורה עכשיו</h2>
          <p className="m-0 mb-2 text-[15px] font-light leading-[1.7] text-ink-soft">
            {MANUAL_PAYMENT_INSTRUCTIONS}
          </p>
          <p className="m-0 text-[13px] font-light leading-[1.6] text-ink-soft">
            מספר ההזמנה: <span className="numeric">{detail.order.id}</span>
          </p>
        </Card>
      ) : null}

      <section aria-labelledby="order-certificates" className="flex flex-col gap-3">
        <h2 id="order-certificates" className="m-0 text-base font-bold text-ink">
          תעודות מקוריות
        </h2>
        {entries.map((entry) => (
          <Card key={entry.fulfilmentId} className="p-5">
            {entry.withheld !== null ? (
              <p className="m-0 text-[14px] font-light leading-[1.6] text-ink-soft">
                {WITHHELD_LABELS[entry.withheld] ?? "התעודה אינה זמינה עדיין."}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {entry.certificates.map((certificate) => (
                  <li key={certificate.identifier}>
                    <a
                      href={`/certificates/${certificate.identifier}`}
                      className="numeric border-b border-rule text-[14px] text-ink hover:text-ink-soft"
                    >
                      {certificate.identifier}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </section>
    </div>
  );
}
