/**
 * Artist-managed fulfilment: the dispatch obligation, the shipped transition's
 * preconditions, and the chase when a deadline passes.
 *
 * `shipping-and-returns`, "Artist-managed fulfilment": the artist packs and
 * dispatches their own work, must record a carrier name and a tracking
 * reference to mark a fulfilment shipped, and the buyer is notified with that
 * reference. A fulfilment still unshipped past the stated lead time plus the
 * configured grace period notifies the artist and is flagged for admin
 * attention.
 *
 * **This module does not move the fulfilment.** ARCHITECTURE.md: "Order state
 * changes go through one function. `orders.transition()`... No module and no
 * route sets an order status directly." So `markShipped` records the evidence
 * that the transition is permitted -- carrier, tracking, packaging
 * confirmation -- and returns; `orders` performs the transition and dispatches
 * the notification this returns. The dispatch row is shipping's, the fulfilment
 * row is orders'.
 */
import { z } from "zod";
import { getConfig } from "@/shared/config";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { addBusinessDays } from "./business-days";
import { pachkaReturnAddress, type PostalAddress } from "./config";
import { packagingObligationFor, type PackagingObligation } from "./packaging";
import type { NotificationRequest } from "./types";

export interface DispatchRecord {
  readonly id: string;
  readonly fulfilmentId: string;
  readonly orderId: string;
  readonly artistId: string;
  readonly leadTimeDays: number;
  readonly packagingConfirmationRequired: boolean;
  readonly dueAt: Date;
  readonly carrierName: string | null;
  readonly trackingReference: string | null;
  readonly packagingConfirmedAt: Date | null;
  readonly shippedAt: Date | null;
  readonly flaggedAt: Date | null;
}

interface DispatchRow {
  readonly id: string;
  readonly fulfilment_id: string;
  readonly order_id: string;
  readonly artist_id: string;
  readonly lead_time_days: number;
  readonly packaging_confirmation_required: boolean;
  readonly due_at: Date;
  readonly carrier_name: string | null;
  readonly tracking_reference: string | null;
  readonly packaging_confirmed_at: Date | null;
  readonly shipped_at: Date | null;
  readonly flagged_at: Date | null;
}

const COLUMNS = `id, fulfilment_id, order_id, artist_id, lead_time_days,
  packaging_confirmation_required, due_at, carrier_name, tracking_reference,
  packaging_confirmed_at, shipped_at, flagged_at`;

function toRecord(row: DispatchRow): DispatchRecord {
  return {
    id: row.id,
    fulfilmentId: row.fulfilment_id,
    orderId: row.order_id,
    artistId: row.artist_id,
    leadTimeDays: row.lead_time_days,
    packagingConfirmationRequired: row.packaging_confirmation_required,
    dueAt: row.due_at,
    carrierName: row.carrier_name,
    trackingReference: row.tracking_reference,
    packagingConfirmedAt: row.packaging_confirmed_at,
    shippedAt: row.shipped_at,
    flaggedAt: row.flagged_at,
  };
}

export interface DispatchObligationInput {
  readonly fulfilmentId: string;
  readonly orderId: string;
  readonly artistId: string;
  /**
   * The artwork's stated dispatch lead time. `artwork-listings` collects it in
   * **business days**, and it is snapshotted here at payment so that an artist
   * editing the listing afterwards cannot move their own deadline.
   */
  readonly leadTimeDays: number;
  readonly medium?: string | null;
  readonly fragile?: boolean;
  /** When the clock starts: the moment the fulfilment became the artist's to ship. */
  readonly paidAt?: Date;
}

/**
 * Open the dispatch obligation for a fulfilment that has just been paid.
 *
 * Called by `orders`. Idempotent on `fulfilment_id`: a retried payment webhook
 * must not reset a deadline or duplicate a row, so a second call returns the
 * existing obligation untouched rather than recomputing `due_at` from a later
 * clock.
 */
