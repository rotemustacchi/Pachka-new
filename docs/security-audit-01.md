# Security audit 01 — implementation against the threat model

**Audited commit:** `9ee9ff1` ("ci: add GitHub Actions pipeline running against a real PostgreSQL"), branch `feat/pachka-mvp`.

**Scope.** Committed code only, read via `git show <sha>:<path>`. The working tree at the time of audit contained uncommitted work from concurrent agents (`src/modules/accounts/{artist,auth-gateway,deps,rate-limit,registration,reviews,serialize,session,verification}.ts`, `db/migrations/20260827T140100_accounts_upgrade_and_limits.sql`, `db/migrations/20260827T140200_create_reviews.sql`, and a modified `src/shared/config/registry.ts`). None of it is audited here.

This audit checks `SECURITY.md` and `ARCHITECTURE.md` against what the code actually does. Comments and commit messages were treated as claims to verify, not as evidence.

---

## Summary

The security-critical work that exists is, with the exceptions below, genuinely well done — and the tests that back it test the right surface, which is the failure I most expected to find and did not. The real problems are not in what was written; they are in **the defaults around it**, in **one untested privilege assumption that only bites in production**, and in **the gap between two halves of the same fix**.

| # | Finding | Severity |
|---|---|---|
| H1 | `auto_expose_new_tables` left at its fail-open default | High |
| H2 | `schema_migrations` has no RLS and is exempted from the invariant test on an environment-dependent claim | High |
| H3 | Production DB role's RLS privileges are an untested assumption; harness runs as superuser | High |
| M4 | `profiles` is `USING (true)` to `anon` — full account enumeration | Medium |
| M5 | Service-role factory shares a barrel with the browser client; no `server-only` | Medium |
| M6 | Money and config no longer speak the same language (float rate vs. basis points) | Medium |
| M7 | No security headers at all | Medium |
| M8 | Email confirmation off; 6-char password floor, no complexity, no CAPTCHA | Medium |
| M9 | Rate limiting: zero implementation, and no `app_config` keys for it | Medium |
| L10 | Contact scanner: five verified evasions | Low |

---

## H1 · `auto_expose_new_tables` is left at its fail-open default

**File:** `supabase/config.toml:19-23`

The setting is present but commented out, with the file's own note explaining the consequence:

> Controls whether new tables, views, sequences and functions created in the `public` schema by `postgres` are reachable through the Data API roles (`anon`, `authenticated`, `service_role`) without explicit GRANTs... Left unset, a fresh project falls back to `true`.

So every table any of the nine remaining modules creates is **published to the internet at `/rest/v1/<table>` the moment it is created**, and stays published unless that migration's author remembers to revoke. The accounts migration did remember — `20260827T140000_create_accounts_identity.sql:379-384` writes six explicit `revoke all` statements. That is exactly the point: the correct outcome currently depends on nine future authors each repeating a six-line ritual, when one config line would make the mistake impossible.

**Attack.** A future migration adds `payments` or `order_shipping_details` and writes an RLS policy but no `revoke`. Grants are auto-granted; the policy is the only control; the policy is row-level, so every column of every row it admits — including a buyer's street address — is served to anyone holding the anon key. This is S0-1 recurring in a table nobody has written yet.

**Fix.**
1. Set `auto_expose_new_tables = false` in `supabase/config.toml`, and change the equivalent setting on the hosted project.
2. Because this also removes the implicit grant to `service_role`, add explicit `grant` statements for it where the service-role client genuinely needs table access. Today `service_role` has **no** grant on any accounts table on plain Postgres and works on hosted Supabase only via this same auto-expose — an environment divergence that will surface as a production-only failure if left alone.

**Test that would prove it fixed.** Extend `tests/integration/schema-invariants.test.ts` with a grant assertion, not just a policy assertion:

```sql
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (has_table_privilege('anon', c.oid, 'SELECT')
       or has_table_privilege('anon', c.oid, 'INSERT')
       or has_table_privilege('anon', c.oid, 'UPDATE')
       or has_table_privilege('anon', c.oid, 'DELETE'))
```

