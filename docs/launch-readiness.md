# Launch readiness

What must be true before PACHKA takes a real payment, and what an RTL and
responsive walk of every route actually found.

Audited 2026-09-05 against `feat/pachka-mvp`, on a local dev server with an
**empty catalog** — see "Not audited" at the end, because that limitation
matters for reading the RTL section.

---

## 1. RTL and responsive audit

### Method

Every public route was loaded at 320, 375, 768 and 1440 CSS pixels and measured
programmatically rather than eyeballed: document `scrollWidth` against
`clientWidth`, every element's box against the viewport, every interactive
element's rendered size, and — for the bidi findings — the actual on-screen x
coordinates of individual numerals via `Range.getBoundingClientRect()`.

Routes walked: `/`, `/catalog`, `/artists`, `/match`, `/become-an-artist`,
`/terms`, `/privacy`, `/returns`, `/sign-in`, `/register`, `/checkout`.

The ESLint rule `local/no-physical-direction` already fails the build on `ml-`,
`pr-`, `text-left`, `border-r` and friends, so this audit deliberately looked
for what that rule cannot see: overflow, wrapping, tap targets, and numerals
running the wrong way inside Hebrew.

### Blocking

**B1 — every page in the product scrolls sideways on a phone.**
`src/shared/ui/SiteHeader.tsx`

The header lays out a 152px logo and a 231px nav with `justify-between` inside
`px-6` (48px) padding. That needs 431px. It has no mobile treatment at all — no
hamburger, no wrap, no horizontal scroll container — so the document simply
refuses to be narrower than 407px:

| Width | Document scrollWidth | Overflow |
|---|---|---|
| 320 | 407 | **87px** |
| 375 | 407 | **32px** |
| 768 | 768 | 0 |
| 1440 | 1440 | 0 |

The 32px overflow was identical on all eleven routes, and no individual element
anywhere was wider than the viewport — which together point at a single shared
cause in the shell rather than eleven page bugs. A control experiment confirms
it: setting `display: none` on the `<header>` alone, changing nothing else,
drops `scrollWidth` from 407 to exactly 375 and the overflow to zero. The
visible symptom is that the logo is pushed off the screen edge and the whole
page rubber-bands horizontally. Tablet and desktop are clean everywhere.

**B2 — a buyer has no way to exercise the 14-day cancellation right.**
`src/modules/shipping/returns.ts`

`requestReturn` is implemented, exported from the module's public API, and
covered by integration tests — and called by no route and no component. A
repository-wide search finds callers only in `tests/`. `shipping-and-returns`
requires that "The request SHALL be made through the platform", and
`/orders/[orderId]` renders no control for it. The statutory right currently has
no user-facing path.

**B3 — the PACHKA return address is a placeholder.**
`src/shared/config/registry.ts`

`returns.address` ships as `line1: "PLACEHOLDER PO BOX"`. Return instructions
are generated from this value, so no return can physically be made until an
operator sets it. It is also the reason `/returns` tells the reader the address
is issued with the return confirmation rather than printing it.

### Serious

**S1 — the studio dashboard shows an artist their stock backwards.**
`src/app/studio/StudioDashboard.tsx:103-105`

```
<span className="numeric">
  {listing.availableUnits} / {listing.stock}
</span>
```

`.numeric` sets `direction: ltr; unicode-bidi: isolate`. Applied to a *single*
numeral that is correct and necessary. Applied to a *composite* expression it
reverses the operands. Measured x coordinates for "2 / 5" in an RTL line:

| Rendering | x of "2" | x of "5" | Hebrew reader reads |
|---|---|---|---|
| No wrapper | 325 | 301 | **2 / 5** — correct |
| Whole expression wrapped (as shipped) | 301 | 325 | **5 / 2** — reversed |
| Each numeral wrapped separately | 325 | 301 | **2 / 5** — correct |

So an artist with 2 of 5 units left reads "5 / 2". The fix is to wrap each
numeral, not the pair.

**S2 — the `.numeric` convention as documented invites exactly that bug.**
`src/app/globals.css`

The utility's comment says "Wrap any rendered number/price in this." That
instruction is right for a lone numeral and wrong for any string containing a
separator. The same measurement on `dimensionsFormatted` ("100 × 70 ס״מ"):
unwrapped it reads correctly as 100 × 70; wrapped whole it reads 70 × 100. The
comment should say "wrap each numeral, never an expression containing one", and
`dimensionsFormatted` / `weightFormatted` must never be wrapped wholesale.

Note this cuts against the intuitive reading of the audit: several price render
sites (`ArtworkCard.tsx:57`, `ArtworkDetailView.tsx:328`, `BuyerOrderView.tsx`,
`ArtistFulfilmentView.tsx`) omit `.numeric` — and that omission is **harmless**,
because `₪` plus digits already resolves LTR under the Unicode bidi algorithm.
`.numeric` buys tabular alignment there, not correctness. The real defect is the
opposite one: applying it where it does not belong.

