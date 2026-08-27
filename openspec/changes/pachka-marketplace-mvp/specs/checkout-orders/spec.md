## Purpose

Covers the cart, inventory reservation, checkout, and the order state machine from placement to delivery — including the payment abstraction that lets the platform be built and tested before a payment provider has been selected.

## ADDED Requirements

### Requirement: Cart
The system SHALL allow a buyer to hold multiple artworks in a cart. Adding an artwork to a cart SHALL NOT reserve it. The cart SHALL revalidate availability and price on every view, and SHALL clearly mark any line whose artwork has become unavailable or changed price.

#### Scenario: Artwork sells while in another buyer's cart
- **WHEN** a buyer views a cart containing an artwork that another buyer has since purchased
- **THEN** the line is marked unavailable, is excluded from the total, and cannot be checked out

#### Scenario: Price changed since adding
- **WHEN** an artist changes the price of an artwork already in a buyer's cart
- **THEN** the cart shows the current price and flags that it changed

### Requirement: Inventory reservation at checkout
The system SHALL reserve inventory when checkout begins, holding it for a configured reservation window. A reservation SHALL prevent any other buyer from checking out the same unit. If payment is not completed within the window, the reservation SHALL be released automatically. Reservation SHALL be atomic — two concurrent checkouts SHALL NOT both succeed against the same unit.

#### Scenario: Concurrent checkout of a unique piece
- **WHEN** two buyers begin checkout for the same unique artwork at the same moment
- **THEN** exactly one reservation succeeds and the other buyer is told the piece is no longer available

#### Scenario: Reservation expires
- **WHEN** a buyer begins checkout and does not complete payment within the reservation window
- **THEN** the reservation is released and the artwork becomes purchasable again

#### Scenario: Reservation confirmed
- **WHEN** payment for a reserved artwork succeeds
- **THEN** the reservation converts to a sale and inventory is decremented

### Requirement: Checkout collects delivery and contact details
The system SHALL collect the buyer's full name, phone number, and delivery address before payment, and SHALL present a full cost breakdown of item prices, shipping, and total in ILS before the buyer confirms.

#### Scenario: Cost breakdown before confirmation
- **WHEN** a buyer reaches the final checkout step
- **THEN** the system displays item prices, shipping cost, and the total in ILS before any payment action

#### Scenario: Incomplete delivery details
- **WHEN** a buyer attempts to confirm without a phone number or complete address
- **THEN** the system blocks the order and identifies the missing fields

### Requirement: Payment provider abstraction
The system SHALL route all payment operations — authorise, capture, and refund — through a single internal payment interface. No provider-specific code SHALL exist outside an adapter implementing that interface. This change SHALL ship a manual adapter that records a payment as pending settlement and marks it paid on operator confirmation; no live payment provider is integrated.

#### Scenario: Order placed with the manual adapter
- **WHEN** a buyer confirms an order under the manual adapter
- **THEN** the order is created in `awaiting_payment`, inventory stays reserved, and both buyer and operator receive instructions by email

#### Scenario: Operator confirms payment received
- **WHEN** an operator marks an awaiting-payment order as paid
- **THEN** the order moves to `paid`, the reservation converts to a sale, and the artist is notified to dispatch

#### Scenario: Adding a real provider
- **WHEN** a payment provider is later integrated
- **THEN** it is added as a new adapter behind the same interface, with no change required to cart, checkout, or order logic

### Requirement: Order state machine
An order SHALL occupy exactly one state: `awaiting_payment`, `paid`, `shipped`, `delivered`, `return_requested`, `returned`, or `cancelled`. Permitted transitions SHALL be `awaiting_payment` → `paid` or `cancelled`; `paid` → `shipped` or `cancelled`; `shipped` → `delivered`; `delivered` → `return_requested`; `return_requested` → `returned` or `delivered`. Every transition SHALL be recorded with actor and timestamp.

#### Scenario: Invalid transition rejected
- **WHEN** any actor attempts to move an order directly from `awaiting_payment` to `shipped`
- **THEN** the system rejects the transition and leaves the order unchanged

#### Scenario: Transition history recorded
- **WHEN** an order changes state
- **THEN** the system records the previous state, new state, the acting account, and a timestamp

#### Scenario: Cancellation restores inventory
- **WHEN** an order in `awaiting_payment` or `paid` is cancelled
- **THEN** the reserved inventory is released and the artwork becomes purchasable again

### Requirement: Multi-artist orders split into per-artist fulfilment
Where a single order contains artworks from more than one artist, the system SHALL create a separate fulfilment record per artist. Each fulfilment SHALL be shipped, tracked, and paid out independently, while the buyer sees one order.

#### Scenario: Order spanning two artists
- **WHEN** a buyer orders one artwork from each of two artists
- **THEN** the system creates two fulfilment records, each visible only to its own artist, under one buyer-facing order

#### Scenario: One fulfilment ships before the other
- **WHEN** one artist marks their fulfilment shipped and the other has not
- **THEN** the buyer's order shows one item shipped and one still awaiting dispatch

### Requirement: Order visibility respects artist anonymity in both directions
The system SHALL show an artist only the buyer's name, phone number, and delivery address for their own fulfilment, and only after the order reaches `paid`. The system SHALL NOT show the buyer the artist's contact details at any point.

#### Scenario: Artist views a paid fulfilment
- **WHEN** an artist opens a fulfilment in `paid` state
- **THEN** they see the buyer's name, phone, and delivery address for that fulfilment only

#### Scenario: Artist views an unpaid order
- **WHEN** an artist attempts to view buyer details for an order still in `awaiting_payment`
- **THEN** the system withholds the buyer's contact details

#### Scenario: Artist views another artist's fulfilment
- **WHEN** an artist requests a fulfilment belonging to a different artist
- **THEN** the system returns a not-found response
