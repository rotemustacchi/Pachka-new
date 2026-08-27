## Purpose

Governs how physical goods reach the buyer and how they come back: flat-rate shipping tiers calculated without any carrier integration, artist-managed fulfilment with packaging obligations for fragile work, and the 14-day cancellation right that Israeli distance-selling law grants the buyer.

## ADDED Requirements

### Requirement: Flat-rate shipping tiers
The system SHALL calculate shipping cost from a configured rate table keyed on delivery zone and package size tier, without calling any carrier API. The artist SHALL select the size tier per artwork at listing time from a fixed set of tiers, each defined by maximum dimensions and weight. The rate table SHALL be editable by an admin without a code deployment.

#### Scenario: Shipping quoted at checkout
- **WHEN** a buyer reaches checkout with a delivery address
- **THEN** the system quotes shipping from the rate table using the artwork's size tier and the address's zone

#### Scenario: Artwork exceeds every tier
- **WHEN** an artist enters dimensions or weight exceeding the largest configured tier
- **THEN** the system marks the artwork as requiring a shipping quote and blocks standard checkout for it

#### Scenario: Multiple artworks from one artist
- **WHEN** an order contains two artworks from the same artist
- **THEN** the system charges shipping per fulfilment using the largest applicable size tier, not the sum of the individual tiers

#### Scenario: Address outside every configured zone
- **WHEN** a buyer enters a delivery address that maps to no configured zone
- **THEN** the system blocks checkout and states that the platform does not currently deliver to that address

### Requirement: Artist-managed fulfilment
The artist SHALL be responsible for packing and dispatching their own fulfilments. The system SHALL require the artist to record a carrier name and tracking reference when marking a fulfilment shipped, and SHALL notify the buyer with that reference.

#### Scenario: Artist marks a fulfilment shipped
- **WHEN** an artist submits a carrier name and tracking reference for a paid fulfilment
- **THEN** the fulfilment moves to shipped and the buyer receives a notification containing the tracking reference

#### Scenario: Shipping without a tracking reference
- **WHEN** an artist attempts to mark a fulfilment shipped without a tracking reference
- **THEN** the system rejects the transition

#### Scenario: Dispatch deadline passes
- **WHEN** a fulfilment remains unshipped beyond the artwork's stated lead time plus the configured grace period
- **THEN** the system notifies the artist and flags the fulfilment for admin attention

### Requirement: Packaging obligations for fragile work
For artworks whose medium is ceramics and objects, or that the artist has marked fragile, the system SHALL present mandatory packaging requirements before the artist can mark the fulfilment shipped, and SHALL require the artist to confirm compliance. The MVP SHALL NOT offer breakage insurance.

#### Scenario: Fragile fulfilment requires confirmation
- **WHEN** an artist marks a ceramic fulfilment shipped
- **THEN** the system requires explicit confirmation that the packaging requirements were met before allowing the transition

#### Scenario: No insurance offered
- **WHEN** a buyer views shipping options at checkout for a fragile artwork
- **THEN** no breakage insurance product is offered or charged

### Requirement: Fourteen-day cancellation right
The system SHALL allow a buyer to request cancellation within 14 days of delivery, per Israeli distance-selling law. The request SHALL be made through the platform and SHALL move the order to `return_requested`. The system SHALL display the return terms — including who bears return shipping and transit risk — on the artwork page and at checkout, before purchase.

#### Scenario: Buyer requests a return in time
- **WHEN** a buyer requests cancellation 10 days after delivery
- **THEN** the system accepts the request, moves the order to `return_requested`, and issues return instructions addressed to the PACHKA return address

### Requirement: Returns route through a PACHKA return address
Returned artworks SHALL be sent to a PACHKA-operated return address, never directly to the artist, so that the artist's physical address is never disclosed to a buyer. The system SHALL issue return instructions naming only that address. On arrival, an operator SHALL record receipt and condition, and SHALL forward the artwork to the artist. The artist's own address SHALL be used only on the operator-generated forwarding label, which the buyer never sees.

Outbound parcels SHALL likewise carry the PACHKA return address rather than the artist's, because a return address printed on the shipping label would otherwise disclose it on the first sale.

#### Scenario: Return instructions name only PACHKA
- **WHEN** a return request is accepted
- **THEN** the instructions issued to the buyer name the PACHKA return address, and contain no artist address, phone number, or email

#### Scenario: Operator records arrival
- **WHEN** a returned artwork arrives at the PACHKA return address
- **THEN** an operator records receipt and condition, and the case proceeds to refund or dispute on that record

#### Scenario: Outbound label does not disclose the artist
- **WHEN** an artist dispatches a sold artwork
- **THEN** the return address on the parcel is the PACHKA return address

#### Scenario: Forwarding does not reach the buyer
- **WHEN** an operator forwards a returned artwork to its artist
- **THEN** the artist's address appears only on the forwarding record, and is never exposed in any buyer-facing view or API response

#### Scenario: Return window has closed
- **WHEN** a buyer requests cancellation 20 days after delivery
- **THEN** the system declines the request and states that the statutory window has closed

#### Scenario: Terms shown before purchase
- **WHEN** a buyer views an artwork page or the checkout summary
- **THEN** the return terms, including return shipping responsibility and transit risk, are visible before purchase

### Requirement: Return cost and transit risk fall on the buyer
The system SHALL state, and apply, that the buyer bears the cost of return shipping and the risk of damage in return transit. A refund SHALL be issued after an operator records the returned artwork as received at the PACHKA return address in its original condition, or on admin resolution where a case is disputed. The artist SHALL NOT be the sole party able to release a refund, since the platform holds the buyer's money and bears the resulting liability. The platform MAY deduct a cancellation fee up to the statutory maximum.

#### Scenario: Return arrives intact
- **WHEN** an artist confirms receipt of a returned artwork in original condition
- **THEN** the order moves to `returned`, inventory is restored, and a refund less any applicable cancellation fee is issued

#### Scenario: Return arrives damaged
- **WHEN** an artist reports that a returned artwork arrived damaged
- **THEN** the system withholds the refund, moves the case to the admin queue, and notifies both parties

#### Scenario: Return never arrives
- **WHEN** a return is not confirmed received within the configured window after the request
- **THEN** the system flags the case for admin review and does not refund automatically

#### Scenario: Artist does not respond to a delivered return
- **WHEN** tracking shows the returned artwork delivered to the artist and the artist neither confirms receipt nor reports damage within the configured response window
- **THEN** the system escalates to an admin, who may resolve the refund in the buyer's favour — artist silence SHALL NOT indefinitely withhold a buyer's money

### Requirement: Return restores inventory only when resolved in the buyer's favour
The system SHALL restore a returned artwork to purchasable state only when the return completes with the artwork intact. A unique artwork under an unresolved return SHALL remain unavailable.

#### Scenario: Unique artwork returned intact
- **WHEN** a returned unique artwork is confirmed intact
- **THEN** it returns to published state and becomes purchasable again

#### Scenario: Return unresolved
- **WHEN** a return is pending or disputed
- **THEN** the artwork remains unavailable for purchase
