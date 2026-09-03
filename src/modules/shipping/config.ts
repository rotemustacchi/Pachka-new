/**
 * The `app_config` keys this module reads, one function per value.
 *
 * Every value here was a literal until the keys existed, because
 * `shared/config/registry.ts` is the foundation's file and adding a key there
 * was their edit rather than this module's. The keys are registered now, and
 * the one-function-per-value shape that made the swap a single line each is
 * kept: a caller asks for the value, not for the key, so nothing outside this
 * file knows what any of them is called.
 *
 * The keys registered earlier and always used as registered are
 * `shipping.unshipped_grace_days`, `returns.window_days`,
 * `returns.receipt_window_days` and `returns.cancellation_fee_rate`.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";
import { AppError } from "@/shared/errors";

/** A postal address. Only ever PACHKA's own; an artist address never becomes one of these. */
export interface PostalAddress {
  readonly recipient: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

/**
 * The PACHKA-operated return address.
 *
 * Every return is sent here and every outbound parcel carries it as its return
 * address, because a return address printed on the shipping label would
 * otherwise disclose the artist on the first sale (`shipping-and-returns`,
 * "Returns route through a PACHKA return address"; SECURITY.md SPEC-A).
 *
 * Operational data: an operator changes it when the PO box moves, and a
 * deployment should not be what changes it. The seeded value is a placeholder
 * and must be replaced before launch.
 *
 * The shape is checked here rather than trusted, because `json` is the one
 * `value_type` that `shared/config` cannot validate structurally -- it can only
 * say the stored value is JSON. A malformed address would otherwise reach a
 * shipping label, and the failure mode of a label with a missing line is a
 * parcel that goes nowhere with an artist's work inside it.
 */
export async function pachkaReturnAddress(db: Sql): Promise<PostalAddress> {
  const value = await getConfig(db, "shipping.pachka_return_address");

  for (const field of ["recipient", "line1", "city", "postalCode", "countryCode"] as const) {
    const line = value[field];
    if (typeof line !== "string" || line.trim() === "") {
      throw AppError.conflict(`The configured PACHKA return address is missing "${field}".`, {
        code: "shipping.return_address_not_configured",
        details: { field },
      });
    }
  }

  return value;
}

/**
 * How long the artist has to confirm or dispute a return that has been
 * forwarded to them before the case escalates to an admin.
 *
 * This window exists because of SECURITY.md SPEC-E: artist silence must not
 * hold a buyer's money. In this module's design the refund has already been
 * released by the operator's intact receipt before forwarding ever happens, so
 * the window governs the artist's *damage claim against PACHKA*, not the
 * buyer's refund. It still needs a deadline, or a claim stays open forever.
 */
export async function artistResponseWindowDays(db: Sql): Promise<number> {
  return getConfig(db, "returns.artist_response_window_days");
}

/**
 * Whether a refund gives back the outbound shipping the buyer paid.
 *
 * UNDECIDED, and deliberately held in configuration rather than in code
 * because it is a legal question about Israeli distance-selling law rather than
 * an engineering preference. The seeded default is the conservative reading —
 * the buyer bears return shipping, and the outbound leg was performed — not a
 * decision this module is entitled to make. When the answer arrives it is an
 * operator change, not a release.
 */
export async function refundIncludesOutboundShipping(db: Sql): Promise<boolean> {
  return getConfig(db, "returns.refund_includes_outbound_shipping");
}
