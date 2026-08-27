## Purpose

The MVP publishes artwork with no human review beforehand, so moderation is reactive: anyone can report a listing, complaints reach the operator, and the operator can take work down or suspend an account. This capability defines that loop and the admin tools behind it.

## ADDED Requirements

### Requirement: Public reporting
The system SHALL provide a report action on every artwork detail page and artist profile, available to any visitor whether signed in or not. A report SHALL require a reason from a fixed set — not original work, mass-produced item, undeclared AI generation, offensive content, misleading listing, other — and SHALL accept optional free text.

#### Scenario: Anonymous visitor reports an artwork
- **WHEN** an anonymous visitor submits a report with a reason
- **THEN** the system records the report against that artwork and confirms receipt

#### Scenario: Report without a reason
- **WHEN** a visitor attempts to submit a report with no reason selected
- **THEN** the system rejects the submission

#### Scenario: Repeated reports on one artwork
- **WHEN** several reports are filed against the same artwork
- **THEN** the system groups them into a single admin queue item showing the report count

#### Scenario: Report flooding is refused
- **WHEN** a client files reports beyond the configured rate limit
- **THEN** further reports are refused, and the report count already recorded is not inflated by the refused attempts

### Requirement: Operator notification
The system SHALL notify the operator by email at the configured PACHKA address whenever a new report is filed, and SHALL include the artwork, the reason, and a direct link to the admin queue item.

#### Scenario: New report notification
- **WHEN** a report is filed
- **THEN** an email is sent to the configured operator address with the artwork, reason, and a link to the queue item

#### Scenario: Notification delivery fails
- **WHEN** the notification email cannot be sent
- **THEN** the report is still recorded in the admin queue and the failure is logged

### Requirement: Admin queue
The system SHALL provide an admin-only queue listing open reports and uploads flagged by the automated pipeline, sorted by recency, each showing the subject, reason, report count, and current status. Each item SHALL be resolvable as dismissed or actioned, with a recorded operator note.

#### Scenario: Admin dismisses a report
- **WHEN** an admin dismisses a queue item with a note
- **THEN** the item closes, the artwork is unaffected, and the note and acting admin are recorded

#### Scenario: Non-admin attempts access
- **WHEN** an account without the admin role requests the admin queue
- **THEN** the system returns a not-found response

#### Scenario: Pipeline-flagged upload appears
- **WHEN** an upload is flagged because safety screening was unavailable
- **THEN** it appears in the admin queue for review

### Requirement: Artwork takedown
An admin SHALL be able to move any artwork to `removed`, which SHALL immediately withdraw it from the catalog, the matchmaker, and the artist's ability to republish. The artist SHALL be notified with the reason. Takedown SHALL NOT affect orders already placed for that artwork.

#### Scenario: Admin removes an artwork
- **WHEN** an admin removes an artwork with a stated reason
- **THEN** the artwork disappears from all public surfaces, the artist is notified with the reason, and the artist cannot republish it

#### Scenario: Artwork with an in-flight order
- **WHEN** an admin removes an artwork that has a paid but undelivered order
- **THEN** the existing order continues through its lifecycle unaffected

### Requirement: Account suspension
An admin SHALL be able to suspend an account. A suspended artist's published artworks SHALL be withdrawn from public surfaces, and the account SHALL be unable to sign in, publish, or place orders. Suspension SHALL be reversible by an admin, and SHALL be recorded with a reason, acting admin, and timestamp.

#### Scenario: Artist suspended
- **WHEN** an admin suspends an artist account
- **THEN** all of that artist's published artworks are withdrawn from public surfaces and the account cannot sign in

#### Scenario: Suspension lifted
- **WHEN** an admin lifts a suspension
- **THEN** the account regains access and its previously published artworks return to published state, excluding any individually removed

#### Scenario: Suspension with outstanding payouts
- **WHEN** an artist with eligible unsettled payouts is suspended
- **THEN** the ledger entries are retained and flagged for operator decision rather than cancelled

### Requirement: Admin actions are auditable
The system SHALL record every admin action — takedown, suspension, report resolution, commission change, rate table change, and payout settlement — with the acting account, timestamp, target, and any note. The audit record SHALL be append-only, enforced in the database by revoked update and delete grants and a trigger, not by application convention alone. Each entry SHALL be written in the same transaction as the action it records, so an action cannot succeed without its audit row. Entries SHALL be chained by a hash of the preceding entry, so that tampering by anything holding database credentials — including the application itself — is detectable.

#### Scenario: Action recorded
- **WHEN** an admin performs any of the recorded actions
- **THEN** an append-only audit entry is written with actor, timestamp, target, and note

#### Scenario: Audit entry cannot be altered
- **WHEN** any actor attempts to modify or delete an audit entry
- **THEN** the database rejects the attempt

#### Scenario: Action and audit row are atomic
- **WHEN** writing the audit row fails
- **THEN** the admin action it records is rolled back and does not take effect

#### Scenario: Tampering is detectable
- **WHEN** an audit entry is altered directly in the database
- **THEN** verifying the hash chain reports the break
