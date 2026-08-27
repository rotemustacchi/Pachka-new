/**
 * Which delivery zone an address falls in -- and the refusal when it falls in
 * none.
 *
 * `shipping-and-returns`, "Address outside every configured zone": the system
 * blocks checkout and states that the platform does not currently deliver
 * there. There is no catch-all zone in the schema for exactly this reason: a
 * fallback row would turn a deliberate refusal into a silent mispricing, and
 * the first anyone would hear of it is a parcel to Eilat quoted at the Tel Aviv
 * rate.
 */
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import type { DeliveryAddress, ShippingZone } from "./types";

interface ZoneRow {
  readonly id: string;
  readonly code: string;
  readonly display_name: string;
  readonly country_code: string;
  readonly cities: string[];
  readonly postal_prefixes: string[];
}

/**
 * Fold a city name to something two humans typing the same city agree on.
 *
 * Lowercase, punctuation to spaces, whitespace collapsed. Hebrew has no case,
 * so this is a no-op for the script most addresses arrive in and does the work
 * for the transliterations that also occur ("Tel Aviv-Yafo", "tel aviv yafo").
 * The geresh and gershayim used in Hebrew abbreviations are folded too.
 */
export function normaliseCity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[׳״'"`]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Digits only: a postal code typed as "6100000" and "61000-00" are the same code. */
function normalisePostalCode(value: string | null | undefined): string {
  return (value ?? "").replace(/\D+/g, "");
}

function toZone(row: ZoneRow): ShippingZone {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    countryCode: row.country_code,
  };
}

/**
 * The zone an address belongs to.
 *
 * City first, postal prefix second. City is what an operator maintains and what
 * a buyer types; the postal prefix is the fallback for a spelling the list does
 * not have yet. Longest matching prefix wins, so a zone carved out of a broader
 * one ('7431' inside '7') resolves to the specific one rather than to whichever
 * row the planner returned first.
 *
 * Throws `validation` with code `shipping.address_outside_zones` when nothing
 * matches: the buyer can fix an address, which is what makes it a validation
 * failure rather than a conflict.
 */
export async function resolveZone(db: Sql, address: DeliveryAddress): Promise<ShippingZone> {
  const country = (address.countryCode ?? "").trim().toUpperCase();
  const city = normaliseCity(address.city ?? "");
  const postalCode = normalisePostalCode(address.postalCode);

  const { rows } = await db.query<ZoneRow>(
    `select id, code, display_name, country_code, cities, postal_prefixes
       from shipping_zones
      where active and country_code = $1`,
    [country],
  );

  const byCity = rows.find((row) => row.cities.some((name) => normaliseCity(name) === city));
  if (byCity) return toZone(byCity);

  if (postalCode.length > 0) {
    let best: ZoneRow | undefined;
    let bestLength = -1;
    for (const row of rows) {
      for (const prefix of row.postal_prefixes) {
        const cleaned = normalisePostalCode(prefix);
        if (cleaned.length > 0 && postalCode.startsWith(cleaned) && cleaned.length > bestLength) {
          best = row;
          bestLength = cleaned.length;
        }
      }
    }
    if (best) return toZone(best);
  }

  throw AppError.validation(
    "PACHKA does not currently deliver to this address. No configured delivery zone covers it.",
    {
      code: "shipping.address_outside_zones",
      // The address the buyer typed, echoed back so the checkout screen can
      // point at the field. Nothing here is anyone else's data.
      details: { city: address.city, postalCode: address.postalCode ?? null, countryCode: country },
    },
  );
}
