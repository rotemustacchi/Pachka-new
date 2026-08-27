## Context

Greenfield project, zero existing code, zero artists, zero artworks. See proposal.md — Why.

Three constraints dominate every decision below, and they are not negotiable:

1. **Effectively no budget.** Hosting, database, and storage must fit free tiers. AI cost must scale with the number of *artworks* — a bounded, one-time cost per upload — never with traffic.
2. **One developer, building this as a favour.** Anything that can be a configuration value instead of an integration should be. Fewer moving services is worth more than architectural elegance.
3. **Correctness where money and inventory meet.** A one-of-a-kind artwork sold twice is an unrecoverable failure that destroys trust with both the buyer and the artist. Inventory reservation must be genuinely atomic.

## Goals / Non-Goals

**Goals:**
- A single deployable web application with no separate services to operate
- AI cost bounded and predictable: roughly a fraction of a cent per artwork uploaded, zero per buyer query
- Payment integration deferrable without rework — provider chosen later, dropped in behind an interface
- Atomic inventory reservation under concurrency
- Hebrew RTL as the native layout direction, not a retrofit

**Non-Goals:**
- Horizontal scale. Correctness and cost matter; throughput does not yet.
- Real-time features. No live updates, no presence, no websockets.
- Search relevance tuning beyond the scoring function specified in `art-matchmaker`.
- Multi-tenancy, white-labelling, or an artist-facing API.

## Decisions

### Postgres over Firebase — overriding the PRD

The PRD specifies Firebase with Firestore collections. This design uses **Supabase (Postgres, Auth, Storage)** instead. Reasons, in order of weight:

- **Atomic reservation.** Reserving a unique artwork is a transactional problem. Postgres gives it directly with `SELECT ... FOR UPDATE` inside a transaction, or a unique partial index on active reservations. Firestore requires transaction retries around documents that were not designed as a locking primitive, and the failure mode is a double sale.
- **Vector search for free.** `pgvector` lives in the same database as the artworks. Firestore has no native vector similarity, which would mean a second service and a second bill.
- **Relational data.** Orders, fulfilments, ledger entries, and audit records are relational with real integrity constraints. Modelling an append-only financial ledger in a document store invites the exact inconsistency it exists to prevent.
- **Cost parity.** Firebase's free Spark plan forbids outbound network calls from Cloud Functions, which the AI pipeline requires — so Firebase would need the paid Blaze plan anyway.

*Alternative considered:* Firebase as specified. Rejected on the reservation-correctness argument alone; the rest reinforces it. **This is a deliberate override of the PRD and should be confirmed.**

*Alternative considered:* Postgres on Neon plus a separate auth provider. Rejected — more services to wire and operate for one developer, with no offsetting benefit.

### Stack

Next.js (App Router) with TypeScript, deployed on Vercel's free tier; Supabase for database, auth, and object storage. Server Actions and Route Handlers for mutations, so there is no separate API service. Tailwind CSS with logical properties throughout, so RTL is the default rather than a mirror pass.

### AI: one vision call per upload, zero calls per query

This is the decision that keeps the project affordable.

**At upload (bounded cost, once per artwork):**
1. Local technical checks first, before any spend — dimensions, file size, and blur via Laplacian variance using `sharp`. A rejected image never reaches a paid API.
2. One **Claude Haiku 4.5** vision call per accepted image returning structured JSON: taxonomy suggestions (medium, style, space, mood), dominant colours, a safety verdict, and a rich natural-language description of the work. Tagging and safety screening share the single call rather than costing two.
3. One embedding call over that description plus the taxonomy values, stored in a `pgvector` column.

Roughly **$0.002 per artwork**. A thousand artworks costs about two dollars, once.

**At query (zero marginal cost):** The buyer's questionnaire answers are composed into a query vector and ranked against stored embeddings with a cosine-similarity query in Postgres, blended with taxonomy overlap, budget proximity, and size fit. No outbound API call is made when a buyer searches.

