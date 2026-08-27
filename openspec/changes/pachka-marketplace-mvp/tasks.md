## 1. Foundation

- [x] 1.1 Initialise the Next.js App Router project with TypeScript, Tailwind, and ESLint
- [ ] 1.2 Set the document to `dir="rtl"` and `lang="he"`, and configure Tailwind to use logical properties throughout
- [x] 1.3 Create the Supabase project and wire local development, staging, and production environment configuration
- [ ] 1.4 Define the design tokens from design.md as CSS custom properties, and load Heebo and Archivo
- [ ] 1.5 Build the base layout: header with logo, navigation, footer, and the paper-texture background
- [ ] 1.6 Build the shared UI primitives — button with the brush-stroke primary variant, input, select, card, badge, modal, toast
- [ ] 1.7 Add the brush-stroke SVG assets and the section-heading component that uses them
- [x] 1.8 Set up the database migration tooling and the forward-only migration convention

## 2. Accounts and Profiles

- [ ] 2.1 Create the `accounts`, `roles`, and `artist_profiles` tables with row-level security policies
- [ ] 2.2 Implement registration, sign-in, sign-out, and password reset via Supabase Auth
- [ ] 2.3 Implement email verification, and gate publishing and ordering on a verified address
- [ ] 2.4 Build the buyer-to-artist upgrade flow that collects display name, bio, photo, and city
- [ ] 2.5 Implement the contact-detail scanner that rejects emails, phone numbers, and social handles in artist free-text fields
- [ ] 2.6 Build the public artist profile page, returning not-found when the artist has no published artworks
- [ ] 2.7 Add a serialisation layer that strips artist contact details from every buyer-facing API response, with a test asserting this
- [ ] 2.8 Create the `reviews` table and implement one-review-per-completed-order with edit support
- [ ] 2.9 Render reviews and the aggregate rating on the artist profile

## 3. Artwork Listings

- [ ] 3.1 Create the `artworks` table with taxonomy columns, specification fields, inventory columns, and the lifecycle state column
- [ ] 3.2 Define the taxonomy as a server-side closed set and reject any value outside it
- [ ] 3.3 Build the multi-step artwork creation form covering images, classification, specifications, and declarations
- [ ] 3.4 Enforce every mandatory specification field at publish time, listing all missing fields at once
- [ ] 3.5 Implement the unique-versus-edition inventory model with quantity, made-to-order flag, and lead time
- [ ] 3.6 Implement the originality declaration, recording account and timestamp
- [ ] 3.7 Implement the AI-assistance declaration and the label it produces on cards and detail pages
- [ ] 3.8 Implement the lifecycle state machine, including the rule that a removed artwork cannot be republished by its artist
- [ ] 3.9 Block unlisting an artwork that is reserved by an in-progress order
- [ ] 3.10 Build the artist dashboard listing view with state, price, stock, and match impressions

## 4. Upload Pipeline

- [ ] 4.1 Implement image upload to Supabase Storage with server-side type and size validation
- [ ] 4.2 Implement the local technical gate — minimum resolution, minimum file size, and Laplacian-variance blur detection via `sharp` — before any paid API call
- [ ] 4.3 Make the quality thresholds admin-editable configuration values
- [ ] 4.4 Implement the single Claude Haiku 4.5 vision call returning structured JSON with taxonomy suggestions, dominant colours, safety verdict, and a description
- [ ] 4.5 Block uploads whose safety verdict exceeds the threshold, and record them for admin review
- [ ] 4.6 On analysis failure, allow the upload to proceed with an empty manual classification form; on screening-service failure, allow it and flag for admin review
- [ ] 4.7 Pre-fill the classification form from the suggestions and record per-field whether the stored value was AI-suggested or artist-set
- [ ] 4.8 Enable `pgvector` and add the embedding column with an appropriate index
- [ ] 4.9 Generate and store the embedding at publish time, recomputing only when the primary image changes
- [ ] 4.10 Exclude artworks with no embedding from matchmaker results while keeping them browsable
- [ ] 4.11 Generate the display derivative and thumbnail, retain the original unserved, and confirm no watermark is applied anywhere