Assert the result is a subset of an explicit, reviewed allowlist (`profiles`, `artist_profiles`, and later the published-catalog tables). A table added without a revoke then fails the suite instead of shipping. Note this test asserts something the existing RLS-invariant tests structurally cannot: **RLS presence and grant absence are different controls, and only the second one hides a column.**

---

## H2 · `schema_migrations` has no RLS, and the invariant test excuses it on a claim that is only true under test

**Files:** `src/shared/db/migrations.ts:70-77`, `tests/integration/schema-invariants.test.ts:36-41`

The migration ledger is created unqualified, so it lands in `public`:

```sql
create table if not exists schema_migrations (
  name        text        primary key,
  checksum    text        not null,
  applied_at  timestamptz not null default now()
)
```

No `enable row level security`, no `revoke`. The schema-invariant test — the test `SECURITY.md` S0-1 asks for, the one described as "what stops the eleventh table from shipping unprotected" — explicitly filters this table out:

```
and c.relname <> 'schema_migrations'
```

on the stated grounds that it "has no grant to anon or authenticated." That claim is true on the plain PostgreSQL the harness builds, and false on a hosted Supabase project under H1's default. The one table the invariant test waives is the one table with RLS disabled entirely.

**Attack.** `GET /rest/v1/schema_migrations?select=*` returns every migration filename and content checksum. Filenames in this repo describe their own contents (`harden_app_config`, `create_accounts_identity`), so this discloses the schema's shape and, more usefully to an attacker, **tells them precisely which security migrations are deployed** — whether the hardening ran, whether the column split landed. Low direct impact; high reconnaissance value; and it demonstrates that H1 is live rather than theoretical.

**Fix.** Create the ledger outside `public`:

```sql
create schema if not exists pachka_meta;
create table if not exists pachka_meta.schema_migrations (...)
```

which puts it off the data API entirely, since PostgREST exposes only the schemas in `config.toml:13`. Failing that, `enable`/`force row level security` and `revoke all from anon, authenticated` on it.

**Test.** Delete the `relname <> 'schema_migrations'` exemption from `schema-invariants.test.ts` and let the existing three assertions cover it.

---

## H3 · The production role's RLS privileges are an untested assumption, and the harness is structurally blind to it

**Files:** `tests/harness/cluster.ts:122-125`, `tests/harness/database.ts:63-70`, `db/migrations/20260827T140000_create_accounts_identity.sql:306-313`

The accounts migration is emphatic and deliberate:

> There is deliberately NO INSERT, UPDATE or DELETE policy for `authenticated` on ANY table in this migration.

In fact there is no INSERT, UPDATE or DELETE policy for **anyone** — the six tables carry `for select` policies only, and every table also carries `force row level security`. `app_config` is the same: select-only policy, FORCE on. All server-side writes therefore depend entirely on the application's connection role bypassing RLS. The migration comment asserts this holds:

> The privileged server connection still bypasses RLS because its role carries BYPASSRLS.

**That assertion is never tested, and cannot be, as the harness is currently built.** `cluster.ts` runs `initdb --username=postgres`, and `database.ts:69` hands that same admin URL to `createDatabase()`. The connection under test is a **superuser**. A superuser bypasses RLS unconditionally — irrespective of `BYPASSRLS`, irrespective of `FORCE`. So the suite proves the policies hold for `anon` and `authenticated` (it does, well — see below), and proves nothing whatsoever about the privilege shape the server actually runs with.

**Attack — or rather, outage.** If `DATABASE_URL` in production resolves to a role that owns these tables but lacks `BYPASSRLS`, then `FORCE ROW LEVEL SECURITY` applies to it, there is no INSERT policy on any table, and **every server-side write fails**, registration included, with `new row violates row-level security policy`. The entire integration suite passes green. Conversely, if the role does carry `BYPASSRLS`, the design is correct — but nothing in the repository records or checks which of the two is true, and `FORCE` was added specifically to defend against the owner reading past its own policies, a defence that a superuser connection silently voids.

