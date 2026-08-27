## Why

Israeli independent artists and makers currently sell through Instagram DMs and manual payment transfers: no catalog, no discovery, no purchase record, and no way for a buyer to find work that actually fits their home. Buyers who want original art face the opposite problem — general marketplaces bury them in undifferentiated inventory with no help deciding what suits their space.

PACHKA is a curated, Israel-only art and design marketplace whose distinguishing feature is an AI matchmaker: the buyer describes their style, space, and budget, and the platform ranks the community's work against that. This change defines the MVP — the smallest product that lets an artist list work and a buyer complete a purchase.

**Starting position: zero artists and zero artworks.** The MVP is therefore weighted toward the artist side. Without supply there is no product, so artist signup, upload, and listing quality are the critical path; the buyer experience is built alongside but has no value until inventory exists.

## What Changes

**Buyer-facing**
- Public catalog of published artworks with filtering by medium, style, target space, mood, and price. Browsable without an account.
- Artwork detail pages with full specifications (dimensions, weight, materials, lead time) — these substitute for buyer↔artist questions, which are out of MVP scope.
- AI matchmaker: a short questionnaire (style, palette, budget, wall size, mood) returning ranked matches. When the catalog is sparse it returns fewer results and says so plainly, rather than padding with bad matches.
- Public artist profiles showing name, photo, story, portfolio, and reviews — but never phone, email, or social handles.
- Cart, checkout, and order tracking. Payment runs through an internal abstraction with **no provider wired in this change**; the provider is selected later and implemented behind that interface.

**Artist-facing**
- Open self-service signup. No pre-approval, no human gatekeeping before publish.
- Artwork upload with an automated pipeline: technical quality gate (minimum resolution, blur detection), safety screening, AI-generated tags (medium, style, dominant colors, mood), and a stored embedding used by the matchmaker. The artist reviews and can override every AI-assigned tag.
- Support for both one-of-a-kind pieces (quantity 1, hard-reserved at checkout) and editions/multiples with stock and lead time.
- Mandatory originality declaration and AI-assisted-artwork disclosure at upload.
- Artist dashboard: listings, orders, and payout status.

**Platform operations**
- Order lifecycle through to delivery, with a 14-day return window per Israeli distance-selling law.
- Commission held as a configuration value (default 15%) applied at order time. Artist payout becomes eligible only after delivery + 14 days, and is recorded as a manual bank transfer by the operator — there is no automated split-payment integration.
- Automatic digital Certificate of Authenticity generated per completed sale, stating explicitly that it records the artist's own declaration and is not platform verification.
- Admin panel: complaint queue fed by a public report button, plus artwork takedown and user suspension. Moderation is **reactive**, applied after publication.

## Non-goals (explicitly deferred)

Deferred to later changes, not dropped: AR wall visualizer; swipe-based taste onboarding; internal buyer↔artist chat; buyer questions on listings; image watermarking; carrier API integration for live shipping rates; automated split payments; custom commission flows; built-in breakage insurance; B2B/interior-designer accounts; multi-language and multi-currency.

## Capabilities

### New Capabilities
- `accounts-and-profiles`: Authentication, buyer/artist/admin roles, and the public artist profile — including the rule that contact details are never exposed.
- `artwork-listings`: Artwork creation, the taxonomy (medium/style/space/mood), required specification fields, inventory for unique pieces and editions, originality and AI-disclosure declarations, and the draft→published→removed lifecycle.
- `upload-pipeline`: The automated gate on every image — technical quality checks, safety screening, AI tag suggestion, and embedding generation, with artist override.
- `catalog-browse`: Public catalog, filtering, sorting, and the artwork detail page.
- `art-matchmaker`: The buyer questionnaire, the ranking method, result presentation, and honest behavior when the catalog is sparse.
- `checkout-orders`: Cart, inventory reservation, checkout, the payment provider abstraction, and the order state machine.
- `shipping-and-returns`: Flat-rate shipping tiers by zone and size, artist-managed fulfilment, packaging requirements for fragile items, and the 14-day return process including who bears cost and risk.
- `artist-payouts`: Commission calculation, payout eligibility timing, the payout ledger, and manual settlement recording.
- `authenticity-certificate`: Generation, content, and delivery of the certificate, plus the limits of what it asserts.
- `moderation-admin`: Public reporting, the admin complaint queue, takedown, and suspension.

### Modified Capabilities
None — this is a greenfield project with no existing specs.

## Impact

- **Greenfield.** No existing code; this change establishes the entire codebase, data model, and deployment.
- **Cost constraint is a hard design driver.** The project has effectively no budget. AI cost must scale with the number of artworks (a bounded, one-time cost per upload), never with traffic. This rules out an LLM call per matchmaker query and forces precomputed embeddings with local similarity ranking. Hosting and storage must fit free tiers.
- **Legal exposure.** Collecting buyer payments centrally makes PACHKA the seller of record for VAT and receipts, and creates an obligation to pay artists who may have no registered business. This needs an accountant's answer before the first real transaction and is tracked as an open risk, not resolved here.
- **Regulatory.** Israeli consumer protection law (עסקת מכר מרחוק) governs the return window and cancellation fees. Hebrew RTL is the sole interface language.
- **Cold start.** The matchmaker's usefulness is a direct function of catalog size. The MVP must degrade honestly rather than appear broken at low inventory.