*Alternative considered:* An LLM call per matchmaker query, as the PRD implies. Rejected outright — cost scales with traffic, which is precisely the risk this project cannot carry, and results become non-reproducible, which makes the ranking untestable.

*Alternative considered:* Google Vision for tagging, as the PRD specifies. Rejected — Vision returns generic labels and colours. It will not return "Boho & Coastal" or "edgy", which are the axes the matchmaker actually ranks on. A vision-language model returns the taxonomy directly.

### Scoring function

A weighted sum, with every weight a configuration value:

```
score = w_embed · cosine(query_vec, artwork_vec)
      + w_tax   · taxonomy_overlap(answers, artwork)
      + w_budget· budget_proximity(budget, price)
      + w_size  · size_fit(wall_dimensions, artwork_dimensions)
      + w_fresh · recency_boost(published_at)
```

Deterministic, inspectable, and tunable without a deployment. Exposure rotation (see `art-matchmaker`) is applied after scoring: artworks within the tie tolerance are ordered by ascending lifetime impressions, which spreads visibility across the community without displacing a genuinely stronger match.

*Alternative considered:* Pure vector similarity. Rejected — it cannot express a hard constraint like "this will not fit the wall" or a soft one like budget.

### Payment abstraction

A single `PaymentProvider` interface with `authorize`, `capture`, `refund`, and `getStatus`. This change ships exactly one implementation, `ManualPaymentProvider`, which records a payment as pending settlement and exposes an operator action to mark it received. Every other module — cart, checkout, orders, payouts — depends only on the interface.

The consequence to be explicit about: with the manual adapter, **PACHKA holds the buyer's money**, which makes the platform the seller of record for VAT and receipts. That is a legal and accounting obligation, not a technical one, and it is tracked as an open risk below.

### Inventory reservation

Reservation rows carry artwork id, quantity, buyer, and an expiry timestamp, created inside a transaction that locks the artwork row. A background sweep releases expired reservations. Available quantity is always derived — stock minus active reservations minus sold — never stored as a mutable counter, because a counter is what drifts.

### Images and storage

Two derivatives per upload: a display image capped at 1600px on the long edge and compressed to roughly 300KB, and a thumbnail. The original is retained but never served publicly. **No watermark** — a deliberate reversal of the PRD, on the grounds that in an art marketplace the image is the product and a logo across it costs sales.

Free-tier storage is the binding constraint here: 1GB holds roughly 3,000 display images. That is comfortably beyond MVP needs but will need a paid tier before it becomes a real catalog.

## Design System

Derived from the brand assets: black brush ink on textured paper, monochrome throughout. This is the correct instinct for an art marketplace — the interface is a gallery wall, and **every colour on the page comes from the artwork itself.**

**Positioning is resolved in favour of the PRD.** The headline is **"Your Personal Art Curator"** — the buyer-facing promise of AI-matched art. The brand assets' "THE ARTIST'S PLATFORM & BRANDING" is demoted to a secondary, artist-facing line used on artist onboarding and recruitment surfaces only; it SHALL NOT appear on the homepage or in the primary logo lockup. The established year reads **2026**, not 2024.

**Homepage structure is decided:** a classic landing — hero with one featured work, a featured-artworks strip, three how-it-works steps, and an artist call to action at the foot. The matchmaker questionnaire is reached from the hero's primary action rather than occupying the first screen. The artist-facing line appears only in that closing artist section.

The palette and typography below are final and are the values to build against.

**Palette**

| Token | Value | Use |
|---|---|---|
| `--paper` | `#F5F2EA` | Page background, warm off-white |
| `--paper-deep` | `#EAE5D9` | Secondary surfaces, inset panels |
| `--card` | `#FFFDF8` | Elevated cards |
| `--ink` | `#14100D` | Primary text, brush elements |
| `--ink-soft` | `#3D3630` | Secondary text |
| `--ink-muted` | `#6E655C` | Metadata, captions |
| `--rule` | `#D8D1C3` | Borders, dividers |
| `--alert` | `#A33B2A` | Errors — muted brick, not signal red |
| `--affirm` | `#4A6247` | Confirmations — muted olive |

