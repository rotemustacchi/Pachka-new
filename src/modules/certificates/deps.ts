/**
 * What this module is handed.
 *
 * THE RATE LIMIT IS INJECTED, AND THAT IS A COMPROMISE — SEE BELOW
 * ----------------------------------------------------------------
 * ARCHITECTURE.md: "Every configurable number lives in `app_config`, read
 * through `shared/config`. No magic numbers in module code." The verification
 * limit belongs there, and SECURITY.md's cross-cutting rate-limit table lists
 * it by name: "Certificate verification | IP | Enumeration (S0-6)".
 *
 * It is not there yet, and this module cannot put it there. `shared/config`'s
 * `ConfigKey` is a closed union derived from `CONFIG_REGISTRY`, and
 * `registry.test.ts` asserts the registry has exactly one entry per key seeded
 * by a migration — neither more nor fewer. Seeding two rows from this module's
 * migration without the matching registry entries breaks that test; adding the
 * registry entries means editing `src/shared/config/registry.ts`, which belongs
 * to the foundation and not to this module.
 *
 * So the limit arrives as an injected value with a declared default, and the
 * two keys are reported to the lead architect for registration:
 *
 *   certificates.verification_window_minutes   integer, default 1
 *   certificates.verification_max_per_window   integer, default 30
 *
 * When those are registered, `verificationLimitFor()` below becomes a
 * `getConfig` pair and this comment goes away. Deliberately structured so that
 * change touches one function.
 */
import type { Database, Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";

/**
 * A limit on how fast one client may resolve certificate identifiers.
 *
 * Per IP, because the surface is anonymous by definition — there is no account
 * to key on, and requiring one would defeat the purpose of a certificate a
 * buyer can show to a stranger.
 */
export interface VerificationRateLimit {
  readonly windowMinutes: number;
  readonly maxPerWindow: number;
}

/**
 * Thirty lookups a minute from one address.
 *
 * Generous for a human — a gallery checking a shelf of pieces one after another
 * stays well inside it — and useless for enumeration: the identifier space is
 * 2^122, so at this rate an attacker exhausts the age of the universe long
 * before the keyspace. The limit is not the primary defence (the identifier is)
 * and is not pretending to be; it is the second one, so that a flaw in the
 * first does not hand over the table at line speed.
 */
export const DEFAULT_VERIFICATION_RATE_LIMIT: VerificationRateLimit = {
  windowMinutes: 1,
  maxPerWindow: 30,
};

/**
 * Where the artist's display name comes from.
 *
 * A port, not an import, and the reason is ARCHITECTURE.md's dependency table:
 * it lets `certificates` call `orders` and `artworks`, and NOT `accounts`. The
 * certificate must nonetheless state the artist's display name — the spec makes
 * it mandatory content — so the fact arrives the way `artworks` receives
 * `InventoryDemandSource` from `orders`: declared here, implemented by whoever
 * owns the data.
 *
 * This is a genuine gap in the dependency table rather than a clever
 * workaround, and it is reported as one. The right long-term home for the
 * implementation is `accounts`, whose `toPublicArtist()` is the only sanctioned
 * way to shape artist data for a buyer; `sqlArtistNames` below is the interim,
 * and reads one column that SECURITY.md's RLS matrix already publishes to the
 * whole internet.
 */
export type ArtistNameSource = (sql: Sql, artistId: string) => Promise<string>;

/**
 * Reads `artist_profiles.display_name`.
 *
 * A read, never a write — ARCHITECTURE.md forbids writing another module's
 * tables and expects cross-module foreign keys, which this row is on the other
 * end of. The column is the artist's public persona: the RLS matrix marks
 * `artist_profiles` readable by `anon`, and `accounts` describes it as holding
 * "ONLY what a buyer may see". Nothing from `artist_contact_details` is touched
 * here, and nothing from it could be — the tables are split precisely so this
 * kind of query cannot reach an email address by accident (SECURITY.md S0-1).
 */
export const sqlArtistNames: ArtistNameSource = async (sql, artistId) => {
  const row = await sql.maybeOne<{ display_name: string }>(
    "select display_name from artist_profiles where user_id = $1",
    [artistId],
  );
  if (row === null) {
    // Fails closed. A certificate naming no artist is not a certificate, and a
    // placeholder like "אמן/ית" would put a document into the world attributing
    // a work to nobody.
    throw AppError.conflict("The artist named on this certificate has no profile.", {
      code: "certificates.artist_name_unavailable",
      details: { artistId },
    });
  }
  return row.display_name;
};

export interface CertificatesDeps {
  readonly db: Database;
  /**
   * Omit to accept the default above. The composition root passes the
   * configured value once the two keys are registered.
   */
  readonly verificationRateLimit?: VerificationRateLimit;
  /** Omit to accept `sqlArtistNames`. */
  readonly artistNames?: ArtistNameSource;
}

/** The limit in force for a call. One place resolves it; see the header. */
export function verificationLimitFor(deps: CertificatesDeps): VerificationRateLimit {
  return deps.verificationRateLimit ?? DEFAULT_VERIFICATION_RATE_LIMIT;
}

/** The name source in force for a call. */
export function artistNameSourceFor(deps: CertificatesDeps): ArtistNameSource {
  return deps.artistNames ?? sqlArtistNames;
}
