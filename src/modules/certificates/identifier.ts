/**
 * The certificate identifier.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * The identifier is the only thing standing between a public verification page
 * and the platform's entire sales history. SECURITY.md S0-6: if identifiers are
 * sequential or otherwise guessable, "anyone walks /verify/1, /verify/2, … and
 * harvests a list of (buyer name, artwork, artist, sale date) — a complete
 * purchase history for the platform, unauthenticated. In Israel, this is a
 * reportable personal-data incident, not an embarrassment."
 *
 * The buyer's name is out of that list already — it is not on the public page
 * and not in the table (see the migration, note C2) — but the rest of it is
 * still a business-intelligence feed and still a map of who bought what, once
 * joined against a gallery's own records.
 *
 * So: 122 bits of CSPRNG output inside a version-4 UUID, from
 * `node:crypto.randomUUID()`. The column also carries `gen_random_uuid()` as a
 * default, but the value is supplied here so the property is testable without a
 * database and so there is one answer to "where do identifiers come from"
 * rather than two.
 *
 * WHAT IS DELIBERATELY NOT DONE
 * -----------------------------
 * The identifier is not derived from the order id, the artwork id, a counter,
 * or a hash of any of them. A derived identifier is guessable by anyone who
 * knows the inputs, and the inputs here are things a buyer and an artist each
 * already hold half of.
 */
import { randomUUID } from "node:crypto";
import { AppError } from "@/shared/errors";

/**
 * A version-4 UUID, lowercase, in the canonical hyphenated form.
 *
 * The `4` and the `[89ab]` are the version and variant nibbles: a value that
 * matches this shape was generated as a v4, which is what carries the 122 bits
 * of randomness. A looser "any uuid" pattern would also accept a v1, whose
 * timestamp and MAC address make it partly predictable.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Mint a new certificate identifier. */
export function newCertificateIdentifier(): string {
  return randomUUID();
}

/** Whether a string is shaped like an identifier this module would have issued. */
export function isCertificateIdentifier(value: string): boolean {
  return UUID_V4.test(value);
}

/**
 * Parse an identifier arriving from a URL.
 *
 * Returns `null` rather than throwing a distinguishable error, and the caller
 * turns that into the SAME not-found the caller returns for a well-formed
 * identifier that does not exist. SECURITY.md S0-6 item 5 requires exactly
 * that: "an identical not-found response for a malformed ID, an unknown ID, and
 * a well-formed ID that does not exist — no timing or wording difference."
 *
 * A different answer for a malformed id would tell an enumerator that their
 * guesses are at least the right SHAPE, which is most of what they need to know
 * to stop wasting requests.
 */
export function parseCertificateIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return isCertificateIdentifier(trimmed) ? trimmed : null;
}

/**
 * The one not-found this module raises.
 *
 * Every refusal on the verification path — malformed, unknown, or absent — is
 * this exact error with this exact message. Exported so the route layer and the
 * tests both assert against one value rather than two copies that could drift.
 */
export const CERTIFICATE_NOT_FOUND_MESSAGE = "Certificate not found";

export function certificateNotFound(): AppError {
  // No `details`. A details payload naming the identifier that failed would
  // travel into logs and error responses, and a 404 that echoes the probe is a
  // 404 that confirms the probe was received in the form it was sent.
  return AppError.notFound(CERTIFICATE_NOT_FOUND_MESSAGE, {
    code: "certificates.not_found",
  });
}
