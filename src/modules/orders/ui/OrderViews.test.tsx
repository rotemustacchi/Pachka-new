/**
 * The two order screens, rendered.
 *
 * The assertions that matter are negative ones, and they are the same two rules
 * `checkout-orders` states in one sentence each:
 *
 *   • an artist sees the buyer's name, phone and address only after `paid`;
 *   • the buyer never sees the artist's contact details.
 *
 * Both are enforced in the read model rather than in these components — see the
 * header of `ArtistFulfilmentView.tsx` — so what is being asserted here is that
 * a component handed a withheld value renders the withholding, and that neither
 * component reaches for anything it was not given. A screen that quietly
 * rendered `undefined` as an empty string would pass a check for "the address is
 * absent" while being broken; these look for the substitute text as well.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { agorot } from "@/shared/money";
import { ArtistFulfilmentView } from "./ArtistFulfilmentView";
import { BuyerOrderView } from "./BuyerOrderView";
import type { ArtistFulfilmentDetail, BuyerOrderDetail } from "../views";
import type { DeliveryDetails, Fulfilment, OrderItem, Order } from "../types";

const BUYER_PHONE = "0509998888";

const DELIVERY: DeliveryDetails = {
  fullName: "דנה כהן",
  phone: BUYER_PHONE,
  line1: "הרצל 12",
  line2: null,
  city: "תל אביב",
  postalCode: "6100000",
  countryCode: "IL",
};

const ORDER: Order = {
  id: "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f",
  buyerId: "6b1e9d54-0f2a-4c3b-9d8e-7a6b5c4d3e2f",
  status: "paid",
  subtotalAgorot: agorot(149_000),
  shippingAgorot: agorot(11_800),
  totalAgorot: agorot(160_800),
  commissionRateBp: 1500,
  currency: "ILS",
  shippingZoneCode: "center",
  placedAt: "2026-09-03T09:00:00.000Z",
  updatedAt: "2026-09-03T09:00:00.000Z",
};

const YAEL = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const NOA = "9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f";

function item(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "item-1",
    orderId: ORDER.id,
    fulfilmentId: "ful-1",
    artworkId: "art-1",
    artistId: YAEL,
    quantity: 1,
    unitPriceAgorot: agorot(125_000),
    lineTotalAgorot: agorot(125_000),
    titleSnapshot: "קו החוף, שקיעה",
    createdAt: ORDER.placedAt,
    ...overrides,
  };
}

function fulfilment(overrides: Partial<Fulfilment> = {}): Fulfilment {
  return {
    id: "ful-1",
    orderId: ORDER.id,
    artistId: YAEL,
    status: "paid",
    itemsSubtotalAgorot: agorot(125_000),
    shippingAgorot: agorot(8900),
    shippingTierCode: "large",
    shippedAt: null,
    deliveredAt: null,
    createdAt: ORDER.placedAt,
    updatedAt: ORDER.placedAt,
    ...overrides,
  };
}

describe("the artist's fulfilment view", () => {
  function view(overrides: Partial<ArtistFulfilmentDetail> = {}): ArtistFulfilmentDetail {
    return {
      fulfilment: fulfilment(),
      items: [item()],
      orderId: ORDER.id,
      orderStatus: "paid",
      placedAt: ORDER.placedAt,
      buyer: DELIVERY,
      ...overrides,
    };
  }

  it("withholds the buyer's details and says so when the order is unpaid", () => {
    // `checkout-orders`, *Artist views an unpaid order*. The read model hands
    // over `null`; the screen must say why rather than rendering a blank card
    // that reads like a bug.
    render(
      <ArtistFulfilmentView
        fulfilment={view({
          fulfilment: fulfilment({ status: "awaiting_payment" }),
          buyer: null,
        })}
      />,
    );

    expect(screen.queryByText(BUYER_PHONE)).toBeNull();
    expect(screen.queryByText(DELIVERY.fullName)).toBeNull();
    expect(screen.queryByText(DELIVERY.line1)).toBeNull();
    expect(screen.getByText(/יופיעו כאן לאחר קבלת התשלום/)).toBeInTheDocument();
  });

  it("shows name, phone and address once the fulfilment is paid", () => {
    // *Artist views a paid fulfilment*: "they see the buyer's name, phone, and
    // delivery address for that fulfilment only."
    render(<ArtistFulfilmentView fulfilment={view()} />);

    expect(screen.getByText(DELIVERY.fullName)).toBeInTheDocument();
    expect(screen.getByText(BUYER_PHONE)).toBeInTheDocument();
    expect(screen.getByText(DELIVERY.line1)).toBeInTheDocument();
  });

  it("singles out a paid fulfilment as the one needing action", () => {
    // `paid` is the state where a dispatch deadline starts running, and it is
    // the only one the artist's screen should push at them.
    render(<ArtistFulfilmentView fulfilment={view()} />);
    expect(screen.getByText("לשליחה")).toBeInTheDocument();
  });

  it("does not tell the artist their order is 'awaiting payment' in the buyer's words", () => {
    // The same status means different things to the two readers. An artist
    // reading the buyer's label would think THEY owed money.
    render(
      <ArtistFulfilmentView
        fulfilment={view({ fulfilment: fulfilment({ status: "awaiting_payment" }), buyer: null })}
      />,
    );
    expect(screen.getByText("ממתינה לתשלום הקונה")).toBeInTheDocument();
    expect(screen.queryByText("ממתינה לתשלום")).toBeNull();
  });

  it("keeps the item subtotal and the shipping charge apart", () => {
    // `artist-payouts` excludes shipping from commission, so one combined
    // number here would make the payout that follows look wrong.
    render(<ArtistFulfilmentView fulfilment={view()} />);
    // Twice for the item total: once on the line, once as this fulfilment's
    // subtotal — a one-line fulfilment makes them equal, which is right.
    expect(screen.getAllByText("₪1,250.00")).toHaveLength(2);
    // And exactly once for the shipping, as its own figure rather than folded
    // into the subtotal above it.
    expect(screen.getAllByText("₪89.00")).toHaveLength(1);
  });
});

describe("the buyer's order view", () => {
  function view(overrides: Partial<BuyerOrderDetail> = {}): BuyerOrderDetail {
    return {
      order: ORDER,
      delivery: DELIVERY,
      parcels: [
        {
          fulfilmentId: "ful-1",
          artistId: YAEL,
          status: "shipped",
          shippedAt: "2026-09-04T09:00:00.000Z",
          deliveredAt: null,
          items: [item()],
        },
        {
          fulfilmentId: "ful-2",
          artistId: NOA,
          status: "paid",
          shippedAt: null,
          deliveredAt: null,
          items: [item({ id: "item-2", fulfilmentId: "ful-2", artistId: NOA, titleSnapshot: "מגדלור" })],
        },
      ],
      history: [],
      ...overrides,
    };
  }

  it("shows one item shipped and one still awaiting dispatch", () => {
    // `checkout-orders`, *One fulfilment ships before the other*, on the screen
    // the scenario is actually about.
    render(<BuyerOrderView order={view()} />);

    expect(screen.getByText("2 משלוחים")).toBeInTheDocument();

    // One parcel is on its way, exactly once.
    expect(screen.getAllByText("בדרך אליך")).toHaveLength(1);

    // "In preparation" twice, and the second one is the point: the ORDER's own
    // badge says it too, because an order is only as far along as its least
    // advanced parcel. A single "shipped" summary over a parcel that has not
    // moved is the thing this scenario exists to rule out.
    expect(screen.getAllByText("בהכנה למשלוח")).toHaveLength(2);
  });

  it("shows the full cost breakdown in shekels", () => {
    // Item prices, shipping and total, formatted through `shared/money` — the
    // only place currency formatting happens.
    render(<BuyerOrderView order={view()} />);

    expect(screen.getByText("₪1,490.00")).toBeInTheDocument();
    expect(screen.getByText("₪118.00")).toBeInTheDocument();
    expect(screen.getByText("₪1,608.00")).toBeInTheDocument();
  });

  it("renders artist names when given them and never a raw id", () => {
    // An artist's display name is public. Their id is not something a person
    // should ever be shown, and would leak the shape of the database.
    render(<BuyerOrderView order={view()} artistNames={{ [YAEL]: "יעל שוורץ" }} />);

    expect(screen.getByText("יעל שוורץ")).toBeInTheDocument();
    // No name supplied for the second artist: the neutral substitute, not an id.
    expect(screen.getByText("האמן/ית")).toBeInTheDocument();
    expect(screen.queryByText(NOA)).toBeNull();
    expect(screen.queryByText(YAEL)).toBeNull();
  });

  it("has no place to put an artist's contact details", () => {
    // The structural half of "the buyer never sees the artist's contact
    // details": the props carry no such field, so the rendered output cannot
    // contain one however the component is changed.
    const { container } = render(<BuyerOrderView order={view()} />);
    expect(container.textContent).not.toMatch(/@/);
    // The buyer's own phone is theirs and IS shown; nobody else's is.
    expect(screen.getByText(BUYER_PHONE)).toBeInTheDocument();
  });

  it("shows the title as it was bought, not a placeholder", () => {
    render(<BuyerOrderView order={view()} />);
    expect(screen.getByText("קו החוף, שקיעה")).toBeInTheDocument();
    expect(screen.getByText("מגדלור")).toBeInTheDocument();
  });
});
