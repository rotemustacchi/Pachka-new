## Purpose

Defines the automated gate every uploaded image passes through — technical quality checks, safety screening, AI tag suggestion, and embedding generation — so that the catalog holds usable photographs and the matchmaker has consistent data to rank against, without any human reviewing uploads before publication.

## ADDED Requirements

### Requirement: Technical quality gate
The system SHALL reject an uploaded image that falls below the published minimum quality bar: shorter edge under 1200 pixels, file size under 100 KB, or a blur score below the configured threshold. Rejection SHALL state which check failed and what the artist can do about it. Thresholds SHALL be configuration values changeable without a code deployment.

#### Scenario: Image below minimum resolution
- **WHEN** an artist uploads an image whose shorter edge is 800 pixels
- **THEN** the system rejects it and states the minimum resolution required

#### Scenario: Blurry image
- **WHEN** an artist uploads an image whose blur score is below the threshold
- **THEN** the system rejects it and advises retaking the photograph in better focus

#### Scenario: Acceptable image
- **WHEN** an artist uploads an image passing every technical check
- **THEN** the system accepts it and proceeds to safety screening

### Requirement: Safety screening
The system SHALL screen every accepted image for adult, violent, and hateful content, and SHALL block any image the screening flags above the configured confidence threshold. A blocked upload SHALL be recorded for admin review. No image SHALL reach a public surface without a successful screening verdict: a screening failure blocks publication, never merely warns. The system SHALL NOT attempt to determine whether an item is mass-produced or factory-made — that is handled reactively by moderation.

#### Scenario: Image flagged as unsafe
- **WHEN** safety screening flags an uploaded image above the threshold
- **THEN** the system blocks the upload, informs the artist that the image did not pass content screening, and records the event for admin review

#### Scenario: Screening service unavailable
- **WHEN** the safety screening service cannot be reached
- **THEN** the system accepts the upload into the artist's draft, blocks publication until screening succeeds or an admin clears it, flags the artwork for admin review, and records the screening failure

#### Scenario: Screening failure is not a publication bypass
- **WHEN** an artist repeatedly triggers screening failures and attempts to publish
- **THEN** every affected artwork remains unpublished and no unscreened image reaches any public surface

### Requirement: AI tag suggestion with artist override
The system SHALL analyse each accepted primary image and suggest values for medium, style, mood, and dominant colours. Suggestions SHALL be presented to the artist as pre-filled, editable selections. The artist's final choice SHALL always take precedence, and the system SHALL record whether each stored value was AI-suggested or artist-set.

#### Scenario: Suggestions pre-fill the form
- **WHEN** an artist uploads an image and analysis completes
- **THEN** the classification form appears with suggested medium, style, mood, and colour values pre-selected and editable

#### Scenario: Artist overrides a suggestion
- **WHEN** an artist changes an AI-suggested style before publishing
- **THEN** the system stores the artist's value and records it as artist-set

#### Scenario: Analysis fails
- **WHEN** the analysis service returns an error or times out
- **THEN** the system presents an empty classification form for manual completion and does not block the upload

### Requirement: Embedding generated once per artwork
The system SHALL compute and store a vector embedding for each published artwork's primary image at upload time. The embedding SHALL be recomputed only when the primary image changes. The system SHALL NOT compute embeddings at query time.

#### Scenario: Embedding stored on publication
- **WHEN** an artwork is published
- **THEN** a vector embedding derived from its primary image is stored alongside the artwork record

#### Scenario: Primary image replaced
- **WHEN** an artist replaces the primary image of a published artwork
- **THEN** the system recomputes and replaces the stored embedding

#### Scenario: Embedding generation fails
- **WHEN** embedding generation fails for an artwork
- **THEN** the artwork is still published and remains browsable in the catalog, but is excluded from matchmaker results until an embedding exists

### Requirement: Image storage and delivery
The system SHALL store an optimised, size-limited derivative of each uploaded image for display and SHALL retain the original. Displayed images SHALL NOT carry a watermark. The system SHALL serve display images no larger than the configured maximum display dimension. Every served derivative SHALL have all EXIF and XMP metadata stripped, GPS coordinates in particular — an artist's studio location to within metres is more precise than the street address this platform already refuses to disclose. Uploads SHALL be written only through the pipeline; direct client writes to the image store SHALL be refused.

#### Scenario: Location metadata is stripped
- **WHEN** an artist uploads a photograph carrying GPS EXIF coordinates
- **THEN** the served derivative contains no EXIF or XMP metadata of any kind

#### Scenario: Direct store write is refused
- **WHEN** a client attempts to write an image to the store without going through the upload pipeline
- **THEN** the write is refused

#### Scenario: Optimised derivative served
- **WHEN** a buyer loads an artwork detail page
- **THEN** the system serves a compressed derivative no larger than the configured maximum display dimension

#### Scenario: No watermark applied
- **WHEN** any artwork image is served to a buyer
- **THEN** the image carries no PACHKA watermark or overlay