**S3 — email, password and number fields inherit `direction: rtl`.**
`(accounts)/sign-in/SignInForm.tsx`, `register/RegisterForm.tsx`,
`reset-password/ResetPasswordForm.tsx`, `matchmaker/ui/NotifyMeForm.tsx`,
`matchmaker/ui/QuestionnaireForm.tsx` (budget and wall dimensions),
`checkout/CheckoutForm.tsx` (`type="tel"`)

Every one of these computed to `direction: rtl` with no `dir` attribute. An
email address, a phone number and a price are LTR content; typed into an RTL
field the caret jumps and punctuation lands on the wrong side. These want
`dir="ltr"` with `text-align: start` so the field still aligns to the Hebrew
side of the form while its content runs left to right.

**S4 — the pre-purchase return terms never disclose the outbound-shipping
decision.** `src/modules/shipping/terms.ts`

`returns.refund_includes_outbound_shipping` exists in config and is applied by
the refund calculation, but `ReturnTerms` carries no field for it and none of
the six statements mentions it. So the artwork page and the checkout summary
tell a buyer who pays for the return leg, and stay silent on whether the leg
they already paid for comes back. `/returns` reads the config key directly to
say it; the panel cannot.

### Minor

**M1 — footer tap targets were under the WCAG minimum. Fixed.**
`src/shared/ui/SiteFooter.tsx`

Measured 20px tall and 28px wide for "תקנון" — under the 24×24 CSS-pixel floor
of WCAG 2.2 2.5.8, on the only route to the three legal documents, present on
every page. Now 36×36 via `py-2 px-1`, with `-my-2` on the nav so the footer
keeps the height the mockup draws. This was inside the boundary, so it is done
rather than reported.

**M2 — header nav links are 23px tall**, 1px under the same threshold.
`src/shared/ui/SiteHeader.tsx`. Worth fixing in the same pass as B1.

**M3 — "שכחתם סיסמה?" is a 1184px-wide link.**
`src/app/(accounts)/sign-in/SignInForm.tsx` — a bare `<a>` in a flex column
stretches full width, so the entire line is a click target including the
whitespace beside the text. Wants `self-start` or `inline-flex`.

### Checked and clean

Recording these so the next audit does not repeat them:

- **No unwrapped Latin numerals in Hebrew text.** Zero on all eleven routes
  after excluding Next.js script payloads.
- **No runaway boxes.** No element on any route at any width exceeded the
  viewport; B1 is content pressure in the header, not a broken box.
- **Contrast passes WCAG AA everywhere.** `ink-muted` on paper 5.10, on card
  5.61; `ink-soft` on paper 10.61; `ink` on paper 16.92; `alert` on card 6.42,
  on paper-deep 5.19. All above 4.5.
- **The matchmaker's 13px radios are not a defect.** Each sits inside a 39px
  label, so the effective target is 39×86 or larger. Measured before reporting.
- **768 and 1440 are clean on every route.**

### Not audited

The local database has no published artworks, so these never rendered and the
walk could not reach them: `/artworks/[artworkId]`, `/artists/[artistId]`,
`/orders/[orderId]`, `/certificates/[certificateId]`, `/studio` (redirects when
signed out) and `/admin`. That is exactly where prices, dimensions, edition
strings and totals live — the numerals this audit most wanted to see. They were
reviewed in source instead (which is how S1 and S2 were found), but **the
catalog card, artwork detail and checkout surfaces still need a browser pass
against seeded data.** That is task 12.5's staging seed, and it should be done
before 12.2 is ticked.

---

## 2. Placeholders a lawyer must resolve

35 markers are rendered visibly on the pages themselves — `[לבדיקת עו״ד]` for a
legal question, `[להשלמה על ידי המפעיל]` for a fact the operator holds. **None
of them may be filled in by guessing.** An invented company registration number
is worse than a blank one: the blank is obviously unfinished, and the plausible
number reads as checked.

| Page | Lawyer | Operator |
|---|---|---|
| `/terms` | 9 | 5 |
| `/privacy` | 10 | 4 |
| `/returns` | 4 | 3 |
| **Total** | **23** | **12** |

### The legal questions, by subject

**Identity and standing**
- Registered company name, entity type, and company or *osek* number.
- Whether PACHKA is the "עוסק" facing the consumer, given that it collects the
  price and settles with the artist later — and what that implies for licensing,
  invoicing, VAT and withholding.
- The status of buyer money PACHKA holds between payment and settlement.
- Governing law, jurisdiction, liability and limitation-of-liability clauses —
  none of these has been drafted at all.

**Consumer disclosure**
- The pre-contract disclosures Israeli consumer law requires on the confirmation
  screen and in the written confirmation that follows.
- Delivery times to be shown, and what counts as a delay entitling cancellation.
- Who bears loss or damage on the outbound leg (there is no breakage insurance).

