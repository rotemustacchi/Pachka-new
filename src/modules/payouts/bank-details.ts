/**
 * The only file in this module that touches `artist_payout_details`.
 *
 * The table belongs to `accounts` (ARCHITECTURE.md, table ownership) and this
 * module never writes it -- see "What this module does NOT do" in ./index.
 * SECURITY.md S1-11 item 1 nevertheless puts the READ path here in as many
 * words: "all application access goes through the service-role client in
 * `payouts`". So: one file, three functions, and no other file in the module
 * imports them for a purpose other than deciding whether a settlement may
 * proceed.
 *
 * WHY THE DEFAULT IS MASKED
 * -------------------------
 * S1-11 item 2: "The admin settlement view displays them masked (last four
 * digits only) by default; revealing writes an `admin_audit` row with actor,
 * artist, and timestamp. This is the control that makes an insider read
 * detectable."
 *
 * An operator paying an artist genuinely needs the full account number, so the
 * control cannot be "never show it". It is "showing it leaves a mark". The
 * shapes below make that structural rather than procedural: `MaskedPayoutDetails`
 * has no field that could hold a full account number, so a queue that renders it
 * cannot leak one however it is written, and the only function that returns the
 * full record is the one that cannot run without an audit writer.
 *
 * WHY NOTHING HERE IS LOGGED, EVER
 * --------------------------------
 * S1-11 item 1 names logs as the likeliest exposure path, and names the exact
 * scenario: "the settlement flow is exactly where a developer adds
 * `console.log(payout)` to debug". There is no logging call anywhere in this
 * module, and every error thrown from this file is constructed from named,
 * non-sensitive fields -- an artist id, never a row. `AppError.details` is
 * returned to callers and serialised by `shared/errors`, so a row spread into it
 * would travel exactly as far as a log line would.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { adminPort, type PayoutsDeps } from "./deps";

/**
 * What an operator sees before they ask.
 *
 * Note what is absent: bank name, branch, account holder name. S1-11 opens by
 * observing that "the account holder name is frequently the artist's full legal
 * name, which is itself information the display name may be concealing", so it
 * is behind the audited reveal along with the number.
 */
export interface MaskedPayoutDetails {
  readonly artistId: string;
  /** Whether a settlement could proceed at all. */
  readonly onFile: boolean;
  /** The last four digits, or null. Never more, whatever the caller does with it. */
  readonly accountNumberLast4: string | null;
}

/** The full record. Returned only by `revealPayoutDetails`, only with an audit row. */
export interface PayoutDetails {
  readonly artistId: string;
  readonly bankName: string;
  readonly branch: string;
  readonly accountNumber: string;
  readonly accountHolderName: string;
}

interface DetailsRow {
  readonly bank_name: string | null;
  readonly branch: string | null;
  readonly account_number: string | null;
  readonly account_holder_name: string | null;
}

/**
 * All four columns are nullable, so "a row exists" is not the same as "details
 * are on file". `artist-payouts` requires "a bank account holder name, bank,
 * branch, and account number before any payout can be settled" -- four fields,
 * all of them, which is what this checks.
 */
function isComplete(row: DetailsRow | null): row is DetailsRow {
  if (row === null) return false;
  return [row.bank_name, row.branch, row.account_number, row.account_holder_name].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

async function readRow(sql: Sql, artistId: string): Promise<DetailsRow | null> {
  return sql.maybeOne<DetailsRow>(
    `select bank_name, branch, account_number, account_holder_name
       from artist_payout_details
      where user_id = $1`,
    [artistId],
  );
}

/**
 * Whether this artist can be paid at all.
 *
 * A boolean and nothing else. This is what the settlement gate and the
 * operator's queue call, so neither has an account number in scope to begin
 * with. `artist-payouts`, *Settlement blocked without details*.
 */
export async function hasPayoutDetails(sql: Sql, artistId: string): Promise<boolean> {
  return isComplete(await readRow(sql, artistId));
}

/** The masked form. The default for every operator surface. */
export async function maskedPayoutDetails(
  sql: Sql,
  artistId: string,
): Promise<MaskedPayoutDetails> {
  const row = await readRow(sql, artistId);
  if (!isComplete(row)) {
    return { artistId, onFile: false, accountNumberLast4: null };
  }
  const digits = (row.account_number ?? "").replace(/\D/g, "");
  return {
    artistId,
    onFile: true,
    // Fewer than four digits is not a real Israeli account number, and padding
    // it would invent digits. Show what there is; there is nothing to conceal
    // in a number that short because it is not a number.
    accountNumberLast4: digits.slice(-4),
  };
}

export interface RevealPayoutDetailsInput {
  /** The admin performing it. Authorised here, not by the caller. */
  readonly actorId: string;
  readonly artistId: string;
  /** Why they are looking. Recorded on the audit entry. */
  readonly reason?: string;
}

export interface RevealPayoutDetailsResult {
  readonly details: PayoutDetails;
  readonly auditEntryId: string;
}

/**
 * Reveal an artist's bank details, and record that it happened.
 *
 * The audit entry and the read share one transaction, which is what makes the
 * record impossible to skip: there is no ordering in which the details are
 * returned and the entry is not written. SECURITY.md S1-14 item 3 asks for that
 * coupling for admin actions generally; here it is the entire control.
 *
 * If no audit writer is wired, this REFUSES rather than returning the details
 * unaudited (see ./ports). An undetectable insider read is the failure S1-11
 * exists to prevent, so failing closed is not a nicety.
 *
 * NAMING CONFLICT, REPORTED NOT RESOLVED: S1-11's test text names the audit
 * action `payout_details_revealed`. The `admin_audit.action` CHECK constraint
 * that `moderation` shipped calls it `payout_details_access`. The constraint
 * wins, because a value it rejects would take the whole transaction down; the
 * difference is noted for the lead architect.
 */
export async function revealPayoutDetails(
  deps: PayoutsDeps,
  input: RevealPayoutDetailsInput,
): Promise<RevealPayoutDetailsResult> {
  const admin = adminPort(deps);

  return deps.db.withTransaction(async (tx) => {
    await admin.authorise(tx, input.actorId);

    const row = await readRow(tx, input.artistId);
    if (!isComplete(row)) {
      throw AppError.notFound("This artist has no payout details on file", {
        code: "payouts.no_payout_details",
        // The artist id only. Never the row -- see the file header.
        details: { artistId: input.artistId },
      });
    }

    const audit = await admin.record(tx, {
      action: "payout_details_access",
      targetType: "account",
      targetId: input.artistId,
      note: input.reason ?? "",
      // What is recorded is THAT the details were read, not WHAT was read.
      // Putting the account number in `admin_audit.details` would move the
      // secret into a second table and hash it into a chain nobody can redact.
      details: { revealed: true },
    });

    return {
      details: {
        artistId: input.artistId,
        bankName: row.bank_name ?? "",
        branch: row.branch ?? "",
        accountNumber: row.account_number ?? "",
        accountHolderName: row.account_holder_name ?? "",
      },
      auditEntryId: audit.id,
    };
  });
}
