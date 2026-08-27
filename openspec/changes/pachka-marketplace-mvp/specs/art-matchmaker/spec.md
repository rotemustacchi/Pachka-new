## Purpose

The AI matchmaker is PACHKA's defining feature: a short questionnaire about style, palette, space, budget, and mood that returns a small ranked set of artworks from the community, so a buyer does not have to sift a catalog to find work that fits their home.

## ADDED Requirements

### Requirement: Buyer questionnaire
The system SHALL present a questionnaire of at most seven questions covering preferred styles, colour palette, target space, mood, budget range in ILS, and available wall or surface dimensions. Every question except budget SHALL be optional, and the buyer SHALL be able to submit the questionnaire without an account.

#### Scenario: Anonymous buyer completes the questionnaire
- **WHEN** an anonymous visitor answers the questionnaire and submits it
- **THEN** the system returns ranked matches without requiring registration

#### Scenario: Buyer skips optional questions
- **WHEN** a buyer answers only budget and mood
- **THEN** the system returns ranked matches using the answers provided, without demanding the skipped ones

#### Scenario: Budget omitted
- **WHEN** a buyer attempts to submit without a budget range
- **THEN** the system blocks submission and explains that budget is required

### Requirement: Ranking without per-query model calls
The system SHALL rank published artworks against the buyer's answers using precomputed artwork embeddings and stored taxonomy values, combined by a scoring function evaluated within the platform. The system SHALL NOT issue a call to an external AI model per matchmaker query.

#### Scenario: Query is served locally
- **WHEN** a buyer submits the questionnaire
- **THEN** the system produces the ranking without any outbound request to an external AI model

#### Scenario: Ranking is reproducible
- **WHEN** the same answers are submitted twice against an unchanged catalog
- **THEN** the system returns the same artworks in the same order

### Requirement: Budget is a ranking signal, not a hard cut
The system SHALL treat the stated budget as a strong ranking signal rather than an absolute filter. Artworks priced above the stated budget MAY appear when they score highly on other axes, and SHALL be visibly marked as above budget with the amount by which they exceed it.

#### Scenario: Strong match above budget
- **WHEN** an artwork scores highly on style, space, and mood but is priced 20% above the buyer's stated budget
- **THEN** it may appear in the results, labelled as above budget with the difference shown

#### Scenario: Far above budget
- **WHEN** an artwork is priced more than the configured over-budget tolerance above the stated budget
- **THEN** it is excluded from the results regardless of its other scores

### Requirement: Honest behavior on a sparse catalog
The system SHALL return up to the configured result count, but SHALL return fewer results rather than padding with low-scoring artworks. When fewer results are returned than requested, or when the total published catalog is below the configured sparse threshold, the system SHALL display a plain message that the community is still growing.

#### Scenario: Catalog is nearly empty
- **WHEN** the catalog holds fewer artworks than the sparse threshold and a buyer submits the questionnaire
- **THEN** the system returns whatever matches exist and displays a message that the community is still growing

#### Scenario: No artwork clears the minimum score
- **WHEN** no published artwork scores above the minimum match threshold
- **THEN** the system returns no matches, says so directly, and offers the full catalog and a notify-me option instead of showing poor matches

#### Scenario: Results are never padded
- **WHEN** only two artworks score above the minimum threshold and the configured result count is five
- **THEN** the system returns exactly two results

### Requirement: Escape hatch from the results
Every matchmaker result view SHALL offer the buyer a way to continue: revising their answers, opening the full filtered catalog, or requesting notification when new matching work is listed.

#### Scenario: Buyer rejects the matches
- **WHEN** a buyer views their matches and none appeal
- **THEN** the view offers to adjust the answers, browse the full catalog pre-filtered by those answers, or be notified about future matches

#### Scenario: Buyer requests notification
- **WHEN** a buyer submits an email address for notification about future matches
- **THEN** the system stores the answers with the address and confirms the request

### Requirement: Exposure rotation
Where two or more artworks score within the configured tie tolerance of one another, the system SHALL vary their relative order between queries so that ranking does not permanently favour the same artworks. Artworks with fewer lifetime match impressions SHALL be preferred within a tie band.

#### Scenario: Near-equal scores rotate
- **WHEN** three artworks score within the tie tolerance for the same top position across repeated queries by different buyers
- **THEN** the system does not always present the same one first, favouring those with fewer lifetime impressions

#### Scenario: Clear winner is not displaced
- **WHEN** one artwork scores well outside the tie tolerance above all others
- **THEN** it is ranked first regardless of its impression count

### Requirement: Match impressions are recorded
The system SHALL record, per artwork, the number of times it has been returned in matchmaker results, and SHALL expose that count to the artist in their dashboard and to admins.

#### Scenario: Impression counted
- **WHEN** an artwork is returned in a matchmaker result set
- **THEN** its impression count increases by one

#### Scenario: Artist sees exposure
- **WHEN** an artist opens their dashboard
- **THEN** each of their published artworks shows its match impression count