**Fix.** Make the harness exercise the production privilege shape rather than a strictly more permissive one:
1. In `cluster.ts`, after `initdb`, create a dedicated `pachka_app` role with `bypassrls` but **not** `superuser`, grant it ownership/privileges on the schema, and point `createTestDatabase()`'s application pool at it. Keep the superuser only for `create database ... template`.
2. Document in `.env.example` that `DATABASE_URL` must use a role with `BYPASSRLS`.

**Test.** Two assertions, both cheap:

```ts
// the app role bypasses RLS, so server-side writes work
expect(await db.one("select rolbypassrls from pg_roles where rolname = current_user")).toEqual({ rolbypassrls: true });
// and is not a superuser, so FORCE and the policy tests mean what they claim
expect(await db.one("select rolsuper from pg_roles where rolname = current_user")).toEqual({ rolsuper: false });
```

Plus one positive control that a server-side `insert into profiles` succeeds through the application pool — which today is proved only by a superuser.

**Not verified:** which role the hosted `DATABASE_URL` resolves to, and whether Supabase's `postgres` carries `BYPASSRLS`. That requires a live project.

---

## M4 · `profiles` is `USING (true)` to `anon` — the whole user base is enumerable

**File:** `db/migrations/20260827T140000_create_accounts_identity.sql:331-333`

```sql
create policy profiles_public_read on profiles
  for select to anon, authenticated
  using (true);
```

The migration justifies this as "genuinely public to the internet... every column on it is public by construction," and the SECURITY.md matrix does permit anon SELECT on `profiles`' public columns. But *columns* being public is not the same as *rows* being public. `artist_profiles` is carefully gated behind `artist_is_publicly_visible()` — published artwork, not suspended — and then `profiles` hands out the same identity for **every account on the platform**, artists and buyers alike, gated on nothing.

**Attack.** `GET /rest/v1/profiles?select=user_id,display_name,city` returns the full user table: every buyer's display name, city, and account UUID, including buyers who have never published, purchased, or reviewed anything. The UUIDs are then join keys for probing every other endpoint (`SECURITY.md` S3-29). Under Supabase's `max_rows = 1000` this pages rather than dumps, which slows it down and does not stop it.

**Fix.** Scope the policy to accounts that are actually public, and keep self-read separate:

```sql
create policy profiles_public_read on profiles
  for select to anon, authenticated
  using (accounts.artist_is_publicly_visible(user_id));

create policy profiles_self_read on profiles
  for select to authenticated
  using (user_id = auth.uid() or accounts.auth_is_admin());
```

When `reviews` lands, extend the first predicate to admit accounts that authored a visible review — that is the only other place a display name is legitimately shown to a stranger.

**Test.** In `accounts-data-api.test.ts`, seed a buyer with nothing published and assert `asAnon` sees zero rows for that `user_id`; seed an artist with a published artwork and assert they *are* returned, so the policy is proved scoped rather than merely closed.

---

## M5 · The service-role factory shares a barrel with the browser client, and nothing carries `server-only`

**Files:** `src/shared/db/index.ts:29-33`, `src/shared/db/supabase.ts`, `src/shared/db/client.ts`

One barrel re-exports `createSupabaseBrowserClient` (explicitly documented as safe in Client Components), `createSupabaseServiceRoleClient`, and `createDatabase` (which imports `pg` and `node:async_hooks`). A Client Component writing `import { createSupabaseBrowserClient } from "@/shared/db"` — the obvious, documented import — pulls the entire module graph, service-role factory included, into the client compilation.

