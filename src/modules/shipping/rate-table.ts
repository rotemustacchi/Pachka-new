/**
 * Reading and editing the flat-rate table.
 *
 * `shipping-and-returns`: "The rate table SHALL be editable by an admin without
 * a code deployment." That is why the rates are three tables rather than a
 * constant in this file, and why every function below takes an amount instead
 * of deriving one.
 *
 * **Authorisation is the caller's**. These functions do not check that the
 * actor is an admin, for the same reason `shared/config`'s `setConfig` does
 * not: the admin route is where the role is verified (against `user_roles`,
 * never a JWT claim -- ARCHITECTURE.md) and where the audit row is written,
 * and `admin_audit` belongs to `moderation`. What this module guarantees is
 * that there is no data-API write path at all: `shipping_zones`,
 * `shipping_tiers` and `shipping_rates` grant `authenticated` nothing but
 * SELECT, so an edit can only arrive through a server call like these.
 * SECURITY.md's policy matrix marks rate manipulation as shipping fraud.
 */
import { z } from "zod";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { fromDbValue, nonNegativeAgorot, toDbValue, type Agorot } from "@/shared/money";
import type { ShippingTier, ShippingZone } from "./types";

const Code = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9_]+$/, "A code is lowercase letters, digits and underscores");
const DisplayName = z.string().trim().min(1).max(80);

const ZoneInputSchema = z.object({
  code: Code,
  displayName: DisplayName,
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .default("IL"),
  cities: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
  postalPrefixes: z.array(z.string().trim().regex(/^\d{1,7}$/)).max(500).default([]),
  active: z.boolean().default(true),
});

export type ZoneInput = z.input<typeof ZoneInputSchema>;

const TierInputSchema = z.object({
  code: Code,
  displayName: DisplayName,
  ordinal: z.number().int().min(0).max(1000),
  maxLengthMm: z.number().int().positive().max(10_000),
  maxWidthMm: z.number().int().positive().max(10_000),
  maxHeightMm: z.number().int().positive().max(10_000),
  maxWeightGrams: z.number().int().positive().max(1_000_000),
  active: z.boolean().default(true),
});

export type TierInput = z.input<typeof TierInputSchema>;

function parsed<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join(".") || "_";
      (fields[path] ??= []).push(issue.message);
    }
    throw AppError.fieldsInvalid(fields, { code });
  }
  return result.data;
}

/** Create or update a delivery zone, keyed on its code. */
export async function upsertZone(db: Sql, input: ZoneInput): Promise<ShippingZone> {
  const zone = parsed(ZoneInputSchema, input, "shipping.invalid_zone");

  const row = await db.one<{
    id: string;
    code: string;
    display_name: string;
    country_code: string;
  }>(
    `insert into shipping_zones (code, display_name, country_code, cities, postal_prefixes, active)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (code) do update
        set display_name    = excluded.display_name,
            country_code    = excluded.country_code,
            cities          = excluded.cities,
            postal_prefixes = excluded.postal_prefixes,
            active          = excluded.active
     returning id, code, display_name, country_code`,
    [zone.code, zone.displayName, zone.countryCode, zone.cities, zone.postalPrefixes, zone.active],
  );

  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    countryCode: row.country_code,
  };
}

/** Create or update a size tier, keyed on its code. */
export async function upsertTier(db: Sql, input: TierInput): Promise<ShippingTier> {
  const tier = parsed(TierInputSchema, input, "shipping.invalid_tier");

  const row = await db.one<{
    id: string;
    code: string;
    display_name: string;
    ordinal: number;
    max_length_mm: number;
    max_width_mm: number;
    max_height_mm: number;
    max_weight_grams: number;
  }>(
    `insert into shipping_tiers
       (code, display_name, ordinal, max_length_mm, max_width_mm, max_height_mm, max_weight_grams, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (code) do update
        set display_name     = excluded.display_name,
            ordinal          = excluded.ordinal,
            max_length_mm    = excluded.max_length_mm,
            max_width_mm     = excluded.max_width_mm,
            max_height_mm    = excluded.max_height_mm,
            max_weight_grams = excluded.max_weight_grams,
            active           = excluded.active
     returning id, code, display_name, ordinal, max_length_mm, max_width_mm, max_height_mm, max_weight_grams`,
    [
      tier.code,
      tier.displayName,
      tier.ordinal,
      tier.maxLengthMm,
      tier.maxWidthMm,
      tier.maxHeightMm,
      tier.maxWeightGrams,
      tier.active,
    ],
  );

  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    ordinal: row.ordinal,
    maxLengthMm: row.max_length_mm,
    maxWidthMm: row.max_width_mm,
    maxHeightMm: row.max_height_mm,
    maxWeightGrams: row.max_weight_grams,
  };
}

