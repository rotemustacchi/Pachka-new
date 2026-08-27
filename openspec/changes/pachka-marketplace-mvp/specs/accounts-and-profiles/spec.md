## Purpose

Defines who can use PACHKA and what each role can do, and governs the public artist profile — in particular the rule that an artist's direct contact details are never exposed to buyers, so transactions stay on the platform.

## ADDED Requirements

### Requirement: Open self-service registration
The system SHALL allow any visitor to register an account with an email address and password without approval by an operator. A registered account SHALL hold one or more of the roles `buyer`, `artist`, and `admin`.

#### Scenario: Visitor registers as a buyer
- **WHEN** a visitor submits a valid email address and a password meeting the minimum strength policy
- **THEN** the system creates an account with the `buyer` role and sends a verification email

#### Scenario: Buyer upgrades to artist
- **WHEN** a signed-in buyer completes the artist profile form (display name, bio, profile photo)
- **THEN** the system adds the `artist` role to the account and grants access to artwork upload without any operator approval step

#### Scenario: Email already registered
- **WHEN** a visitor registers with an email address that already has an account
- **THEN** the system rejects the registration and does not reveal whether the address is registered beyond a generic message

### Requirement: Email verification gates selling and buying
The system SHALL require a verified email address before an account may publish an artwork or place an order. Browsing SHALL NOT require verification.

#### Scenario: Unverified artist attempts to publish
- **WHEN** an artist with an unverified email attempts to publish an artwork
- **THEN** the system blocks publication and prompts the artist to verify their email

#### Scenario: Unverified buyer attempts checkout
- **WHEN** a buyer with an unverified email attempts to place an order
- **THEN** the system blocks the order and prompts for verification

### Requirement: Public artist profile
The system SHALL provide a public profile page for every artist with at least one published artwork, showing display name, profile photo, biography, location at city granularity, published artworks, and buyer reviews.

#### Scenario: Visitor views an artist profile
- **WHEN** any visitor, signed in or not, opens an artist profile page
- **THEN** the system displays the artist's display name, photo, biography, city, published artworks, and reviews

#### Scenario: Artist has no published artworks
- **WHEN** a visitor requests the profile of an artist with zero published artworks
- **THEN** the system returns a not-found response

### Requirement: Artist contact details are never public
The system SHALL NOT expose an artist's email address, phone number, physical address, or social media handles anywhere in the buyer-facing interface or API, at any stage — including after a completed purchase. Free-text fields written by artists SHALL be scanned on save, and content matching email, phone number, or social handle patterns SHALL be rejected with an explanation.

#### Scenario: Artist puts a phone number in their biography
- **WHEN** an artist saves a biography containing a phone number or an Instagram handle
- **THEN** the system rejects the save and explains that contact details are not permitted

#### Scenario: Buyer inspects artist data over the API
- **WHEN** any client requests artist profile data through the public API
- **THEN** the response contains no email address, phone number, street address, or social handle for that artist

#### Scenario: Order is completed
- **WHEN** an order reaches the delivered state
- **THEN** the buyer is still not shown the artist's contact details

### Requirement: Buyers may review artists only after a completed purchase
The system SHALL permit a buyer to leave one review per completed order, consisting of a 1–5 star rating and optional text. Reviews SHALL be attributed to the buyer's display name and SHALL be publicly visible on the artist's profile.

#### Scenario: Buyer reviews after delivery
- **WHEN** a buyer whose order has reached the delivered state submits a rating and text
- **THEN** the system stores the review and displays it on the artist's profile

#### Scenario: Non-purchaser attempts a review
- **WHEN** an account with no completed order from that artist submits a review
- **THEN** the system rejects the submission

#### Scenario: Duplicate review on one order
- **WHEN** a buyer submits a second review for an order they have already reviewed
- **THEN** the system rejects the submission and offers to edit the existing review
