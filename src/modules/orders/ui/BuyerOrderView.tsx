/**
 * The buyer's order tracking view.
 *
 * `checkout-orders`, *One fulfilment ships before the other*: "the buyer's order
 * shows one item shipped and one still awaiting dispatch." So the parcel is the
 * unit of display, not the order — one status per parcel, with the order's own
 * status above them as the summary.
 *
 * WHAT IS NOT ON THIS SCREEN
 * --------------------------
 * The artist's email, phone or address. "The system SHALL NOT show the buyer the
 * artist's contact details at any point", and the protection is that
 * `BuyerOrderDetail` (the read model in ../views.ts) has no field that could
 * carry one — this component renders what it is given and cannot invent them.
 *
 * The artist's NAME is a different question and is allowed: an artist profile is
 * a public page. It is passed in as `artistNames` rather than looked up here,
 * because `accounts.toPublicArtist()` is the only sanctioned way to shape artist
 * data for a buyer (ARCHITECTURE.md) and this module may not call it — the
 * dependency table lets `orders` call `accounts`, but the serializer's output is
 * the route's to fetch and hand over, so there is exactly one shaping step.
 */
import { Card, SectionHeading } from "@/shared/ui";
import { formatAgorot } from "@/shared/money";
import type { BuyerOrderDetail } from "../views";
import { BUYER_STATUS_LABELS, buyerStatusTone } from "./status";
import { StatusBadge } from "./StatusBadge";

export interface BuyerOrderViewProps {
  readonly order: BuyerOrderDetail;
  /**
   * Artist display names by artist id, already through
   * `accounts.toPublicArtist()`. A missing entry renders as the neutral
   * "האמן/ית" rather than an id: an identifier on screen is a leak of the
   * shape of the database and tells the buyer nothing.
   */
  readonly artistNames?: Readonly<Record<string, string>>;
}

export function BuyerOrderView({ order, artistNames = {} }: BuyerOrderViewProps) {
  const { order: summary, delivery, parcels } = order;

  return (
    <section className="flex flex-col gap-6" aria-label="הזמנה">
      <header className="flex flex-col gap-2">
        <SectionHeading>הזמנה</SectionHeading>
        <div className="flex items-center gap-3">
          <StatusBadge
            tone={buyerStatusTone(summary.status)}
            label={BUYER_STATUS_LABELS[summary.status]}
          />
          <time className="text-sm text-ink-muted" dateTime={summary.placedAt}>
            {new Date(summary.placedAt).toLocaleDateString("he-IL")}
          </time>
        </div>
      </header>

      {/*
        The cost breakdown. `checkout-orders` requires item prices, shipping and
        the total in ILS before the buyer confirms; the same three appear here
        afterwards, from the amounts snapshotted on the order — never recomputed,
        because a receipt that re-derives its own totals is a receipt that can
        change after the fact.
      */}
      <Card className="p-5">
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-muted">פריטים</dt>
            <dd className="text-ink">{formatAgorot(summary.subtotalAgorot)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">משלוח</dt>
            <dd className="text-ink">{formatAgorot(summary.shippingAgorot)}</dd>
          </div>
          <div className="flex justify-between border-t border-rule pt-2 font-bold">
            <dt className="text-ink">סה״כ</dt>
            <dd className="text-ink">{formatAgorot(summary.totalAgorot)}</dd>
          </div>
        </dl>
      </Card>

      {/*
        One block per parcel. On a single-artist order this reads as one
        shipment; on a two-artist order it is the whole of the spec scenario,
        with two independent statuses under one order.
      */}
      <div className="flex flex-col gap-4">
        <h3 className="text-base font-bold text-ink">
          {parcels.length === 1 ? "המשלוח" : `${parcels.length} משלוחים`}
        </h3>

        {parcels.map((parcel) => (
          <Card key={parcel.fulfilmentId} className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink-muted">
                {artistNames[parcel.artistId] ?? "האמן/ית"}
              </span>
              <StatusBadge
                tone={buyerStatusTone(parcel.status)}
                label={BUYER_STATUS_LABELS[parcel.status]}
              />
            </div>

            <ul className="flex flex-col gap-1">
              {parcel.items.map((item) => (
                <li key={item.id} className="flex justify-between text-sm">
                  <span className="text-ink">
                    {/* The title AS BOUGHT. An artist may edit the listing
                        afterwards, and a receipt whose wording changes is not a
                        receipt. */}
                    {item.titleSnapshot ?? "פריט"}
                    {item.quantity > 1 ? ` × ${item.quantity}` : ""}
                  </span>
                  <span className="text-ink-muted">{formatAgorot(item.lineTotalAgorot)}</span>
                </li>
              ))}
            </ul>

            {parcel.shippedAt ? (
              <p className="text-sm text-ink-muted">
                נשלח ב־{new Date(parcel.shippedAt).toLocaleDateString("he-IL")}
              </p>
            ) : null}
          </Card>
        ))}
      </div>

      {/* The buyer's own address, back to them. Their data, so no gate. */}
      <Card className="flex flex-col gap-1 p-5">
        <h3 className="text-base font-bold text-ink">כתובת למשלוח</h3>
        <p className="text-sm text-ink">{delivery.fullName}</p>
        <p className="text-sm text-ink-muted">
          {delivery.line1}
          {delivery.line2 ? `, ${delivery.line2}` : ""}
        </p>
        <p className="text-sm text-ink-muted">
          {delivery.city}
          {delivery.postalCode ? ` ${delivery.postalCode}` : ""}
        </p>
        <p className="text-sm text-ink-muted">{delivery.phone}</p>
      </Card>
    </section>
  );
}
