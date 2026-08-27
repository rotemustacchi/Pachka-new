/**
 * Open self-service registration.
 *
 * accounts-and-profiles, "Open self-service registration": any visitor may
 * register with an email address and a password, without operator approval, and
 * the account gets the `buyer` role and a verification email.
 *
 * The scenario that shapes this file is the third one: registering an address
 * that already has an account "SHALL reject the registration and NOT reveal
 * whether the address is registered beyond a generic message". SECURITY.md
 * S2-26 sharpens that into something testable -- registration, password reset
 * and notify-me return identical responses and comparable timing for existing
 * and non-existing addresses -- and explains the usual way it is lost: a
 * Postgres unique-violation message reaching the client reads
 * `Key (email)=(yael@gmail.com) already exists`.
 *
 * So the duplicate case is not an error path here. It takes the same route,
 * does the same work, and returns the same object as a successful registration.
 * The address is never echoed back, and no constraint name can escape, because
 * the collision is decided by the auth provider before any insert is attempted.
 */
import { z } from "zod";
import { getConfig } from "@/shared/config";
import { AppError } from "@/shared/errors";
import type { Tx } from "@/shared/db";
import type { AccountsDeps, RequestOrigin } from "./deps";
import { consumeRateLimit } from "./rate-limit";
import { explainFindings, scanForContactDetails } from "./contact-scanner";

export interface RegisterInput extends RequestOrigin {
  readonly email: string;
  readonly password: string;
  /**
   * Shown next to this account's reviews.
   *
   * The spec's registration scenario names only an address and a password, but
   * `profiles.display_name` is world-readable and cannot be derived from the
   * address without publishing part of it. Asking for it is the only option
   * that does not leak. Raised in the accounts README as a spec gap.
   */
  readonly displayName: string;
}

export interface RegistrationResult {
  /**
   * Identical whether or not the address already had an account. Do not add a
   * field that varies between the two -- that is the whole point of this type.
   */
  readonly message: string;
}

/**
 * The one response registration gives. Phrased so that it is true in both
 * cases: an existing address gets no new account and no second verification
 * mail, and the sentence still holds.
 */
const GENERIC_RESULT: RegistrationResult = {
  message: "If that address can be registered, we have sent a verification email to it.",
};

const EmailSchema = z.string().trim().toLowerCase().email();

const DisplayNameSchema = z
  .string()
  .trim()
  .min(2, "Please use at least 2 characters.")
  .max(60, "Please use at most 60 characters.");

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Validate the parts a visitor can get wrong without revealing anything.
 *
 * A malformed address, a short password or contact details in a display name
 * are all safe to report precisely: none of them says whether the address is
 * registered. Only the collision itself has to stay generic.
 */
async function validate(deps: AccountsDeps, input: RegisterInput): Promise<{
  email: string;
  displayName: string;
}> {
  const fields: Record<string, string[]> = {};

  const email = EmailSchema.safeParse(input.email);
  if (!email.success) fields.email = ["Please enter a valid email address."];

  const displayName = DisplayNameSchema.safeParse(input.displayName);
  if (!displayName.success) {
    fields.displayName = displayName.error.issues.map((i) => i.message);
  } else {
    // A display name is public text, so it goes through the scanner like every
    // other public text field.
    const findings = scanForContactDetails(displayName.data);
    if (findings.length > 0) fields.displayName = [explainFindings(findings)];
  }

  const minLength = await getConfig(deps.db, "accounts.min_password_length");
  if (input.password.length < minLength) {
    // Length is the only rule. Composition requirements push people towards
    // Passw0rd! and away from passphrases, which is the wrong trade.
    fields.password = [`Please use at least ${minLength} characters.`];
  }

  if (Object.keys(fields).length > 0) {
    throw AppError.fieldsInvalid(fields, { code: "accounts.registration_invalid" });
  }

  return { email: email.data!, displayName: displayName.data! };
}

/**
 * Create the PACHKA-side rows for an account the auth provider has accepted.
 *
 * One transaction: an account with a profile but no role, or a role but no
 * status row, is a broken account that no later code path checks for.
 */
export async function provisionAccount(
  tx: Tx,
  input: { userId: string; displayName: string },
): Promise<void> {
  await tx.query(
    "insert into profiles (user_id, display_name) values ($1, $2)",
    [input.userId, input.displayName],
  );
  await tx.query("insert into account_status (user_id) values ($1)", [input.userId]);
  // The literal 'buyer'. Every registration produces exactly this role; the
  // artist role is added later by accounts.grant_artist_role(), and admin is a
  // manual database operation (SECURITY.md S0-2 item 4).
  await tx.query("insert into user_roles (user_id, role) values ($1, 'buyer')", [input.userId]);
}

/**
 * Register a visitor.
 *
 * Returns the same result whether the address was free or taken. The rate limit
 * is consumed before the provider is asked, so an attacker cannot use this
 * endpoint to enumerate addresses quickly even though every individual response
 * is uninformative.
 */
export async function register(
  deps: AccountsDeps,
  input: RegisterInput,
): Promise<RegistrationResult> {
  const { email, displayName } = await validate(deps, input);

  if (input.ipAddress) await consumeRateLimit(deps.db, "registration", input.ipAddress);
  await consumeRateLimit(deps.db, "registration", email);

  const outcome = await deps.auth.createUser(email, input.password);

  if (!outcome.created) {
    // The address is taken. Same object, same shape, no hint. The provider was
    // still asked, so the work done on this path is comparable to the other
    // one -- SECURITY.md S2-26 item 3 asks for comparable timing, not just an
    // identical body.
    return GENERIC_RESULT;
  }

  await deps.db.withTransaction((tx) =>
    provisionAccount(tx, { userId: outcome.user.id, displayName }),
  );

  await deps.auth.sendVerificationEmail(outcome.user.id);

  return GENERIC_RESULT;
}
