# `accounts`

Who can use PACHKA, what each role can do, and the public artist profile — in
particular the rule that an artist's contact details never reach a buyer.

Owns: `profiles`, `account_status`, `user_roles`, `artist_profiles`,
`artist_contact_details`, `artist_payout_details`, `reviews`,
`auth_rate_limit_events`, and the `accounts` schema of policy helpers.

Depends on: nothing. It is the only module in ARCHITECTURE.md's table with no
outgoing edges, so where it needs a fact owned by another module it takes a
port and the caller supplies it.

## The one thing to understand first

**RLS cannot hide a column.** Supabase publishes a PostgREST data API at
`/rest/v1/<table>` for every table in `public`, reachable by anyone holding the
anon key — which legitimately ships in the browser bundle. Row-level security is
row-level: a policy permissive enough to serve a public artist profile serves
*every column of that row*, and no PACHKA code runs on that path.
`toPublicArtist()` is not on it.

So the artist is split by who may see what:

| Table | Who can reach it | Holds |
|---|---|---|
| `profiles` | anyone | display name, avatar, city. Nothing else, ever. |
| `artist_profiles` | anyone, if the artist has something published and is not suspended | the artist persona: name, bio, city, photo |
| `account_status` | self, admin | verification and suspension state |
| `artist_contact_details` | **nobody** through the data API | email, phone, address, socials |
| `artist_payout_details` | **nobody** through the data API | bank details |

The last two have `REVOKE ALL ... FROM anon, authenticated`. Postgres checks
grants before policies, so the revoke is the operative control and the
self/admin policies on them are the belt to its braces. They are reachable only
through the privileged server connection.

Tests for this live in `tests/integration/accounts-data-api.test.ts` and go
through `asAnon` / `asUser`, which reproduce what PostgREST does. A test that
goes through `database.db` proves nothing: that connection is the owner and
carries BYPASSRLS.

## Deliberate deviations from SECURITY.md's policy matrix

Both are **stricter** than the matrix, which is why they were taken without
waiting for an answer. Both are flagged for the lead architect.

1. **No INSERT/UPDATE/DELETE policy for `authenticated` on any accounts table.**
   The matrix permits self-writes on `profiles`, `artist_profiles`,
   `artist_contact`, `artist_payout_details` and `reviews`. This module permits
   none: every write goes through the server. A data-API write path would let an
   artist put a phone number in a public biography without the contact scanner
   ever running, and the scanner is the only thing on that path.

2. **`reviews` eligibility is enforced server-side, not in a policy.** The
   matrix says INSERT is "self, and only with a `delivered` order from that
   artist". That predicate spans the orders module's tables; putting it in an
   RLS policy would put orders' schema inside accounts' policies, on a path
   anonymous visitors hit on every profile page. `authenticated` therefore gets
   no write path at all.

## Naming note

ARCHITECTURE.md's ownership map and SECURITY.md's RLS matrix disagree on one
name: the map says `artist_contact_details`, the matrix says `artist_contact`.
This module uses `artist_contact_details`, following the ownership map. Reported.

## Cross-module contracts

`accounts` reads two things it does not own. Both resolve the table at call time
and **fail closed** while it is absent — which is not a placeholder but the
correct answer, since with no artworks in the system no artist has a published
artwork and the spec's "no published artworks → not-found" already applies.

### `artworks` — for artist-profile visibility

`accounts.artist_has_published_artwork(uuid)` reads:

```
public.artworks (artist_id uuid, status text)   -- visible when status = 'published'
```

If those column names change, artist profiles silently become 404s. The test
that says so is *"reports an artist with a published artwork as publicly
visible"* in `tests/integration/accounts-artist.test.ts`, which runs against the
real table via `tests/support/accounts-artwork-fixture.ts`.

### `orders` / `fulfilments` — for review eligibility

`sqlOrderEligibility` reads:

```
public.orders      (id uuid, buyer_id uuid, status text)  -- eligible when status = 'delivered'
public.fulfilments (order_id uuid, artist_id uuid)
```

**Open question for the orders team.** `checkout-orders` puts `delivered` on the
*order*, but also requires that a multi-artist order splits into fulfilments
that ship independently. This implementation keys eligibility on the order's
status. If a fulfilment carries its own status, this predicate should move to
it. Raised with the lead architect.

## Things other modules call

- `assertEmailVerified(db, userId, "publish" | "order")` — the gate. `artworks`
  and `orders` call this rather than reading `account_status`.
- `scanForContactDetails(text)` / `explainFindings(findings)` — the single
  shared scanner. Every module accepting free text bound for a public surface
  calls this one: artwork title, description, materials, review text, and the
  AI-generated description before it is stored.
- `toPublicArtist(row)` — the only shaping function for artist data in a
  buyer-facing response. Second line of defence; see above for the first.
- `suspendAccount(deps, userId, reason)` / `reinstateAccount(...)` — moderation
  owns the decision, accounts owns the enforcement predicate.
- `withdrawReviewsForReturnedOrder(db, orderId)` — shipping calls this when a
  return completes. Reviews are hidden, never deleted (SECURITY.md S2-24 item 4).

## The contact scanner is a deterrent, not a boundary

Written at length at the top of `contact-scanner.ts`, and repeated here because
it decides how much weight other code may put on it: an artist determined to
publish their phone number will paint it into the photograph. What actually
keeps transactions on the platform is that there is no buyer-to-artist messaging
channel and PACHKA holds the money. Nothing may depend on the scanner alone.

## Known gap in `shared/errors`

Rate-limit rejections are thrown as `conflict`, which maps to HTTP 409 where 429
is right. The taxonomy has no `rate_limited` kind and `shared/errors` belongs to
the foundation, so this module did not add one. Reported.