export async function recordDispatchObligation(
  db: Sql,
  input: DispatchObligationInput,
): Promise<{ dispatch: DispatchRecord; packaging: PackagingObligation }> {
  const leadTimeDays = z.number().int().min(0).max(365).parse(input.leadTimeDays);
  const paidAt = input.paidAt ?? new Date();
  const packaging = packagingObligationFor({
    ...(input.medium === undefined ? {} : { medium: input.medium }),
    ...(input.fragile === undefined ? {} : { fragile: input.fragile }),
  });

  const graceDays = await getConfig(db, "shipping.unshipped_grace_days");
  const dueAt = addBusinessDays(paidAt, leadTimeDays + graceDays);

  const row = await db.one<DispatchRow>(
    `insert into shipping_dispatches
       (fulfilment_id, order_id, artist_id, lead_time_days, packaging_confirmation_required, due_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (fulfilment_id) do update set fulfilment_id = shipping_dispatches.fulfilment_id
     returning ${COLUMNS}`,
    [input.fulfilmentId, input.orderId, input.artistId, leadTimeDays, packaging.required, dueAt],
  );

  return { dispatch: toRecord(row), packaging };
}

/**
 * Read one dispatch.
 *
 * `artistId` is not optional by accident. A cross-artist read returns
 * `not_found` rather than `forbidden`, because "forbidden" confirms the
 * fulfilment exists and lets an artist enumerate their competitors' sales
 * (SECURITY.md S1-18).
 */
export async function readDispatch(
  db: Sql,
  params: { readonly fulfilmentId: string; readonly artistId?: string },
): Promise<DispatchRecord> {
  const row = await db.maybeOne<DispatchRow>(
    `select ${COLUMNS} from shipping_dispatches
      where fulfilment_id = $1 and ($2::uuid is null or artist_id = $2::uuid)`,
    [params.fulfilmentId, params.artistId ?? null],
  );
  if (!row) {
    throw AppError.notFound("No such fulfilment", {
      code: "shipping.dispatch_not_found",
      details: { fulfilmentId: params.fulfilmentId },
    });
  }
  return toRecord(row);
}

/**
 * What the artist is shown before dispatching: the packaging obligations, the
 * deadline, and the return address to print.
 *
 * The return address is PACHKA's, never the artist's own. A return address on
 * the label would disclose the artist on the very first sale
 * (`shipping-and-returns`, "Outbound label does not disclose the artist"),
 * which is the half of SECURITY.md SPEC-A that no amount of careful software
 * fixes after the fact.
 */
export async function dispatchInstructions(
  db: Sql,
  params: { readonly fulfilmentId: string; readonly artistId: string },
): Promise<{
  readonly dispatch: DispatchRecord;
  readonly packaging: PackagingObligation;
  readonly returnAddress: PostalAddress;
}> {
  const dispatch = await readDispatch(db, params);
  return {
    dispatch,
    // Reconstructed from the stored obligation rather than from the artwork, so
    // that what the artist must confirm cannot change after the sale.
    packaging: dispatch.packagingConfirmationRequired
      ? packagingObligationFor({ fragile: true })
      : packagingObligationFor({}),
    returnAddress: await pachkaReturnAddress(db),
  };
}

/** The return address every outbound parcel carries. PACHKA's, for every artist, always. */
export async function outboundReturnAddress(db: Sql): Promise<PostalAddress> {
  return pachkaReturnAddress(db);
}

const CarrierName = z.string().trim().min(2).max(80);
const TrackingReference = z
  .string()
  .trim()
  .min(4)
  .max(100)
  .regex(/^[\w\-./]+$/u, "A tracking reference is letters, digits and - . / _");

export interface MarkShippedInput {
  readonly fulfilmentId: string;
  readonly artistId: string;
  readonly carrierName: string;
  readonly trackingReference: string;
  /** Must be explicitly true when the fulfilment's packaging obligation applies. */
  readonly packagingConfirmed?: boolean;
  readonly now?: Date;
}

export interface MarkShippedResult {
  readonly dispatch: DispatchRecord;
  /**
   * The buyer notification carrying the tracking reference. `orders` sends it
   * after its own `paid -> shipped` transition commits, so a buyer is never
   * told about a shipment that then rolled back.
   */
  readonly notifications: readonly NotificationRequest[];
}

/**
 * Record the artist's dispatch, or refuse it.
 *
 * Refusals, in the order they are checked: not your fulfilment (404), already
 * shipped (409), no carrier, no tracking reference, and no packaging
 * confirmation where one is required. The carrier and tracking checks are
 * duplicated as CHECK constraints on the table -- module code gives the artist
 * a typed error naming the field, the constraint makes a shipped row without
 * tracking unrepresentable however it was written.
 */