export interface RateInput {
  readonly zoneCode: string;
  readonly tierCode: string;
  /** Whole agorot. Never a shekel float -- ARCHITECTURE.md. */
  readonly amountAgorot: number;
}

export interface RateEntry {
  readonly zoneCode: string;
  readonly tierCode: string;
  readonly amountAgorot: Agorot;
}

/** Set the flat rate for one zone x tier cell. */
export async function setRate(db: Sql, input: RateInput): Promise<RateEntry> {
  const amount = nonNegativeAgorot(input.amountAgorot);

  const row = await db.maybeOne<{ amount_agorot: string }>(
    `insert into shipping_rates (zone_id, tier_id, amount_agorot)
     select z.id, t.id, $3::bigint
       from shipping_zones z, shipping_tiers t
      where z.code = $1 and t.code = $2
     on conflict (zone_id, tier_id) do update set amount_agorot = excluded.amount_agorot
     returning amount_agorot`,
    [input.zoneCode, input.tierCode, toDbValue(amount)],
  );

  if (!row) {
    throw AppError.notFound(
      `No zone "${input.zoneCode}" and tier "${input.tierCode}" to set a rate for`,
      { code: "shipping.unknown_rate_cell", details: { zoneCode: input.zoneCode, tierCode: input.tierCode } },
    );
  }

  return { zoneCode: input.zoneCode, tierCode: input.tierCode, amountAgorot: fromDbValue(row.amount_agorot) };
}

/** Every active zone, in code order. */
export async function listZones(db: Sql): Promise<readonly ShippingZone[]> {
  const { rows } = await db.query<{
    id: string;
    code: string;
    display_name: string;
    country_code: string;
  }>(
    `select id, code, display_name, country_code from shipping_zones where active order by code asc`,
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    countryCode: row.country_code,
  }));
}

/** The whole table, for the admin screen and for showing a buyer what shipping costs where. */
export async function readRateTable(db: Sql): Promise<readonly RateEntry[]> {
  const { rows } = await db.query<{ zone_code: string; tier_code: string; amount_agorot: string }>(
    `select z.code as zone_code, t.code as tier_code, r.amount_agorot
       from shipping_rates r
       join shipping_zones z on z.id = r.zone_id
       join shipping_tiers t on t.id = r.tier_id
      where z.active and t.active
      order by z.code asc, t.ordinal asc`,
  );
  return rows.map((row) => ({
    zoneCode: row.zone_code,
    tierCode: row.tier_code,
    amountAgorot: fromDbValue(row.amount_agorot),
  }));
}

/**
 * The rate for one cell, as money.
 *
 * A missing cell is a `conflict`, not a zero. Quoting zero for an unconfigured
 * combination would ship an artwork across the country for free every time an
 * admin added a zone and forgot a row, and nobody would notice until the
 * invoice.
 */
export async function rateFor(db: Sql, zoneId: string, tierId: string): Promise<Agorot> {
  const row = await db.maybeOne<{ amount_agorot: string }>(
    `select amount_agorot from shipping_rates where zone_id = $1 and tier_id = $2`,
    [zoneId, tierId],
  );
  if (!row) {
    throw AppError.conflict(
      "Shipping to this address is not priced for this parcel size yet.",
      { code: "shipping.rate_not_configured", details: { zoneId, tierId } },
    );
  }
  return fromDbValue(row.amount_agorot);
}
