/**
 * The buyer-to-artist upgrade, and reading an artist profile.
 *
 * accounts-and-profiles, "Buyer upgrades to artist": a signed-in buyer
 * completes the artist profile form -- display name, bio, profile photo -- and
 * the account gains the `artist` role and access to artwork upload, with no
 * operator approval step.
 *
 * The role is granted by `accounts.grant_artist_role()`, a SECURITY DEFINER
 * function that hard-codes the literal 'artist'. That is not ceremony. The
 * attack in SECURITY.md S0-2 is a buyer POSTing `{"role":"admin"}` to this
 * legitimately public endpoint; the defence that actually holds is that no code
 * path anywhere -- including this one -- inserts a role value that came from a
 * request. The literal lives inside the function so that a bug in this file
 * cannot reach a different role either.
 *
 * Contact details are collected here too, and go into `artist_contact_details`,
 * which has all grants revoked from `anon` and `authenticated`. They are never
 * written to `artist_profiles`, whose every column is public.
 */
import { z } from "zod";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { AccountsDeps } from "./deps";
import { consumeRateLimit } from "./rate-limit";
import { SCANNER_VERSION, scanFields } from "./contact-scanner";
import { PUBLIC_ARTIST_COLUMNS, toPublicArtist, type ArtistProfileRow, type PublicArtist } from "./serialize";

export interface ArtistUpgradeInput {
  readonly displayName: string;
  readonly biography: string;
  readonly city?: string | null;
  readonly avatarPath?: string | null;
}

const DisplayName = z.string().trim().min(2).max(60);
const Biography = z.string().trim().max(2000);
const City = z.string().trim().min(1).max(80);

/**
 * Add the artist role and create the public artist profile.
 *
 * Idempotent: an artist who submits the form twice ends up with one role and an
 * updated profile, not a duplicate-key error.
 */
export async function upgradeToArtist(
  deps: AccountsDeps,
  userId: string,
  input: ArtistUpgradeInput,
): Promise<PublicArtist> {
  const parsed = z
    .object({
      displayName: DisplayName,
      biography: Biography,
      city: City.nullish(),
      avatarPath: z.string().trim().max(500).nullish(),
    })
    .safeParse(input);

  if (!parsed.success) {
    throw AppError.fieldsInvalid(
      Object.fromEntries(
        parsed.error.issues.map((issue) => [String(issue.path[0] ?? "form"), [issue.message]]),
      ),
      { code: "accounts.artist_profile_invalid" },
    );
  }

  const { displayName, biography, city, avatarPath } = parsed.data;

  // Public text, so it is scanned. This is the write path the scanner exists
  // for -- and the reason no policy lets `authenticated` write these tables
  // through the data API, which would skip this line entirely.
  scanFields({ displayName, biography });

  await consumeRateLimit(deps.db, "artist_upgrade", userId);

  return deps.db.withTransaction(async (tx) => {
    const exists = await tx.maybeOne("select 1 as ok from profiles where user_id = $1", [userId]);
    if (!exists) {
      throw AppError.notFound("No such account.", { code: "accounts.no_such_account" });
    }

    // The literal 'artist' is inside this function, not passed to it.
    await tx.query("select accounts.grant_artist_role($1)", [userId]);

    const row = await tx.one<ArtistProfileRow>(
      `insert into artist_profiles
         (user_id, display_name, biography, city, avatar_path, scanner_version)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id) do update set
         display_name    = excluded.display_name,
         biography       = excluded.biography,
         city            = excluded.city,
         avatar_path     = excluded.avatar_path,
         scanner_version = excluded.scanner_version
       returning ${PUBLIC_ARTIST_COLUMNS}`,
      [userId, displayName, biography, city ?? null, avatarPath ?? null, SCANNER_VERSION],
    );

    return toPublicArtist(row);
  });
}

export interface ArtistContactInput {
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly streetAddress?: string | null;
  readonly postalCode?: string | null;
  readonly instagramHandle?: string | null;
  readonly websiteUrl?: string | null;
}

/**
 * Store an artist's contact details.
 *
 * These are NOT scanned: they are the real thing, deliberately supplied, and
 * they go into a table no buyer-reachable role holds any grant on. The scanner
 * guards text that will be published; this is text that will not be.
 */
export async function saveArtistContactDetails(
  deps: AccountsDeps,
  userId: string,
  input: ArtistContactInput,
): Promise<void> {
  await deps.db.query(
    `insert into artist_contact_details
       (user_id, email, phone, street_address, postal_code, instagram_handle, website_url)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id) do update set
       email            = excluded.email,
       phone            = excluded.phone,
       street_address   = excluded.street_address,
       postal_code      = excluded.postal_code,
       instagram_handle = excluded.instagram_handle,
       website_url      = excluded.website_url`,
    [
      userId,
      input.email ?? null,
      input.phone ?? null,
      input.streetAddress ?? null,
      input.postalCode ?? null,
      input.instagramHandle ?? null,
      input.websiteUrl ?? null,
    ],
  );
}

/**
 * The artist behind a public profile page, or null.
 *
 * Null -- which the route turns into a not-found -- when the artist has nothing
 * published, or is suspended, or does not exist. The spec requires the first
 * ("Artist has no published artworks -> not-found response"); SECURITY.md S1-13
 * requires the second, and requires it derived rather than achieved by bulk
 * updating rows, so that lifting a suspension restores exactly the previous
 * state.
 *
 * The column list is explicit. `select *` here would pull a wide row that a
 * Server Component could hand to a Client Component, and React serialises the
 * whole prop object into the RSC payload embedded in the HTML regardless of
 * what the JSX renders (SECURITY.md S1-8). Shaping happens at the query.
 */
export async function findPublicArtist(db: Sql, artistId: string): Promise<PublicArtist | null> {
  const row = await db.maybeOne<ArtistProfileRow>(
    `select ${PUBLIC_ARTIST_COLUMNS}
       from artist_profiles
      where user_id = $1
        and accounts.artist_is_publicly_visible(user_id)`,
    [artistId],
  );

  return row ? toPublicArtist(row) : null;
}

/**
 * The artist's own view of their profile, published or not.
 *
 * Separate function rather than a flag, because "what a buyer may see" and
 * "what I may see about myself" are different questions and a boolean parameter
 * is how they get confused.
 */
export async function findOwnArtistProfile(
  db: Sql,
  artistId: string,
): Promise<PublicArtist | null> {
  const row = await db.maybeOne<ArtistProfileRow>(
    `select ${PUBLIC_ARTIST_COLUMNS} from artist_profiles where user_id = $1`,
    [artistId],
  );

  return row ? toPublicArtist(row) : null;
}

export async function hasRole(db: Sql, userId: string, role: string): Promise<boolean> {
  const row = await db.maybeOne(
    "select 1 as ok from user_roles where user_id = $1 and role = $2",
    [userId, role],
  );
  return row !== null;
}
