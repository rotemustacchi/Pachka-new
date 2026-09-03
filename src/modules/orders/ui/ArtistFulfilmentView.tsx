/**
 * The artist's fulfilment view: what to send, and — once it is paid for — where.
 *
 * `checkout-orders`, *Artist views a paid fulfilment* and *Artist views an
 * unpaid order*. The whole screen turns on one distinction, so it is worth
 * being explicit about how it is enforced here:
 *
 *   **This component does not decide anything.** `artistFulfilment()` in
 *   ../views.ts sets `buyer` to `null` unless the fulfilment has reached `paid`,
 *   and does not issue the query at all in that case — so the buyer's phone
 *   number is not in this process's memory, let alone in these props. The
 *   component renders "not yet" when it is handed `null`; it has no state to
 *   check and no way to check it.
 *
 *   That is deliberate. A component that took the whole fulfilment and decided
 *   for itself whether to show the address would be one `&&` away from showing
 *   it, and the mistake would be invisible in review. The read model withholds;
 *   the component displays.
 *
 * The artist never sees the order's total, the buyer's other parcel, or the
 * other artist's prices — the read model carries only this fulfilment's lines.
 */
import { Card, SectionHeading } from "@/shared/ui";
import { formatAgorot } from "@/shared/money";
import type { ArtistFulfilmentDetail } from "../views";
import { ARTIST_STATUS_LABELS, artistStatusTone } from "./status";
import { StatusBadge } from "./StatusBadge";

export interface ArtistFulfilmentViewProps {
  readonly fulfilment: ArtistFulfilmentDetail;
}

export function ArtistFulfilmentView({ fulfilment: view }: ArtistFulfilmentViewProps) {
  const { fulfilment, items, buyer } = view;

  return (
    <section className="flex flex-col gap-6" aria-label="משלוח">
      <header className="flex flex-col gap-2">
        <SectionHeading>משלוח</SectionHeading>
        <div className="flex items-center gap-3">
          <StatusBadge
            tone={artistStatusTone(fulfilment.status)}
            label={ARTIST_STATUS_LABELS[fulfilment.status]}
          />
          <time className="text-sm text-ink-muted" dateTime={view.placedAt}>
            {new Date(view.placedAt).toLocaleDateString("he-IL")}
          </time>
        </div>
      </header>

      <Card className="flex flex-col gap-3 p-5">
        <h3 className="text-base font-bold text-ink">מה לשלוח</h3>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex justify-between text-sm">
              <span className="text-ink">
                {item.titleSnapshot ?? "פריט"}
                {item.quantity > 1 ? ` × ${item.quantity}` : ""}
              </span>
              <span className="text-ink-muted">{formatAgorot(item.lineTotalAgorot)}</span>
            </li>
          ))}
        </ul>

        {/*
          This artist's own two figures, kept apart. `artist-payouts` excludes
          shipping from commission, so showing one combined number would make
          the payout that follows look wrong.
        */}
        <dl className="flex flex-col gap-1 border-t border-rule pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-muted">סה״כ פריטים</dt>
            <dd className="text-ink">{formatAgorot(fulfilment.itemsSubtotalAgorot)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">משלוח שנגבה מהקונה</dt>
            <dd className="text-ink">{formatAgorot(fulfilment.shippingAgorot)}</dd>
          </div>
        </dl>
      </Card>

      {/*
        The address, or the reason there is not one yet. `buyer` is null until
        the fulfilment is paid — decided in views.ts, not here.
      */}
      <Card className="flex flex-col gap-1 p-5">
        <h3 className="text-base font-bold text-ink">כתובת הקונה</h3>
        {buyer === null ? (
          <p className="text-sm text-ink-muted">
            פרטי הקונה יופיעו כאן לאחר קבלת התשלום.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink">{buyer.fullName}</p>
            <p className="text-sm text-ink-muted">
              {buyer.line1}
              {buyer.line2 ? `, ${buyer.line2}` : ""}
            </p>
            <p className="text-sm text-ink-muted">
              {buyer.city}
              {buyer.postalCode ? ` ${buyer.postalCode}` : ""}
            </p>
            <p className="text-sm text-ink-muted">{buyer.phone}</p>
          </>
        )}
      </Card>
    </section>
  );
}