**Returns**
- **The cancellation fee.** `returns.cancellation_fee_rate` currently defaults to
  `0`. `registry.ts` bounds it at 5%, which enforces half the statutory test —
  the law caps the fee at 5% **or ₪100, whichever is lower**, and *the shekel
  cap is not enforced anywhere in the code*. Any artwork over ₪2,000 can
  therefore be configured to a lawful-looking rate that produces an unlawful
  fee. Decide the rate, and enforce the shekel cap.
- Whether outbound shipping is refunded. `returns.refund_includes_outbound_shipping`
  ships `false` and is flagged UNDECIDED in the registry itself.
- **The extended cancellation window.** Israeli law gives a longer period to
  certain groups (people with disabilities, senior citizens, new immigrants).
  The system implements one flat window for everyone and has no notion of
  eligibility. Decide how the longer period is honoured.
- Whether made-to-order artworks fall inside the statutory exemption for goods
  produced specially for the buyer. PACHKA has a `madeToOrder` flag, so this is
  a live question and not a hypothetical.

**Privacy**
- Whether a database registration or a privacy officer is required, and the
  security level that applies, under the Protection of Privacy Law and its
  security regulations.
- Retention periods for every category — none has been decided.
- Named processors, their locations, and whether personal data leaves Israel.
- The identity of the AI vision provider and the terms of processing, including
  whether uploaded images are retained or used for training.
- How an erasure request is reconciled with append-only records — certificates
  are immutable by design, and order transitions and the admin audit log are
  insert-only.
- Breach notification procedure.

**Content**
- The scope and duration of the licence PACHKA takes in artists' images, and
  what happens to it when an artwork is removed or an account closed.

### The facts the operator must supply

Registered postal address · customer-service email · privacy-contact email and
postal address · **the real `returns.address`** · the channel through which a
buyer submits a cancellation request until B2 is built · the payment method and
account details, and what happens to an order left unpaid · how and when refunds
are actually paid, given there is no online settlement · the date each document
was approved.

---

## 3. Launch checklist

### Blocks launch — do not take a real payment until every one is true

1. **A lawyer has read all three documents** and the 23 marked questions are
   answered. Everything else in this section is downstream of it.
2. **The company's legal identity is on the pages** — registered name, number,
   postal address, contact email.
3. **`returns.address` holds a real address.** Until then a return is physically
   impossible (B3).
4. **The cancellation fee is decided, and the ₪100 statutory cap is enforced in
   code**, not only the 5% bound that `registry.ts` applies today.
5. **A buyer can request a return through the platform** (B2). The right exists
   in law and in the module; it has no route.
6. **Payment is resolved.** There is no provider: an order is created
   `awaiting_payment`, instructions go out by email, and an operator marks it
   paid by hand. Either integrate a provider behind the existing adapter
   interface, or make the manual flow explicit, disclosed and rehearsed.
7. **The site does not scroll sideways on a phone** (B1). A storefront that
   rubber-bands horizontally on every page will not be trusted with a card.
8. **Retention periods and a privacy contact are published** in the privacy
   policy.
9. **Error tracking and an uptime check are live** (task 12.4). Nothing reports
   a production failure today.
10. **The end-to-end rehearsal has been run** (task 12.8) — artist signs up,
    uploads, publishes; buyer matches, orders, pays; artist ships; delivery,
    certificate, payout settlement.
11. **The draft banner is removed from the three pages** — last, and only after
    item 1. It is `DraftBanner` in `src/app/(legal)/LegalDocument.tsx`.

### Wants doing before launch

- Fix the reversed stock display (S1) and correct the `.numeric` guidance (S2)
  in the same pass, so the next person does not repeat it.
- Set `dir="ltr"` on email, phone and number fields (S3).
- Add the outbound-shipping disclosure to `ReturnTerms` (S4) so the artwork page
  and checkout say it, not only the policy page.
- Header nav tap targets (M2) and the full-width sign-in link (M3).
- Seed staging and re-run the RTL walk over the artwork, order and certificate
  surfaces this audit could not reach.
- Confirm the matchmaker degrades honestly at low inventory (12.5) — PACHKA
  launches with an empty catalog, so this is the first thing real visitors meet.
- Tune the quality-gate thresholds against real photographs (12.6).
- Measure actual AI cost per upload against the projection (12.7).
- Chase the intermittent unhandled rejection in
  `tests/integration/artworks-publishing.test.ts` ("refuses more styles than the
  cap"). It surfaced on one full `npm run verify` and not on the next, with the
  suite green both times — an assertion racing a promise that settles after the
  test returns. Intermittent is the reason to fix it, not the reason to ignore
  it: it will eventually land on a run that matters.

### After launch

- Paginate the sitemap. It walks at most 50 catalog pages and then silently
  under-reports; fine for launch, not fine at a few thousand artworks.
- Revisit the reviews policy once there is enough volume for one review to
  identify a buyer.