export async function markShipped(db: Sql, input: MarkShippedInput): Promise<MarkShippedResult> {
  const existing = await readDispatch(db, {
    fulfilmentId: input.fulfilmentId,
    artistId: input.artistId,
  });

  if (existing.shippedAt !== null) {
    throw AppError.conflict("This fulfilment is already marked shipped", {
      code: "shipping.already_shipped",
      details: { fulfilmentId: input.fulfilmentId, shippedAt: existing.shippedAt.toISOString() },
    });
  }

  const fields: Record<string, string[]> = {};
  const carrier = CarrierName.safeParse(input.carrierName);
  if (!carrier.success) {
    fields["carrierName"] = ["A carrier name is required to mark a fulfilment shipped"];
  }
  const tracking = TrackingReference.safeParse(input.trackingReference);
  if (!tracking.success) {
    fields["trackingReference"] = [
      "A tracking reference is required to mark a fulfilment shipped, so the buyer can follow the parcel",
    ];
  }
  if (Object.keys(fields).length > 0) {
    throw AppError.fieldsInvalid(fields, { code: "shipping.tracking_required" });
  }

  if (existing.packagingConfirmationRequired && input.packagingConfirmed !== true) {
    throw AppError.validation(
      "Confirm that the packaging requirements were met before marking this fulfilment shipped",
      {
        code: "shipping.packaging_confirmation_required",
        details: {
          requirements: packagingObligationFor({ fragile: true }).requirements.map((r) => r.code),
        },
      },
    );
  }

  const now = input.now ?? new Date();
  const row = await db.one<DispatchRow>(
    `update shipping_dispatches
        set carrier_name           = $2,
            tracking_reference     = $3,
            packaging_confirmed_at = case when packaging_confirmation_required then $4::timestamptz else packaging_confirmed_at end,
            shipped_at             = $4::timestamptz
      where fulfilment_id = $1 and artist_id = $5 and shipped_at is null
      returning ${COLUMNS}`,
    [
      input.fulfilmentId,
      carrier.success ? carrier.data : "",
      tracking.success ? tracking.data : "",
      now,
      input.artistId,
    ],
  );

  const dispatch = toRecord(row);
  return {
    dispatch,
    notifications: [
      {
        audience: "buyer",
        template: "shipping.fulfilment_shipped",
        data: {
          orderId: dispatch.orderId,
          fulfilmentId: dispatch.fulfilmentId,
          carrierName: dispatch.carrierName,
          trackingReference: dispatch.trackingReference,
        },
      },
    ],
  };
}

export interface OverdueSweepResult {
  readonly flagged: readonly DispatchRecord[];
  readonly notifications: readonly NotificationRequest[];
}

/**
 * Flag every fulfilment still unshipped past its deadline.
 *
 * Idempotent by construction: `flagged_at is null` is part of the predicate, so
 * running the sweep twice does not chase an artist twice or put the same
 * fulfilment in the admin queue again. That matters because this runs on a
 * schedule and a scheduler that fires twice is normal, not exceptional.
 */
export async function flagOverdueDispatches(
  db: Sql,
  options: { readonly now?: Date } = {},
): Promise<OverdueSweepResult> {
  const now = options.now ?? new Date();

  const { rows } = await db.query<DispatchRow>(
    `update shipping_dispatches
        set flagged_at = $1::timestamptz, artist_notified_at = $1::timestamptz
      where shipped_at is null and flagged_at is null and due_at <= $1::timestamptz
      returning ${COLUMNS}`,
    [now],
  );

  const flagged = rows.map(toRecord);
  const notifications: NotificationRequest[] = [];
  for (const dispatch of flagged) {
    notifications.push({
      audience: "artist",
      template: "shipping.dispatch_overdue_artist",
      recipientId: dispatch.artistId,
      data: {
        fulfilmentId: dispatch.fulfilmentId,
        orderId: dispatch.orderId,
        dueAt: dispatch.dueAt.toISOString(),
      },
    });
    notifications.push({
      audience: "admin",
      template: "shipping.dispatch_overdue_admin",
      data: {
        fulfilmentId: dispatch.fulfilmentId,
        orderId: dispatch.orderId,
        artistId: dispatch.artistId,
        dueAt: dispatch.dueAt.toISOString(),
      },
    });
  }

  return { flagged, notifications };
}
