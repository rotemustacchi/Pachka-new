/**
 * The client's address, for the surfaces that rate limit by it.
 *
 * WHY THIS IS NOT `(accounts)/deps.ts`'s `requestIp()`
 * ---------------------------------------------------
 * That one returns `string | undefined`, which is right for `accounts`: it
 * passes the value to a rate limiter that treats an absent address as "no key
 * to limit by" and the sign-in path has other limits behind it.
 *
 * The two surfaces here cannot accept that shape. `certificates` types its
 * `clientIp` as a required `string` and says why in the field's own comment:
 * "not optional with a fallback, because an optional value gets omitted at
 * exactly one call site and that call site becomes the unlimited one". The
 * matchmaker questionnaire is the same — an anonymous endpoint that is the
 * cheapest thing in the system to script.
 *
 * So this function always returns a key. When no proxy header is present it
 * returns a single shared constant rather than a random value or an empty
 * string: an unknown address is ONE bucket that fills up, not an infinite
 * supply of fresh ones. That fails towards refusing traffic, which is the
 * correct direction for a limiter.
 *
 * IT IS A RATE-LIMIT KEY AND NEVER AN AUTHORIZATION INPUT. A spoofed
 * `x-forwarded-for` buys a slightly larger quota and nothing else. The value is
 * hashed by the module before it is stored — SECURITY.md's log-redaction rule
 * puts raw client IPs on the never-stored list — so no raw address reaches a
 * table through this path.
 */
import { headers } from "next/headers";

/** One bucket for every request that arrives without a proxy header. */
export const UNKNOWN_CLIENT = "unknown-client";

export async function clientIp(): Promise<string> {
  const h = await headers();

  // `x-forwarded-for` is a list; the first entry is the original client.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded !== undefined && forwarded !== "") return forwarded;

  const real = h.get("x-real-ip")?.trim();
  if (real !== undefined && real !== "") return real;

  return UNKNOWN_CLIENT;
}