## 5. Catalog and Browse

- [ ] 5.1 Build the catalog page with pagination, showing only published artworks
- [ ] 5.2 Implement filtering by medium, style, space, mood, and price range, combinable across axes
- [ ] 5.3 Implement sorting by newest and by price ascending and descending
- [ ] 5.4 Reflect active filters in the URL so a filtered view is shareable and reloadable
- [ ] 5.5 Build the no-results state offering to clear individual filters, and the empty-catalog state inviting artists to join
- [ ] 5.6 Build the artwork detail page with the image gallery, full specifications, classification, artist link, availability, shipping range, and return terms
- [ ] 5.7 Render sold and unlisted artworks read-only with no purchase action, and return not-found for removed ones

## 6. Matchmaker

- [ ] 6.1 Build the questionnaire flow — at most seven questions, budget required, everything else optional, no account needed
- [ ] 6.2 Compose the buyer's answers into a query vector
- [ ] 6.3 Implement the scoring function combining cosine similarity, taxonomy overlap, budget proximity, size fit, and recency, with configurable weights
- [ ] 6.4 Confirm by test that a query issues no outbound AI API call and that identical answers against an unchanged catalog return identical ordering
- [ ] 6.5 Implement budget as a ranking signal, labelling over-budget results with the difference and excluding those beyond the tolerance
- [ ] 6.6 Return fewer results rather than padding, and never return an artwork below the minimum score
- [ ] 6.7 Build the sparse-catalog message shown below the threshold, and the honest no-matches state
- [ ] 6.8 Build the escape hatch — revise answers, open the pre-filtered catalog, or request notification
- [ ] 6.9 Implement the notify-me capture storing answers with the email address
- [ ] 6.10 Implement exposure rotation within the tie tolerance, ordered by ascending lifetime impressions
- [ ] 6.11 Record match impressions per artwork and surface the count to artists and admins

## 7. Cart, Checkout, and Orders

- [ ] 7.1 Implement the cart with availability and price revalidation on every view, flagging changed and unavailable lines
- [ ] 7.2 Create the `reservations` table and implement atomic reservation inside a transaction that locks the artwork row
- [ ] 7.3 Derive available quantity as stock minus active reservations minus sold, never as a stored counter
- [ ] 7.4 Write a concurrency test proving that two simultaneous checkouts of one unique artwork produce exactly one reservation
- [ ] 7.5 Implement reservation expiry and the background sweep that releases lapsed holds
- [ ] 7.6 Build checkout: delivery details, full cost breakdown in ILS before confirmation, and validation of required fields
- [ ] 7.7 Define the `PaymentProvider` interface with authorize, capture, refund, and getStatus
- [ ] 7.8 Implement `ManualPaymentProvider` and the operator action that marks an awaiting-payment order paid
- [ ] 7.9 Create the `orders`, `fulfilments`, and `order_transitions` tables
- [ ] 7.10 Implement the order state machine, rejecting invalid transitions and recording actor and timestamp for every change
- [ ] 7.11 Release reserved inventory on cancellation
- [ ] 7.12 Split multi-artist orders into per-artist fulfilments shipped, tracked, and paid out independently
- [ ] 7.13 Enforce order visibility — buyer details to the artist only after `paid` and only for their own fulfilment, artist contact details never to the buyer
- [ ] 7.14 Build the buyer order tracking view and the artist fulfilment view
- [ ] 7.15 Implement the transactional emails for order placed, payment received, shipped, and delivered

## 8. Shipping and Returns