**Being precise about the impact:** the key itself cannot leak this way. `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix, so Next does not inline it into client bundles; the reference resolves to `undefined`. The runtime `typeof window` guard at `supabase.ts:64` holds, and the refusal to fall back to the anon key at `:72` is a good decision. **This is a missing structural guard, not a live exposure** — but it is precisely the guard ARCHITECTURE.md's service-role rule asks for ("may not appear in any module that can be bundled for the browser"), and the cost of adding it is three lines.

**Fix.**
1. Move `createSupabaseServiceRoleClient` into its own `src/shared/db/supabase-admin.ts` and remove it from the shared barrel — callers import the admin path explicitly.
2. Add `import "server-only";` at the top of `supabase-admin.ts`, `client.ts`, and `instance.ts`. A client import then fails the **build**, which is the enforcement the `window` check can only approximate at runtime.

**Test.** With `server-only` in place the guarantee is compile-time, which is the point. Back it with a grep-style unit test over `.next/static/chunks/**` asserting the string `service_role` and the env var name appear nowhere — cheap, and it also catches an accidental `NEXT_PUBLIC_` rename.

---

## M6 · Money and config no longer speak the same language

**Files:** `src/shared/money/arithmetic.ts:27-54`, `db/migrations/20260827T101500_harden_app_config.sql:66-79`, `src/shared/config/registry.ts:40-44`

The hardening migration did the right thing for S1-16: it introduced `platform.commission_rate_bp` as an integer 1500 and **deleted** the float `platform.commission_rate` row, on the stated grounds that "a commission of 0.15 stored as a JSON number is a float." The registry followed.

The money module did not. `splitCommission(subtotal: Agorot, rate: number)` still takes a fraction in `[0, 1]`, and its doc comment still points at the deleted key:

> Split a subtotal into platform commission and artist net for a `rate` such as `platform.commission_rate` (0.15, read through `shared/config`).

There is no basis-point entry point. So the first module to wire config to money must write `bp / 10000` at the call site — reintroducing, in checkout code, exactly the float the migration was written to eliminate, in the one place nobody will look for it. A second, smaller disagreement: `splitCommission` accepts a rate up to `1.0` (100%) while the database constraint caps commission at 5000 bp (50%).

**What is *not* wrong here, and I checked properly.** The `.toFixed(9)` + half-away-from-zero implementation looked like a hack worth breaking. It is not. I brute-forced it against exact `BigInt` basis-point arithmetic over 2,800,007 combinations — every subtotal from 0 to 400,000 agorot across rates {1, 250, 333, 750, 1500, 4999, 5000} bp — plus the safe-integer boundary at 9,007,199,254,740,000 agorot. **Zero mismatches.** The `commission + net === subtotal` invariant holds by construction, since `net` is derived by subtraction and there is exactly one rounding decision. The rounding is correct; the API shape is what drifted.

**Fix.** Add the integer entry point and make it the only public one:

```ts
export function splitCommissionBasisPoints(subtotal: Agorot, bp: number): CommissionSplit {
  if (!Number.isInteger(bp) || bp < 0 || bp > 5000) throw AppError.validation(...);
  const n = BigInt(subtotal) * BigInt(bp);
  const q = n / 10000n, r = n % 10000n;
  const magnitude = (r < 0n ? -r : r) * 2n >= 10000n ? q + (n < 0n ? -1n : 1n) : q;
  const commission = agorot(Number(magnitude));
  return { commission, net: agorot(subtotal - commission) };
}
```

Deprecate the float overload, delete the stale reference to `platform.commission_rate`, and align the upper bound with the database's 5000 bp.

**Test.** A property test asserting `splitCommissionBasisPoints` equals exact `BigInt` arithmetic across the same ranges, that `commission + net === subtotal` always, and that the sign is symmetric for a refund's negative subtotal.

---

## M7 · No security headers

**File:** `next.config.ts` — still the empty scaffold (`const nextConfig: NextConfig = {};`).

No Content-Security-Policy, no HSTS, no `X-Frame-Options`/`frame-ancestors`, no `Referrer-Policy`, no `X-Content-Type-Options`. `SECURITY.md` S2-25 is about CSRF and stored XSS aimed at the single admin account — the account that settles payouts and reads bank details — and there is currently no compensating control at the transport layer. A stored-XSS payload in any artist free-text field that reaches an admin queue executes with nothing in its way, and can exfiltrate to any origin.

**Fix.** An `async headers()` block in `next.config.ts`: `Content-Security-Policy` with `default-src 'self'`, an explicit `connect-src` for the Supabase origin, `frame-ancestors 'none'`, `object-src 'none'`, and a nonce-based `script-src` (Next supports nonces via middleware); plus `Strict-Transport-Security`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`.

**Test.** An integration test asserting the response headers on a rendered route, with a named assertion per header so a regression says which one vanished.

---

## M8 · Email confirmation is off; weak password floor; no CAPTCHA

**File:** `supabase/config.toml:181-184, 196-234`

- `enable_confirmations = false` (`:225`). Users sign in without confirming their address. This directly undercuts `account_status.verified_at`, which `20260827T140000_create_accounts_identity.sql:83-93` documents as "written server-side only, after the provider confirms" — with confirmations off, nothing ever confirms, so the column stays null and any gate built on it either blocks everyone or gets quietly bypassed. It also means **anyone can register under someone else's email address**.
- `minimum_password_length = 6` (`:181`) with `password_requirements = ""` (`:184`).
- `[auth.captcha]` commented out (`:213-216`) — the only structural defence against the credential stuffing `SECURITY.md`'s rate-limit table names.

Partial credit where due: `[auth.rate_limit]` (`:196-210`) does give real limits on the auth endpoints — `sign_in_sign_ups = 30` per 5 min per IP, `token_verifications = 30`, `email_sent = 2`/hr. That covers row one of SECURITY.md's rate-limit table and nothing else (see M9).

**Fix.** `enable_confirmations = true`; `minimum_password_length = 10` with `password_requirements = "lower_upper_letters_digits"`; enable a CAPTCHA provider before launch. Mirror all three on the hosted project.

**Test.** These are provider settings, not PACHKA code, so the honest test is an assertion over the parsed `config.toml` in the unit suite — cheap, and it catches a well-meaning revert.

---

## M9 · Rate limiting: nothing is implemented, and the config keys it depends on do not exist

`git grep -iE "rate.?limit|throttle"` over `src/`, `db/`, `tests/`, and `scripts/` at `9ee9ff1` returns **zero matches**. Neither `20260827T090100_create_app_config.sql` nor `src/shared/config/registry.ts` defines a single limit key, though `SECURITY.md`'s rate-limit table opens with "Every one of these is a configuration value in `app_config`."

**Honest framing of the exposure.** No anonymous write surface is committed yet — `src/app/` contains only `layout.tsx`, `page.tsx`, and `globals.css`, and the only committed module file is the contact scanner. So nothing is currently reachable and unlimited. The finding is that **the substrate the design depends on is absent**: the first module to land a matchmaker submission, notify-me, report, or upload endpoint will find no keys to read and no helper to call, at which point the path of least resistance is to ship without one. Eight of the nine surfaces in the matrix have no coverage of any kind; the ninth (registration/sign-in) is partly covered by Supabase's own `[auth.rate_limit]`.

**Fix.** Land the `app_config` keys and a shared limiter before the first anonymous write endpoint, not after. A single Postgres-backed fixed-window table keyed on `(surface, key_hash, window_start)` is sufficient at this scale and needs no new infrastructure; hash the IP, per the log-redaction rule.

**Test.** Per surface, a test that issues `limit + 1` requests and asserts the last is rejected **before** the expensive work happens — assert the side effect did not occur (no row written, no mail queued), not merely that the status code was 429.

*Note: `src/modules/accounts/rate-limit.ts` exists uncommitted in the working tree. Out of scope at this commit; worth re-auditing once landed.*

---

## L10 · Contact scanner — five verified evasions

**File:** `src/modules/accounts/contact-scanner.ts`

**First, the structural question, which is the one that matters.** `SECURITY.md` S2-19 requires that this be a usability guard and never a boundary. Verified: at `9ee9ff1` the only importer of `scanForContactDetails` / `containsContactDetails` is its own test file. Nothing security-relevant depends on it — though largely because no write path exists yet. The module header states the limitation accurately and without hedging, and the real enforcement it names (no buyer-to-artist messaging, PACHKA holds the money) is the correct control.

I probed it rather than reasoning about it. **What it catches, all verified empirically:** every zero-width and bidirectional control tested (ZWSP U+200B, ZWNJ, ZWJ, soft hyphen U+00AD, word joiner U+2060, BOM U+FEFF, RLM U+200F); Cyrillic and Greek homoglyphs in both handles and domains; Arabic-Indic, Persian, fullwidth, mathematical-bold (U+1D7CE) and circled (U+2460) digits; `at`/`dot` obfuscation in bracket, spaced, and Hebrew (`שטרודל`/`נקודה`) forms; phone numbers broken by spaces, dots, slashes and dashes; the `+972` international form. And no false positives on year ranges, dimensions, or materials. That is materially better than the usual regex.

**Verified evasions**, in order of how cheap they are:

| Input | Result | Cause |
|---|---|---|
| `050x1234567` / `050א1234567` | passes | `DIGIT_RUN` (`:166`) admits only separators, so any letter splits the run below the 8-digit floor |
| `O5O1234567`, `O5O-l23-4567` | passes | no letter→digit folding (`O`→`0`, `l`/`I`→`1`) |
| `zero five zero one two three four five six seven` | passes | `HEBREW_DIGITS` (`:85`) has no English counterpart |
| `see instagram dot com slash yaelart` | passes | `findLinks` (`:208`) runs on `normalised` only; `findEmails` (`:181`) checks both raw and de-obfuscated, `findLinks` does not |
| `instagram (dot) com /yaelart` | passes | same cause |
| `IG: yaelart` | passes | handle without `@` — acknowledged out of scope in the header |

The fourth is worth noting because it is a one-line asymmetry, and because it produced a misleading result during probing: `find me at instagram dot com` *is* blocked — but as `email:me@instagram.com`, because the preceding word `at` became an `@`. The block is an accident of phrasing, not a rule. Drop the word `at` and it passes.

**Fix.** Two changes, both small:
1. `findLinks` should scan `deobfuscateAddresses(normalised)` as well as `normalised`, exactly as `findEmails` already does.
2. Let the phone candidate scan tolerate a bounded number of interleaved letters, and fold the obvious letter-for-digit substitutions before counting. Add English number words alongside the Hebrew ones.

Bump `SCANNER_VERSION` so the backfill re-flags existing rows — the mechanism at `artist_profiles.scanner_version` is already in place for this and is a good design.

**Test.** Each row of the table above as an explicit `expect(scanForContactDetails(...)).not.toEqual([])` case, alongside the existing false-positive corpus so a tightened rule cannot start rejecting `2019-2021`.

---

## Where the implementation is genuinely solid

Briefly, because you asked what to stop worrying about.

**The column split is correct, and correct for the right reason.** `20260827T140000_create_accounts_identity.sql` splits artist data across five tables and revokes *all* grants on `artist_contact_details` and `artist_payout_details` from both `anon` and `authenticated` (`:379-392`). The migration is explicit that the revoke is the operative control and the self-read policies are documentation of intent — which is the correct understanding of Postgres's grant-then-policy ordering, and the opposite of the mistake S0-1 predicted. I found no grant path to either table for either role.

**`tests/integration/accounts-data-api.test.ts` tests the real surface.** This is the test I fully expected to have to call out as theatre, and it is not. It goes through `asAnon`/`asUser`, which issue `set local role` plus the same `request.jwt.claim.*` GUCs PostgREST sets — not through a serializer, not through the owner connection. It enumerates `pg_class` rather than a hardcoded table list, so it starts covering table eleven the day it exists. It asserts on both column *names* (substring-matched, so `artist_email` is caught) and seeded sentinel *values*. And it includes a positive control at `:191` — "still sees the artist's public columns, so the lockdown is not just an outage" — which is exactly the guard that stops the other three assertions passing vacuously against a broken schema. `tests/harness/roles.ts` earns particular credit for stating, in its header, that `database.db` is *not* this surface.

**Roles are read from `user_roles` and nowhere else.** `accounts.auth_has_role()` (`:189`) reads the table; no JWT claim is consulted anywhere. `accounts-roles.test.ts` forges a genuinely convincing claim set (`user_metadata.role`, `is_admin`, top-level `role`, `user_roles[]`) and asserts it buys nothing — including self-granting `admin`, self-granting `artist`, deleting-then-rewriting the row, and changing the commission rate. It carries a negative control (a real admin held in `user_roles` *is* recognised), without which all four assertions would pass against a helper that returned a constant.

**Every `SECURITY DEFINER` helper pins `search_path = ''` and fully qualifies its references,** and `schema-invariants.test.ts:96` proves it catalog-wide from `pg_proc.proconfig` rather than per-function, with its own non-vacuity check. The helpers live in an `accounts` schema deliberately excluded from `config.toml:13`'s exposed schemas, so they are not published as RPC endpoints — a subtlety that is easy to miss and was not.

**`artist_has_published_artwork()` genuinely fails closed** against the not-yet-existing `artworks` table (`to_regclass` guard plus an `undefined_column`/`undefined_table` handler), so no artist profile is public today rather than all of them.

**Money.** Branded `Agorot`, integer-only construction that rejects rather than rounds, `bigint`-as-string parsing with explicit safe-range rejection in `fromDbValue`. The commission rounding is correct — brute-force verified, see M6.

**The migration runner** checksums each file, detects drift against the ledger, wraps each migration in its own transaction, and lints the forward-only rule.

**Error taxonomy.** `toResponse` flattens any non-`AppError` to a generic `"Something went wrong"`, so raw Postgres messages do not reach clients. S2-26 satisfied.

**The "zero mock assertions" claim is substantially true.** Two `toHaveBeenCalled` assertions exist, both in `src/shared/ui/Button.test.tsx`, asserting that an `onClick` prop fires and does not fire when disabled — a UI event assertion, not a mocked PACHKA dependency. No module logic and no database is mocked anywhere in the suite.

---

## What I could not verify

Stated plainly, so none of it is mistaken for a clean bill.

- **Hosted Supabase project settings.** `supabase/config.toml` configures the local CLI only. Auto-expose (H1), email confirmation and password policy (M8) must each be checked in the dashboard; the local file is evidence of intent, not of production state.
- **Whether the production `DATABASE_URL` role carries `BYPASSRLS`** (H3, second half). Requires a live project. The first half — that the harness runs as a superuser and therefore proves nothing about it — is verified from committed code.
- **PostgREST's actual behaviour.** Everything here is `set local role` against raw Postgres, which is a faithful model of the request path but not identical to it. Embedded resource selection (`?select=*,artist_contact_details(*)`), `max_rows` paging, the `/rpc` surface, and computed-column exposure would need a live Supabase instance to test directly. The grant-level controls make me reasonably confident none of these opens the contact tables, but I did not observe it.
- **Storage.** No bucket policies exist yet, so S1-9 (EXIF GPS, reachable originals bucket) and S1-15 (browser writes straight to storage) are unassessable rather than clean.
- **Most of the RLS matrix.** Of ~26 tables in the matrix, 7 exist. `orders`, `reservations`, `payments`, `fulfilments`, `payout_ledger`, `admin_audit`, `certificates`, `reports`, `artworks` and the rest are unwritten — so S0-4 (transactional reservation), S0-5 (client-supplied money), S0-6 (certificate PII), S1-14 (audit hash chain) and S1-18 (horizontal privilege) have no implementation to audit. Nothing here should be read as those being clear.
- **The uncommitted working tree**, excluded by instruction — including a `reviews` migration and an accounts-module rate limiter that both touch findings above.

---

*Audit 01 · against commit `9ee9ff1` · read-only, no source files modified.*