The two status colours are deliberately desaturated so they never compete with the artwork.

**Typography**

- **Logo and wordmark:** the brush lettering, shipped as SVG assets. Never a webfont, never used for running text, never used in Hebrew — the brush script has no Hebrew glyphs.
- **Hebrew and Latin UI:** **Heebo** — geometric, excellent Hebrew coverage, matches the sans in the brand assets, free on Google Fonts.
- **Caps accent:** **Archivo** in heavy weight for the condensed all-caps treatment seen on the brand banner.
- Numerals and prices always Latin, always LTR, even inside RTL text.

**The brush stroke as a UI motif.** The black brush bar behind "CREATIVITY. COMMUNITY. COMMERCE." in the brand assets is the recurring device: section headings, the active state in navigation, and the primary button. Delivered as a small set of SVG stroke assets rather than an image texture, so it stays crisp and cheap.

**Paper texture** as a subtle tiled background at low opacity, one small asset, no per-element texture.

**RTL** is the document default. Layout uses logical properties (`margin-inline-start`, not `margin-left`) so there is no separate mirrored stylesheet.

## Risks / Trade-offs

- **PACHKA holds buyer funds and becomes seller of record** → An accountant must confirm the VAT and receipt obligations, and how to lawfully pay artists who have no registered business, before the first real transaction. This is the single risk most likely to stop the project, and it is legal, not technical.
- **Cold start: zero artists** → The matchmaker is worthless without inventory, and `art-matchmaker` specifies honest degradation rather than a broken-looking empty state. But no code fixes this — artist recruitment is the real first task.
- **Reactive moderation lets bad listings go live** → A mass-produced item will appear on the site and come down only after someone reports it. Accepted deliberately for a low-volume MVP; revisit before any growth push.
- **No buyer-to-artist channel** → Some sales will be lost to unanswered questions. Mitigated by making the specification fields mandatory and detailed; internal chat is already scoped as the first post-MVP addition.
- **Free-tier limits** → Supabase pauses inactive free projects after seven days, and 1GB of storage caps the catalog around 3,000 images. Both are acceptable for MVP and both need a paid tier before launch traffic.
- **Payout at delivery plus fourteen days is supply-hostile** → Artists wait roughly three to four weeks after shipping. This is the choice most likely to cost artists at exactly the moment there are none to lose. Worth revisiting once trust exists.
- **Single vision provider** → An outage blocks tagging. Mitigated: `upload-pipeline` requires the upload to proceed with a manual classification form when analysis fails.
- **Brand override on watermarks and on Firebase** → Both reverse explicit PRD instructions. Documented here so the reversal is visible and can be rejected.
- **Brand assets need correction before use** → The supplied mockups carry invalid hex values (`#AT3000`, `#F0000`) and read "SINCE 2024". The palette table above supersedes the former; the year is corrected to 2026. The logo and wordmark must be re-exported as clean SVG — the supplied files are raster mockups on a paper background and cannot be used as-is.

## Migration Plan

Greenfield; nothing to migrate. Deployment is phased so the artist side can be exercised before the buyer side exists:

1. Schema, auth, and roles.
2. Artist upload and the AI pipeline — validated against real photographs from real artists, since the quality gate thresholds cannot be tuned in the abstract.
3. Catalog and artwork pages.
4. Matchmaker.
5. Cart, checkout with the manual adapter, and the order lifecycle.
6. Payouts, certificates, and the admin panel.

Rollback is a Vercel deployment revert; database migrations are forward-only and additive within the MVP.

## Open Questions

- **Commission percentage.** Defaulted to 15% and held in configuration, so the number can be set at any time without code. Does not block implementation.
- **Payment provider.** Deferred by design; the interface exists so the choice can be made after launch. Israeli options (משולם, Cardcom, Tranzila) carry monthly fees; Stripe does not but requires a registered business.
- **Shipping zone definitions and rate table values.** The mechanism is specified; the numbers are configuration and can be filled in before launch.
