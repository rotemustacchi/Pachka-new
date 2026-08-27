/**
 * The one place artist data is shaped for a buyer.
 *
 * ARCHITECTURE.md: "accounts exposes a single toPublicArtist() serializer;
 * nothing else may shape artist data for a buyer."
 *
 * READ THIS BEFORE RELYING ON IT
 * ------------------------------
 * This is the SECOND line of defence, and saying so is not modesty. The first
 * is the schema: an artist's email, phone, address, socials and bank details
 * live in `artist_contact_details` and `artist_payout_details`, which have all
 * grants revoked from `anon` and `authenticated` and are reachable only through
 * the privileged server connection. That is what protects the data, because
 * Supabase publishes a PostgREST data API for every table in `public` and this
 * function is not on that path -- no PACHKA code is (SECURITY.md S0-1).
 *
 * What this function is for is PACHKA's own responses, and one specific way
 * they leak: React serialises the ENTIRE prop object of a Client Component into
 * the RSC flight payload embedded in the HTML, regardless of which fields the
 * JSX actually renders. The page shows "Yael, Haifa"; `curl` finds the phone
 * number in the source. That is how a correct serializer gets defeated in an
 * App Router codebase (SECURITY.md S1-8), and it is defeated by fetching the
 * wide row in the first place.
 *
 * So: shaping happens AT THE QUERY. Every buyer-facing query names its columns.
 * This function builds a fresh object key by key -- it never spreads its input --
 * so a wide row cannot flow through it even by accident, and it refuses a row
 * that carries a field it should never have seen.
 */
import { AppError } from "@/shared/errors";

/** Everything, and only everything, a buyer may see about an artist. */
export interface PublicArtist {
  readonly id: string;
  readonly displayName: string;
  readonly biography: string;
  readonly city: string | null;
  readonly avatarPath: string | null;
  /** ISO-8601. Renders as "on PACHKA since 2026". */
  readonly memberSince: string;
}

/** The narrow row a buyer-facing query is allowed to select. */
export interface ArtistProfileRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly biography: string | null;
  readonly city: string | null;
  readonly avatar_path: string | null;
  readonly created_at: Date | string;
}

/**
 * Field names that must never reach this function, because their presence means
 * the query that produced the row was too wide -- a `select *`, or a join that
 * pulled a whole contact row.
 *
 * Matched as substrings so `artist_email` and `phone_number` are caught too.
 */
const FORBIDDEN_FRAGMENTS = [
  "email",
  "phone",
  "address",
  "iban",
  "account_number",
  "branch",
  "bank",
  "social",
  "instagram",
  "website",
] as const;

function assertNarrow(row: Readonly<Record<string, unknown>>): void {
  const smuggled = Object.keys(row).filter((key) => {
    const lower = key.toLowerCase();
    return FORBIDDEN_FRAGMENTS.some((fragment) => lower.includes(fragment));
  });

  if (smuggled.length > 0) {
    // Deliberately loud, and deliberately not a silent strip. Silently dropping
    // the field would let the too-wide query survive, and the next person to
    // use that query would pass the row somewhere this function is not.
    throw AppError.forbidden(
      `A buyer-facing artist row arrived carrying ${smuggled.join(", ")}. ` +
        "The query that produced it is too wide: name the columns explicitly. " +
        "See SECURITY.md S1-8.",
      { code: "accounts.artist_row_too_wide", details: { fields: smuggled } },
    );
  }
}

/**
 * Shape an artist row for a buyer.
 *
 * Builds the result key by key. There is no spread here on purpose: a spread
 * would make this function's output depend on its input's shape, which is
 * exactly the property that has to not exist.
 */
export function toPublicArtist(row: ArtistProfileRow): PublicArtist {
  assertNarrow(row as unknown as Record<string, unknown>);

  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);

  return {
    id: row.user_id,
    displayName: row.display_name,
    biography: row.biography ?? "",
    city: row.city,
    avatarPath: row.avatar_path,
    memberSince: createdAt.toISOString(),
  };
}

/**
 * The column list every buyer-facing artist query must use.
 *
 * Exported so the query and the serializer cannot drift apart, and so that a
 * grep for `select *` against artist tables finds nothing to worry about.
 */
export const PUBLIC_ARTIST_COLUMNS =
  "user_id, display_name, biography, city, avatar_path, created_at";
