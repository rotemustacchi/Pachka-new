/**
 * Configuration this module needs that is not yet in the `app_config`
 * registry.
 *
 * `shared/config/registry.ts` is owned by the foundation, and adding a key
 * there is their edit, not this module's. Everything below is therefore a
 * literal marked `TODO(config)`, reported to the lead architect for
 * registration, and read through a single function per value so that swapping
 * it for `getConfig(db, key)` is a one-line change inside this file rather
 * than a hunt through the module.
 *
 * The keys already registered and used as registered -- never as literals --
 * are `shipping.unshipped_grace_days`, `returns.window_days`,
 * `returns.receipt_window_days` and `returns.cancellation_fee_rate`.
 */
import type { Sql } from "@/shared/db";

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
 * TODO(config): register `shipping.pachka_return_address` as a `json` key and
 * read it here. It is operational data an operator changes when the PO box
 * moves, and a deployment should not be what changes it.
 */
const PACHKA_RETURN_ADDRESS: PostalAddress = {
  recipient: "PACHKA",
  line1: "ת.ד. 0000",
  city: "תל אביב-יפו",
  postalCode: "6100000",
  countryCode: "IL",
};

export async function pachkaReturnAddress(_db: Sql): Promise<PostalAddress> {
  return PACHKA_RETURN_ADDRESS;
}

/**
 * How long the artist has to confirm or dispute a return that has been
 * forwarded to them before the case escalates to an admin.
 *
 * TODO(config): register `returns.artist_response_window_days`, integer,
 * default 7, bounds 1..90.
 *
 * This window exists because of SECURITY.md SPEC-E: artist silence must not
 * hold a buyer's money. In this module's design the refund has already been
 * released by the operator's intact receipt before forwarding ever happens, so
 * the window governs the artist's *damage claim against PACHKA*, not the
 * buyer's refund. It still needs a deadline, or a claim stays open forever.
 */
export async function artistResponseWindowDays(_db: Sql): Promise<number> {
  return 7;
}

/**
 * Whether a refund gives back the outbound shipping the buyer paid.
 *
 * TODO(config): register `returns.refund_includes_outbound_shipping`, boolean,
 * default false -- and see the report: this is a legal question about Israeli
 * distance-selling law, not an engineering preference, and the default below
 * is the conservative reading (the buyer bears return shipping, and the
 * outbound leg was performed), not a decision this module is entitled to make.
 */
export async function refundIncludesOutboundShipping(_db: Sql): Promise<boolean> {
  return false;
}
