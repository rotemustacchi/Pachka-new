## Purpose

Provides the public, browsable catalog of published artworks with filtering and the artwork detail page — the buyer's route into the marketplace alongside the matchmaker, and the surface that must communicate everything about a piece in the absence of any way to ask the artist a question.

## ADDED Requirements

### Requirement: Public catalog
The system SHALL present a paginated catalog of all `published` artworks to any visitor, signed in or not. Sold-out and unlisted artworks SHALL NOT appear. Each catalog entry SHALL show the primary image, title, artist display name, price in ILS, and the AI-assisted label where applicable.

#### Scenario: Anonymous visitor browses
- **WHEN** an anonymous visitor opens the catalog
- **THEN** the system displays published artworks with image, title, artist name, and price, without requiring sign-in

#### Scenario: Sold artwork excluded
- **WHEN** a unique artwork has been sold
- **THEN** it no longer appears in catalog results

#### Scenario: Empty catalog
- **WHEN** no artworks are published
- **THEN** the system displays a message inviting artists to join, rather than an empty grid or an error

### Requirement: Filtering and sorting
The system SHALL allow filtering the catalog by medium, style, target space, mood, and price range, and combining filters across axes. The system SHALL allow sorting by newest and by price ascending or descending. Active filters SHALL be reflected in the URL so that a filtered view can be shared and reloaded.

#### Scenario: Combined filters
- **WHEN** a visitor filters by medium `ceramics and objects`, mood `calm`, and a price range of ₪200–₪600
- **THEN** the system returns only published artworks satisfying all three conditions

#### Scenario: Filters yield nothing
- **WHEN** a filter combination matches no artworks
- **THEN** the system states that nothing matched and offers to clear individual filters

#### Scenario: Filtered view is shareable
- **WHEN** a visitor copies the URL of a filtered catalog view and opens it in a new session
- **THEN** the same filters are applied

### Requirement: Artwork detail page
The system SHALL provide a detail page for each published artwork showing all images, the full specification set, the taxonomy classification, the artist's display name linking to their profile, availability, estimated shipping cost range, and the return policy summary.

#### Scenario: Buyer opens an artwork
- **WHEN** a visitor opens a published artwork's detail page
- **THEN** the page shows images, dimensions, weight, materials, lead time, classification, artist link, availability, shipping cost range, and return policy summary

#### Scenario: Unavailable artwork requested directly
- **WHEN** a visitor opens the URL of an artwork that has been sold or unlisted
- **THEN** the page renders in a read-only state marked unavailable, with no purchase action

#### Scenario: Removed artwork requested directly
- **WHEN** a visitor opens the URL of an artwork an admin has removed
- **THEN** the system returns a not-found response