- [ ] 8.1 Create the shipping zone and size-tier rate table as admin-editable configuration
- [ ] 8.2 Implement quoting from the rate table at checkout with no carrier API call
- [ ] 8.3 Mark artworks exceeding the largest tier as requiring a quote and block standard checkout for them
- [ ] 8.4 Charge shipping per fulfilment using the largest applicable tier rather than the sum of tiers
- [ ] 8.5 Block checkout for addresses that map to no configured zone, with a clear message
- [ ] 8.6 Require carrier name and tracking reference to mark a fulfilment shipped, and notify the buyer with it
- [ ] 8.7 Flag fulfilments unshipped beyond lead time plus grace period, notifying artist and admin
- [ ] 8.8 Present mandatory packaging requirements and require confirmation before shipping fragile or ceramic fulfilments
- [ ] 8.9 Implement the 14-day cancellation request, accepting inside the window and declining outside it
- [ ] 8.10 Display return terms — cost and transit risk on the buyer — on the artwork page and at checkout
- [ ] 8.11 Implement return resolution: refund on confirmed intact receipt, admin queue on damage, admin flag when a return never arrives
- [ ] 8.12 Restore inventory only when a return completes with the artwork intact

## 9. Payouts

- [ ] 9.1 Add the commission rate as an admin-editable configuration value defaulting to 15%
- [ ] 9.2 Calculate commission on the item subtotal excluding shipping, and store the effective rate on the order
- [ ] 9.3 Create the append-only `payout_ledger` table
- [ ] 9.4 Create a ledger entry when a fulfilment reaches paid
- [ ] 9.5 Implement eligibility at delivered plus 14 days with no return request, holding payouts under an open return
- [ ] 9.6 Show artists their pending, eligible, and settled totals with the underlying entries and exact eligibility dates
- [ ] 9.7 Collect artist bank details, prompt after the first paid fulfilment, and keep them out of every buyer-facing surface
- [ ] 9.8 Build the admin payable queue listing eligible unsettled payouts
- [ ] 9.9 Implement manual settlement recording date and transfer reference, blocking ineligible payouts and those without bank details
- [ ] 9.10 Implement corrections as appended adjusting entries rather than edits

## 10. Certificates

- [ ] 10.1 Create the `certificates` table with a unique public identifier
- [ ] 10.2 Generate one certificate per artwork unit when a fulfilment reaches delivered, and withhold it before that
- [ ] 10.3 Render the certificate with title, artist, medium, dimensions, year, edition position, buyer name, sale date, identifier, and image
- [ ] 10.4 Include the disclaimer that contents are the artist's declaration and are unverified by PACHKA, plus the AI-assistance statement where declared
- [ ] 10.5 Build the public verification page, showing void when the underlying sale is reversed and not-found for unknown identifiers
- [ ] 10.6 Deliver the certificate by emailed link and expose it in the buyer's order view

## 11. Moderation and Admin

- [ ] 11.1 Create the `reports` and `admin_audit` tables
- [ ] 11.2 Add the report action to artwork detail pages and artist profiles, available to anonymous visitors, with a required reason
- [ ] 11.3 Group repeated reports on one subject into a single queue item with a count
- [ ] 11.4 Send report notifications to the configured operator address, recording the report even when email fails
- [ ] 11.5 Build the admin queue listing open reports and pipeline-flagged uploads, resolvable as dismissed or actioned with a note
- [ ] 11.6 Restrict every admin surface to the admin role, returning not-found otherwise
- [ ] 11.7 Implement artwork takedown that withdraws from all public surfaces, notifies the artist, and leaves in-flight orders unaffected
- [ ] 11.8 Implement account suspension and reinstatement, including handling of outstanding payouts
- [ ] 11.9 Write append-only audit entries for every admin action

## 12. Launch Readiness

- [ ] 12.1 Write the Hebrew terms of service, privacy policy, and return policy pages
- [ ] 12.2 Verify RTL rendering across every page and confirm prices and numerals render LTR
- [ ] 12.3 Verify responsive layout on mobile, tablet, and desktop
- [ ] 12.4 Add error tracking and a basic uptime check
- [ ] 12.5 Seed a staging environment with sample artworks and confirm the matchmaker degrades honestly at low inventory
- [ ] 12.6 Tune the quality-gate thresholds against real photographs supplied by real artists
- [ ] 12.7 Measure actual AI cost per upload and confirm it matches the projection in design.md
- [ ] 12.8 Run an end-to-end rehearsal — artist signs up, uploads, publishes; buyer matches, orders, pays manually; artist ships; delivery, certificate, and payout settlement
