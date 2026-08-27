## Purpose

Produces a digital Certificate of Authenticity for every completed sale — a document that records the artist's own declaration about their work, while stating plainly that PACHKA has not independently verified it.

## ADDED Requirements

### Requirement: Certificate generated on every completed sale
The system SHALL generate a certificate for each fulfilment when it reaches `delivered`, and SHALL make it available to the buyer from their order view and by emailed link. One certificate SHALL be generated per artwork unit sold.

#### Scenario: Certificate available after delivery
- **WHEN** a fulfilment reaches delivered
- **THEN** the system generates a certificate and makes it downloadable from the buyer's order view

#### Scenario: Order containing two artworks
- **WHEN** an order containing two artworks is fully delivered
- **THEN** the system generates two separate certificates

#### Scenario: Certificate withheld before delivery
- **WHEN** a buyer views an order that is paid but not yet delivered
- **THEN** no certificate is available

### Requirement: Certificate contents
Each certificate SHALL state the artwork title, the artist's display name, medium, dimensions, year of creation, edition information where applicable, the buyer's name, the sale date, a unique certificate identifier, and an image of the artwork.

#### Scenario: Unique artwork certificate
- **WHEN** a certificate is generated for a one-of-a-kind artwork
- **THEN** it identifies the work as one of a kind

#### Scenario: Edition artwork certificate
- **WHEN** a certificate is generated for item 3 of an edition of 10
- **THEN** it states the edition position and total

### Requirement: Certificate discloses the limits of what it asserts
Every certificate SHALL carry explicit text stating that its contents reflect the declaration made by the artist and that PACHKA has not independently verified the authenticity, provenance, or originality of the artwork. Where the artist declared AI assistance, the certificate SHALL state so.

#### Scenario: Disclaimer present
- **WHEN** any certificate is generated
- **THEN** it contains text stating that the contents are the artist's declaration and are not verified by PACHKA

#### Scenario: AI-assisted work
- **WHEN** a certificate is generated for an artwork the artist declared as AI-assisted
- **THEN** the certificate states that the artist declared generative AI assistance

### Requirement: Certificates are verifiable and immutable
Each certificate SHALL carry a unique identifier resolvable at a public URL. The buyer's name SHALL appear only on the certificate document delivered privately to the buyer, never on the public verification page — publishing a purchase record naming a private individual is not acceptable. Certificate identifiers SHALL be unguessable, and the verification endpoint SHALL be rate limited so the identifier space cannot be enumerated. A generated certificate SHALL NOT be modifiable. Where the underlying sale is reversed by a completed return, the public verification page SHALL show the certificate as void.

#### Scenario: Public verification does not name the buyer
- **WHEN** anyone opens the public URL for a valid certificate identifier
- **THEN** the page displays the artwork, artist, medium, dimensions, edition information, sale date and validity — and SHALL NOT display the buyer's name or any other buyer detail

#### Scenario: Sale reversed by return
- **WHEN** an order whose certificate was issued completes a return
- **THEN** the public verification page shows the certificate as void

#### Scenario: Unknown identifier
- **WHEN** anyone opens the public URL for an identifier that does not exist
- **THEN** the system returns a not-found response

#### Scenario: Enumeration is refused
- **WHEN** a client requests many certificate identifiers in rapid succession
- **THEN** the endpoint rate limits the client
