## Purpose

Defines what an artwork listing is: the taxonomy that the matchmaker depends on, the specification fields a buyer needs in the absence of any messaging channel, the inventory model for unique pieces and editions, and the declarations an artist must make about originality and AI assistance.

## ADDED Requirements

### Requirement: Artwork taxonomy
Every artwork SHALL be classified along four axes. Medium SHALL be exactly one of: painting and illustration, photography, ceramics and objects, jewelry, textile and clothing. Style SHALL be one or more of: minimalist, abstract, boho and coastal, modern industrial, pop art. Target space SHALL be zero or more of: living room, bedroom, office or clinic, children's room, kitchen. Mood SHALL be one or more of: calm, bold, romantic, edgy. The taxonomy SHALL be a closed, server-defined set; artists SHALL NOT introduce new values.

#### Scenario: Artist publishes with a complete classification
- **WHEN** an artist publishes an artwork with one medium, at least one style, and at least one mood
- **THEN** the system accepts the classification

#### Scenario: Artist submits without a style or mood
- **WHEN** an artist attempts to publish an artwork with no style or no mood selected
- **THEN** the system blocks publication and identifies the missing axis

#### Scenario: Client submits a value outside the taxonomy
- **WHEN** a client submits a taxonomy value not in the server-defined set
- **THEN** the system rejects the request

### Requirement: Mandatory specification fields
Because the MVP provides no channel for a buyer to ask the artist a question, the system SHALL require the following before publication: title, description, price in ILS, dimensions in centimetres (height and width; depth where the medium is three-dimensional), weight in grams, primary materials, whether the piece is framed or ready to hang for wall-mounted media, and dispatch lead time in business days. All of these SHALL be shown on the artwork detail page.

#### Scenario: Publication blocked on missing specifications
- **WHEN** an artist attempts to publish an artwork missing dimensions, weight, or lead time
- **THEN** the system blocks publication and lists every missing field

#### Scenario: Specifications rendered to buyers
- **WHEN** a buyer views a published artwork
- **THEN** the page displays dimensions, weight, materials, framing status where applicable, and dispatch lead time

### Requirement: Unique pieces and editions
The system SHALL support two inventory types. A unique artwork has a fixed quantity of exactly 1 and, once sold, SHALL never be purchasable again. An edition has a stated quantity greater than 1, decremented on each sale, and MAY be marked as made to order with a stated production lead time.

#### Scenario: Unique piece sells out
- **WHEN** an order containing a unique artwork is confirmed
- **THEN** the artwork is marked sold, is removed from purchasable results, and its detail page displays it as sold

#### Scenario: Edition stock decrements
- **WHEN** an order containing one item from an edition of 10 is confirmed
- **THEN** the remaining quantity becomes 9 and the artwork remains purchasable

#### Scenario: Edition reaches zero
- **WHEN** the last remaining item of an edition is sold
- **THEN** the artwork is marked sold out and is no longer purchasable

### Requirement: Originality declaration
The system SHALL require the artist to affirm, per artwork, that the work is their own original creation and that they hold the intellectual property rights to it. The system SHALL NOT allow publication without this affirmation, and SHALL record who affirmed it and when.

#### Scenario: Artist affirms originality
- **WHEN** an artist checks the originality declaration and publishes
- **THEN** the system records the declaration with the account identifier and a timestamp

#### Scenario: Publication attempted without the declaration
- **WHEN** an artist attempts to publish without affirming originality
- **THEN** the system blocks publication

### Requirement: AI-assistance disclosure
The system SHALL require the artist to declare whether the artwork was created with substantial generative AI assistance. Where declared, a visible label SHALL appear on the artwork card and detail page. The system SHALL NOT attempt automated detection of AI-generated art; enforcement is by declaration, backed by the reporting mechanism.

#### Scenario: Artist declares AI assistance
- **WHEN** an artist marks an artwork as AI-assisted and publishes
- **THEN** an AI-assisted label is shown on the artwork card and detail page

#### Scenario: Publication attempted without answering
- **WHEN** an artist attempts to publish without answering the AI-assistance question
- **THEN** the system blocks publication

### Requirement: Listing lifecycle
An artwork SHALL occupy exactly one state: `draft`, `published`, `sold`, `unlisted`, or `removed`. Only `published` artworks appear in the catalog and matchmaker results. An artist MAY move their own artwork between `draft`, `published`, and `unlisted`. Only an admin MAY set `removed`, and a `removed` artwork SHALL NOT be restorable by the artist.

#### Scenario: Artist unlists an artwork
- **WHEN** an artist unlists a published artwork
- **THEN** it disappears from the catalog and matchmaker results but remains visible in the artist's dashboard

#### Scenario: Artist attempts to republish a removed artwork
- **WHEN** an artist attempts to change a removed artwork to published
- **THEN** the system rejects the change

#### Scenario: Artwork with a pending order cannot be unlisted
- **WHEN** an artist attempts to unlist an artwork that is reserved by an in-progress order
- **THEN** the system rejects the change and explains that the order must resolve first
