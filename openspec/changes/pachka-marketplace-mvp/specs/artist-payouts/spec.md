## Purpose

Tracks what the platform owes each artist and when: commission calculation at order time, payout eligibility only once the return window has closed, and a ledger that an operator settles by manual bank transfer because no automated split-payment integration exists in the MVP.

## ADDED Requirements

### Requirement: Commission is a configuration value
The system SHALL calculate platform commission as a percentage of the item subtotal, excluding shipping. The percentage SHALL be a configuration value with a default of 15%, changeable by an admin without a code deployment. The rate in effect at the moment an order is placed SHALL be stored on the order and SHALL NOT change retroactively.

#### Scenario: Commission calculated at order time
- **WHEN** an order for an artwork priced ₪1,000 is placed while commission is 15%
- **THEN** the system records ₪150 platform commission and ₪850 payable to the artist, excluding shipping

#### Scenario: Rate changes later
- **WHEN** an admin changes the commission rate after an order was placed
- **THEN** existing orders retain the rate stored at their placement

#### Scenario: Shipping excluded from commission
- **WHEN** an order totals ₪1,000 for the artwork plus ₪50 shipping
- **THEN** commission is calculated on ₪1,000 only

### Requirement: Payout eligibility opens after delivery plus the return window
A payout SHALL become eligible only when its fulfilment has been in `delivered` state for the full 14-day return window without a return request. A fulfilment under `return_requested` SHALL NOT be eligible. The artist SHALL be able to see the exact date their payout becomes eligible.

#### Scenario: Return window closes cleanly
- **WHEN** a fulfilment has been delivered for 14 days with no return request
- **THEN** its payout becomes eligible and appears in the payable queue

#### Scenario: Return requested during the window
- **WHEN** a buyer requests a return on day 9 after delivery
- **THEN** the payout does not become eligible and is held pending resolution

#### Scenario: Artist sees the date
- **WHEN** an artist views a delivered fulfilment in their dashboard
- **THEN** the exact eligibility date is displayed

### Requirement: Payout ledger
The system SHALL maintain a per-artist ledger recording, for every fulfilment: gross amount, commission, net payable, eligibility date, payout status, and — once settled — the settlement date and operator reference. Ledger entries SHALL be append-only; corrections SHALL be recorded as new adjusting entries rather than edits.

#### Scenario: Ledger entry created
- **WHEN** a fulfilment is paid
- **THEN** a ledger entry is created with gross, commission, net payable, and a status of pending

#### Scenario: Artist views their balance
- **WHEN** an artist opens their payouts view
- **THEN** they see totals for pending, eligible, and settled amounts, with the underlying entries

#### Scenario: Correction recorded
- **WHEN** an operator corrects an amount
- **THEN** the system appends an adjusting entry referencing the original and does not modify it

### Requirement: Manual settlement recorded by an operator
The system SHALL provide an admin view listing every eligible, unsettled payout with the amount and the artist's payout details. An operator SHALL mark a payout settled by recording a settlement date and a bank transfer reference. The system SHALL NOT initiate any transfer itself.

#### Scenario: Operator settles a payout
- **WHEN** an operator records a settlement date and transfer reference against an eligible payout
- **THEN** the payout is marked settled, the artist is notified, and the reference is stored on the ledger entry

#### Scenario: Settling an ineligible payout
- **WHEN** an operator attempts to settle a payout that is not yet eligible
- **THEN** the system rejects the action and states the eligibility date

#### Scenario: No automated transfer
- **WHEN** a payout becomes eligible
- **THEN** the system notifies the operator but initiates no financial transaction

### Requirement: Artists supply payout details before their first eligible payout
The system SHALL require an artist to record a bank account holder name, bank, branch, and account number before any payout can be settled, and SHALL prompt them once their first fulfilment is paid. These details SHALL be visible only to the artist and to admins.

#### Scenario: Artist prompted after first sale
- **WHEN** an artist's first fulfilment reaches paid and no payout details are on file
- **THEN** the system prompts the artist to supply them

#### Scenario: Settlement blocked without details
- **WHEN** an operator attempts to settle a payout for an artist with no payout details on file
- **THEN** the system blocks the action

#### Scenario: Payout details are private
- **WHEN** any buyer-facing view or API response is produced
- **THEN** it contains no artist bank details
