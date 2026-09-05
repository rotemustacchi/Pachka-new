/**
 * The return case, from the buyer's cancellation to the money moving.
 *
 * The shape of this file is one decision, taken in SECURITY.md and recorded in
 * `shipping-and-returns` as "Returns route through a PACHKA return address":
 *
 *   A buyer cannot post a parcel to an address they may not be told
 *   (SECURITY.md SPEC-A). So the parcel comes to PACHKA, an operator records
 *   receipt and condition, and PACHKA forwards it to the artist on a label the
 *   buyer never sees. The artist's address is never on a buyer-facing surface
 *   and is never stored on the return row.
 *
 *   The refund is released by that operator record, not by the artist
 *   (SECURITY.md SPEC-E). The party who loses money by refunding must not be
 *   the only party who can release it, and silence must not work in their
 *   favour: PACHKA holds the buyer's money, so PACHKA carries the liability
 *   when a statutory cancellation goes unanswered.
 *
 * Both of those are also CHECK constraints on the table. See the migration.
 *
 * A note on the spec's own wording: two scenarios under "Return cost and
 * transit risk fall on the buyer" still say the *artist* confirms receipt --
 * language left over from before the return address changed. The requirement
 * text above them, and the requirement that added the PACHKA return address,
 * both put the operator in that position. This module implements the operator
 * gate and treats the artist's confirmation as a corroborating record made
 * after forwarding. Reported to the lead architect rather than resolved
 * silently.
 */
import { getConfig } from "@/shared/config";
import { AppError } from "@/shared/errors";
import type { Sql } from "@/shared/db";
import { addAgorot, fromDbValue, splitCommission, toDbValue, nonNegativeAgorot, type Agorot } from "@/shared/money";
import { addCalendarDays } from "./business-days";
import { artistResponseWindowDays, pachkaReturnAddress, refundIncludesOutboundShipping, type PostalAddress } from "./config";
import { returnTerms, type ReturnTerms } from "./terms";
import type { NotificationRequest } from "./types";

export type ReturnStatus =
  | "requested"
  | "received_intact"
  | "disputed"
  | "unreceived"
  | "resolved_refunded"
  | "resolved_denied";

export type ReturnCondition = "intact" | "damaged";

export interface ReturnCase {
  readonly id: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly buyerId: string;
  readonly artistId: string;
  readonly status: ReturnStatus;
  readonly deliveredAt: Date;
  readonly requestedAt: Date;
  readonly receiptDeadlineAt: Date;
  readonly itemSubtotalAgorot: Agorot;
  readonly shippingAgorot: Agorot;
  readonly cancellationFeeAgorot: Agorot;
  readonly refundAmountAgorot: Agorot | null;
  readonly refundAuthorisedAt: Date | null;
  readonly receivedAt: Date | null;
  readonly receivedCondition: ReturnCondition | null;
  readonly inventoryRestoredAt: Date | null;
  readonly forwardedAt: Date | null;
  readonly artistResponseDeadlineAt: Date | null;
  readonly artistConfirmedAt: Date | null;
  readonly artistDamageReportedAt: Date | null;
  readonly escalatedAt: Date | null;
  readonly escalationReason: string | null;
  readonly resolvedAt: Date | null;
}

interface ReturnRow {
  readonly id: string;
  readonly order_id: string;
  readonly fulfilment_id: string;
  readonly artwork_id: string;
  readonly buyer_id: string;
  readonly artist_id: string;
  readonly status: ReturnStatus;
  readonly delivered_at: Date;
  readonly requested_at: Date;
  readonly receipt_deadline_at: Date;
  readonly item_subtotal_agorot: string;
  readonly shipping_agorot: string;
  readonly cancellation_fee_agorot: string;
  readonly refund_amount_agorot: string | null;
  readonly refund_authorised_at: Date | null;
  readonly received_at: Date | null;
  readonly received_condition: ReturnCondition | null;
  readonly inventory_restored_at: Date | null;
  readonly forwarded_at: Date | null;
  readonly artist_response_deadline_at: Date | null;
  readonly artist_confirmed_at: Date | null;
  readonly artist_damage_reported_at: Date | null;
  readonly escalated_at: Date | null;
  readonly escalation_reason: string | null;
  readonly resolved_at: Date | null;
}

const COLUMNS = `id, order_id, fulfilment_id, artwork_id, buyer_id, artist_id, status,
  delivered_at, requested_at, receipt_deadline_at, item_subtotal_agorot, shipping_agorot,
  cancellation_fee_agorot, refund_amount_agorot, refund_authorised_at, received_at,
  received_condition, inventory_restored_at, forwarded_at, artist_response_deadline_at,
  artist_confirmed_at, artist_damage_reported_at, escalated_at, escalation_reason, resolved_at`;

function toCase(row: ReturnRow): ReturnCase {
  return {
    id: row.id,
    orderId: row.order_id,
    fulfilmentId: row.fulfilment_id,
    artworkId: row.artwork_id,
    buyerId: row.buyer_id,
    artistId: row.artist_id,
    status: row.status,
    deliveredAt: row.delivered_at,
    requestedAt: row.requested_at,
    receiptDeadlineAt: row.receipt_deadline_at,
    itemSubtotalAgorot: fromDbValue(row.item_subtotal_agorot),
    shippingAgorot: fromDbValue(row.shipping_agorot),
    cancellationFeeAgorot: fromDbValue(row.cancellation_fee_agorot),
    refundAmountAgorot: row.refund_amount_agorot === null ? null : fromDbValue(row.refund_amount_agorot),
    refundAuthorisedAt: row.refund_authorised_at,
    receivedAt: row.received_at,
    receivedCondition: row.received_condition,
    inventoryRestoredAt: row.inventory_restored_at,
    forwardedAt: row.forwarded_at,
    artistResponseDeadlineAt: row.artist_response_deadline_at,
    artistConfirmedAt: row.artist_confirmed_at,
    artistDamageReportedAt: row.artist_damage_reported_at,
    escalatedAt: row.escalated_at,
    escalationReason: row.escalation_reason,
    resolvedAt: row.resolved_at,
  };
}

/**
 * What the buyer is told to do.
 *
 * Every field is either PACHKA's or the buyer's own. There is deliberately no
 * artist field of any kind on this type -- not a name, not a city -- so that
 * "the instructions contain no artist address, phone number, or email" is a
 * property of the type rather than a promise about a code path.
 */
export interface ReturnInstructions {
  readonly returnId: string;
  readonly returnAddress: PostalAddress;
  /** Written on the parcel so the operator can match it to the case. */
  readonly reference: string;
  readonly shipByAdvisory: Date;
  readonly terms: ReturnTerms;
}

async function instructionsFor(db: Sql, row: ReturnRow): Promise<ReturnInstructions> {
  return {
    returnId: row.id,
    returnAddress: await pachkaReturnAddress(db),
    reference: `RET-${row.id.slice(0, 8).toUpperCase()}`,
    shipByAdvisory: row.receipt_deadline_at,
    terms: await returnTerms(db),
  };
}

export interface RequestReturnInput {
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly buyerId: string;
  readonly artistId: string;
  /** When the buyer took delivery. The statutory clock runs from here, not from payment. */
  readonly deliveredAt: Date;
  /** Snapshotted server-side by `orders`; never a figure from a request body (SECURITY.md S0-5). */
  readonly itemSubtotalAgorot: number;
  readonly shippingAgorot?: number;
  readonly now?: Date;
}

export interface RequestReturnResult {
  readonly returnCase: ReturnCase;
  /**
   * The transition `orders` must perform. This module does not move orders --
   * ARCHITECTURE.md gives that to `orders.transition()` alone.
   */
  readonly orderTransition: "return_requested";
  readonly instructions: ReturnInstructions;
  readonly notifications: readonly NotificationRequest[];
}

/**
 * The buyer's fourteen-day cancellation right.
 *
 * Counted in calendar days from delivery, because that is how the statute
 * counts them; a weekend does not pause a consumer's cancellation right.
 */
export async function requestReturn(db: Sql, input: RequestReturnInput): Promise<RequestReturnResult> {
  const now = input.now ?? new Date();
  const subtotal = nonNegativeAgorot(input.itemSubtotalAgorot);
  const shipping = nonNegativeAgorot(input.shippingAgorot ?? 0);

  const windowDays = await getConfig(db, "returns.window_days");
  const deadline = addCalendarDays(input.deliveredAt, windowDays);

  if (now.getTime() > deadline.getTime()) {
    throw AppError.validation(
      `The ${windowDays}-day statutory cancellation window for this order has closed.`,
      {
        code: "returns.window_closed",
        details: {
          deliveredAt: input.deliveredAt.toISOString(),
          windowDays,
          windowClosedAt: deadline.toISOString(),
        },
      },
    );
  }

  const receiptWindowDays = await getConfig(db, "returns.receipt_window_days");
  const receiptDeadline = addCalendarDays(now, receiptWindowDays);

  const row = await db.maybeOne<ReturnRow>(
    `insert into returns
       (order_id, fulfilment_id, artwork_id, buyer_id, artist_id, delivered_at, requested_at,
        receipt_deadline_at, item_subtotal_agorot, shipping_agorot)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint)
     on conflict (fulfilment_id, artwork_id) do nothing
     returning ${COLUMNS}`,
    [
      input.orderId,
      input.fulfilmentId,
      input.artworkId,
      input.buyerId,
      input.artistId,
      input.deliveredAt,
      now,
      receiptDeadline,
      toDbValue(subtotal),
      toDbValue(shipping),
    ],
  );

  if (!row) {
    throw AppError.conflict("A return has already been requested for this artwork", {
      code: "returns.already_requested",
      details: { fulfilmentId: input.fulfilmentId, artworkId: input.artworkId },
    });
  }

  return {
    returnCase: toCase(row),
    orderTransition: "return_requested",
    instructions: await instructionsFor(db, row),
    notifications: [
      {
        audience: "buyer",
        template: "returns.instructions_issued",
        recipientId: row.buyer_id,
        data: { returnId: row.id, orderId: row.order_id },
      },
      {
        audience: "artist",
        template: "returns.requested",
        recipientId: row.artist_id,
        data: { returnId: row.id, orderId: row.order_id, fulfilmentId: row.fulfilment_id },
      },
    ],
  };
}

/** Read a case. Authorisation belongs to the route; RLS keeps the data API honest. */
export async function readReturn(db: Sql, returnId: string): Promise<ReturnCase> {
  const row = await db.maybeOne<ReturnRow>(`select ${COLUMNS} from returns where id = $1`, [returnId]);
  if (!row) {
    throw AppError.notFound("No such return", { code: "returns.not_found", details: { returnId } });
  }
  return toCase(row);
}

/** Re-issue the instructions for an open case, e.g. when the buyer loses the email. */
export async function returnInstructions(db: Sql, returnId: string): Promise<ReturnInstructions> {
  const row = await db.maybeOne<ReturnRow>(`select ${COLUMNS} from returns where id = $1`, [returnId]);
  if (!row) {
    throw AppError.notFound("No such return", { code: "returns.not_found", details: { returnId } });
  }
  return instructionsFor(db, row);
}

interface RefundFigures {
  readonly feeAgorot: Agorot;
  readonly refundAgorot: Agorot;
}

/**
 * What the buyer gets back.
 *
 * The fee and the refund come out of `splitCommission`, which exists for the
 * commission split but is exactly this arithmetic: one rounding decision, and
 * the second figure absorbs the remainder so no agora is created or destroyed.
 * Reusing it means the cancellation fee rounds the same way the commission
 * does and is covered by the same property test.
 */
async function refundFor(db: Sql, row: ReturnRow): Promise<RefundFigures> {
  const rate = await getConfig(db, "returns.cancellation_fee_rate");
  const subtotal = fromDbValue(row.item_subtotal_agorot);
  const { commission: feeAgorot, net } = splitCommission(subtotal, rate);

  const includeOutbound = await refundIncludesOutboundShipping(db);
  const refundAgorot = includeOutbound ? addAgorot(net, fromDbValue(row.shipping_agorot)) : net;

  return { feeAgorot, refundAgorot };
}

export interface OperatorReceiptInput {
  readonly returnId: string;
  /**
   * The PACHKA operator recording the arrival. The route verifies the admin
   * role against `user_roles` -- never a JWT claim (ARCHITECTURE.md) -- before
   * calling this.
   */
  readonly operatorId: string;
  readonly condition: ReturnCondition;
  readonly notes?: string;
  readonly now?: Date;
}

export interface OperatorReceiptResult {
  readonly returnCase: ReturnCase;
  /** Present only when the money is released. `null` on a damaged arrival. */
  readonly refund: RefundFigures | null;
  /** The transition `orders` must perform, or `null` while the case is open. */
  readonly orderTransition: "returned" | null;
  /** True only for an intact arrival: a damaged artwork does not go back on sale. */
  readonly restoreInventory: boolean;
  readonly notifications: readonly NotificationRequest[];
}

/**
 * The operator records the parcel's arrival at the PACHKA return address.
 *
 * This is the refund gate. An intact arrival releases the money, moves the
 * order to `returned` and restores the artwork; a damaged one withholds the
 * refund, moves the case to the admin queue and notifies both parties.
 */
export async function recordOperatorReceipt(
  db: Sql,
  input: OperatorReceiptInput,
): Promise<OperatorReceiptResult> {
  const now = input.now ?? new Date();
  const notes = (input.notes ?? "").slice(0, 4000);

  const existing = await db.maybeOne<ReturnRow>(`select ${COLUMNS} from returns where id = $1`, [
    input.returnId,
  ]);
  if (!existing) {
    throw AppError.notFound("No such return", {
      code: "returns.not_found",
      details: { returnId: input.returnId },
    });
  }
  if (existing.received_at !== null) {
    throw AppError.conflict("This return has already been recorded as received", {
      code: "returns.already_received",
      details: { returnId: input.returnId, receivedAt: existing.received_at.toISOString() },
    });
  }
  // `unreceived` is reachable from the sweep below; an operator finding the
  // parcel afterwards is a real case, so it is allowed back in here. A case an
  // admin has already resolved is not.
  if (existing.status !== "requested" && existing.status !== "unreceived") {
    throw AppError.conflict(`A return in state "${existing.status}" cannot be recorded as received`, {
      code: "returns.not_open",
      details: { returnId: input.returnId, status: existing.status },
    });
  }

  // Validate before branching, not by falling through to the else.
  //
  // This read `if (condition === "damaged")` with everything else treated as
  // intact — so a caller passing "as_described", or any typo, took the
  // refund-and-restock path. The database CHECK on received_condition never
  // saw the bad value, because the intact branch writes the literal 'intact'.
  //
  // A returns admin form posting a raw string is exactly how that arrives, and
  // the failure is silent and expensive: money released and a piece put back on
  // sale on a value nobody meant. Every other parse boundary in this codebase
  // rejects rather than defaults, and so does this one now.
  if (input.condition !== "damaged" && input.condition !== "intact") {
    throw AppError.validation(
      `"${String(input.condition)}" is not a recorded condition. Use "intact" or "damaged".`,
      {
        code: "returns.condition_invalid",
        details: { returnId: input.returnId, condition: String(input.condition) },
        fields: { condition: ["יש לבחור: תקין או פגום"] },
      },
    );
  }

  if (input.condition === "damaged") {
    const row = await db.one<ReturnRow>(
      `update returns
          set status = 'disputed', received_at = $2::timestamptz, received_condition = 'damaged',
              operator_id = $3, operator_notes = $4,
              escalated_at = coalesce(escalated_at, $2::timestamptz),
              escalation_reason = coalesce(escalation_reason, 'damaged_on_arrival')
        where id = $1
        returning ${COLUMNS}`,
      [input.returnId, now, input.operatorId, notes],
    );

    const returnCase = toCase(row);
    return {
      returnCase,
      refund: null,
      orderTransition: null,
      restoreInventory: false,
      notifications: [
        {
          audience: "buyer",
          template: "returns.arrived_damaged",
          recipientId: returnCase.buyerId,
          data: { returnId: returnCase.id, orderId: returnCase.orderId },
        },
        {
          audience: "artist",
          template: "returns.arrived_damaged",
          recipientId: returnCase.artistId,
          data: { returnId: returnCase.id, orderId: returnCase.orderId },
        },
        {
          audience: "admin",
          template: "returns.dispute_opened",
          data: { returnId: returnCase.id, orderId: returnCase.orderId, reason: "damaged_on_arrival" },
        },
      ],
    };
  }

  const { feeAgorot, refundAgorot } = await refundFor(db, existing);

  const row = await db.one<ReturnRow>(
    `update returns
        set status = 'received_intact', received_at = $2::timestamptz, received_condition = 'intact',
            operator_id = $3, operator_notes = $4,
            cancellation_fee_agorot = $5::bigint,
            refund_amount_agorot = $6::bigint,
            refund_authorised_at = $2::timestamptz,
            inventory_restored_at = $2::timestamptz,
            resolved_at = $2::timestamptz
      where id = $1
      returning ${COLUMNS}`,
    [input.returnId, now, input.operatorId, notes, toDbValue(feeAgorot), toDbValue(refundAgorot)],
  );

  const returnCase = toCase(row);
  return {
    returnCase,
    refund: { feeAgorot, refundAgorot },
    orderTransition: "returned",
    restoreInventory: true,
    notifications: [
      {
        audience: "buyer",
        template: "returns.refund_issued",
        recipientId: returnCase.buyerId,
        data: {
          returnId: returnCase.id,
          orderId: returnCase.orderId,
          refundAgorot,
          cancellationFeeAgorot: feeAgorot,
        },
      },
      {
        audience: "artist",
        template: "returns.completed",
        recipientId: returnCase.artistId,
        data: { returnId: returnCase.id, orderId: returnCase.orderId },
      },
    ],
  };
}

/**
 * The label an operator prints to send the artwork on to its artist.
 *
 * The artist's address is passed in by the caller, read from
 * `artist_contact_details` -- a table with every grant revoked from `anon` and
 * `authenticated` -- and is **not stored** on the return row. It exists for the
 * lifetime of this function's return value and appears on no buyer-facing
 * surface (`shipping-and-returns`, "Forwarding does not reach the buyer").
 */
export interface ForwardingLabel {
  readonly returnId: string;
  readonly reference: string;
  readonly to: PostalAddress;
  readonly from: PostalAddress;
}

export interface ForwardInput {
  readonly returnId: string;
  readonly operatorId: string;
  readonly artistAddress: PostalAddress;
  readonly now?: Date;
}

export async function forwardToArtist(
  db: Sql,
  input: ForwardInput,
): Promise<{ readonly returnCase: ReturnCase; readonly label: ForwardingLabel; readonly notifications: readonly NotificationRequest[] }> {
  const now = input.now ?? new Date();
  const responseWindowDays = await artistResponseWindowDays(db);
  const responseDeadline = addCalendarDays(now, responseWindowDays);

  const row = await db.maybeOne<ReturnRow>(
    `update returns
        set forwarded_at = coalesce(forwarded_at, $2::timestamptz),
            artist_response_deadline_at = coalesce(artist_response_deadline_at, $3::timestamptz)
      where id = $1 and received_at is not null
      returning ${COLUMNS}`,
    [input.returnId, now, responseDeadline],
  );

  if (!row) {
    throw AppError.conflict(
      "A return can only be forwarded once it has been recorded as received at the PACHKA return address",
      { code: "returns.not_received", details: { returnId: input.returnId } },
    );
  }

  const returnCase = toCase(row);
  return {
    returnCase,
    label: {
      returnId: returnCase.id,
      reference: `FWD-${returnCase.id.slice(0, 8).toUpperCase()}`,
      to: input.artistAddress,
      from: await pachkaReturnAddress(db),
    },
    notifications: [
      {
        audience: "artist",
        template: "returns.forwarded_to_artist",
        recipientId: returnCase.artistId,
        data: {
          returnId: returnCase.id,
          orderId: returnCase.orderId,
          respondBy: responseDeadline.toISOString(),
        },
      },
    ],
  };
}

export interface ArtistResponseInput {
  readonly returnId: string;
  readonly artistId: string;
  readonly response: "confirmed" | "damaged";
  readonly notes?: string;
  readonly now?: Date;
}

/**
 * The artist's record of what reached them.
 *
 * Note what this does NOT do: it does not release or withhold the buyer's
 * refund. By the time a parcel is forwarded, the operator has already recorded
 * its condition and the money has moved. A damage report here opens the
 * artist's claim against PACHKA -- who had custody -- and is exactly the point
 * of routing returns through PACHKA at all. SECURITY.md SPEC-E is the reason
 * the buyer's money is not waiting on this call.
 *
 * So a report on an already-refunded case leaves the case `received_intact` and
 * raises an escalation beside it, rather than dragging the status back to
 * `disputed`. `returns_refund_requires_gate` enforces the same thing one layer
 * down: a row carrying an authorised refund cannot sit in a disputed state.
 */
export async function recordArtistResponse(
  db: Sql,
  input: ArtistResponseInput,
): Promise<{ readonly returnCase: ReturnCase; readonly notifications: readonly NotificationRequest[] }> {
  const now = input.now ?? new Date();
  const notes = (input.notes ?? "").slice(0, 4000);

  const existing = await db.maybeOne<ReturnRow>(
    `select ${COLUMNS} from returns where id = $1 and artist_id = $2`,
    [input.returnId, input.artistId],
  );
  if (!existing) {
    // Not-found rather than forbidden: an artist must not be able to probe for
    // other artists' cases (SECURITY.md S1-18).
    throw AppError.notFound("No such return", {
      code: "returns.not_found",
      details: { returnId: input.returnId },
    });
  }
  if (existing.forwarded_at === null) {
    throw AppError.conflict("This return has not been forwarded to you yet", {
      code: "returns.not_forwarded",
      details: { returnId: input.returnId },
    });
  }

  if (input.response === "confirmed") {
    const row = await db.one<ReturnRow>(
      `update returns set artist_confirmed_at = coalesce(artist_confirmed_at, $2::timestamptz)
        where id = $1 returning ${COLUMNS}`,
      [input.returnId, now],
    );
    return { returnCase: toCase(row), notifications: [] };
  }

  // The status only moves to `disputed` when the money is still on the table.
  // Once a refund has been authorised the case is settled from the buyer's side,
  // and reopening it as a dispute would say otherwise -- the database refuses it
  // outright (`returns_refund_requires_gate`). What the artist gets instead is
  // `artist_damage_reported_at` and an escalation an admin picks up: a claim
  // against PACHKA, who had custody, not a question about the buyer's refund.
  const row = await db.one<ReturnRow>(
    `update returns
        set artist_damage_reported_at = coalesce(artist_damage_reported_at, $2::timestamptz),
            status = case
                       when refund_authorised_at is null
                            and status not in ('resolved_refunded', 'resolved_denied')
                       then 'disputed'
                       else status
                     end,
            escalated_at = coalesce(escalated_at, $2::timestamptz),
            escalation_reason = coalesce(escalation_reason, 'artist_reported_damage'),
            resolution_notes = $3
      where id = $1
      returning ${COLUMNS}`,
    [input.returnId, now, notes],
  );

  const returnCase = toCase(row);
  return {
    returnCase,
    notifications: [
      {
        audience: "admin",
        template: "returns.dispute_opened",
        data: {
          returnId: returnCase.id,
          orderId: returnCase.orderId,
          reason: "artist_reported_damage",
        },
      },
      {
        audience: "buyer",
        template: "returns.artist_reported_damage",
        recipientId: returnCase.buyerId,
        data: { returnId: returnCase.id, orderId: returnCase.orderId },
      },
    ],
  };
}

export interface SweepResult {
  readonly cases: readonly ReturnCase[];
  readonly notifications: readonly NotificationRequest[];
}

/**
 * Cases where nothing ever arrived.
 *
 * "WHEN a return is not confirmed received within the configured window after
 * the request THEN the system flags the case for admin review and does not
 * refund automatically." No refund is computed here and none is authorised --
 * the CHECK constraint would reject one anyway, since `unreceived` is not a
 * state the refund gate permits.
 */
export async function flagUnreceivedReturns(
  db: Sql,
  options: { readonly now?: Date } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();

  const { rows } = await db.query<ReturnRow>(
    `update returns
        set status = 'unreceived',
            escalated_at = coalesce(escalated_at, $1::timestamptz),
            escalation_reason = coalesce(escalation_reason, 'never_arrived')
      where status = 'requested' and received_at is null and receipt_deadline_at <= $1::timestamptz
      returning ${COLUMNS}`,
    [now],
  );

  const cases = rows.map(toCase);
  const notifications: NotificationRequest[] = [];
  for (const returnCase of cases) {
    notifications.push({
      audience: "admin",
      template: "returns.never_arrived",
      data: {
        returnId: returnCase.id,
        orderId: returnCase.orderId,
        requestedAt: returnCase.requestedAt.toISOString(),
      },
    });
    notifications.push({
      audience: "buyer",
      template: "returns.never_arrived",
      recipientId: returnCase.buyerId,
      data: { returnId: returnCase.id, orderId: returnCase.orderId },
    });
  }
  return { cases, notifications };
}

/**
 * Forwarded cases the artist has neither confirmed nor disputed in time.
 *
 * Escalates to an admin. The buyer's money is not involved -- it was released
 * at the operator's receipt -- which is precisely the property SECURITY.md
 * SPEC-E asks for: artist silence resolves an artist's claim, and can never
 * hold a buyer's refund.
 */
export async function escalateSilentArtists(
  db: Sql,
  options: { readonly now?: Date } = {},
): Promise<SweepResult> {
  const now = options.now ?? new Date();

  const { rows } = await db.query<ReturnRow>(
    `update returns
        set escalated_at = $1::timestamptz, escalation_reason = 'artist_silent'
      where forwarded_at is not null
        and artist_response_deadline_at <= $1::timestamptz
        and artist_confirmed_at is null
        and artist_damage_reported_at is null
        and escalated_at is null
      returning ${COLUMNS}`,
    [now],
  );

  const cases = rows.map(toCase);
  return {
    cases,
    notifications: cases.map((returnCase) => ({
      audience: "admin" as const,
      template: "returns.artist_silent",
      data: {
        returnId: returnCase.id,
        orderId: returnCase.orderId,
        artistId: returnCase.artistId,
      },
    })),
  };
}

export interface AdminResolutionInput {
  readonly returnId: string;
  readonly adminId: string;
  readonly outcome: "refund_buyer" | "deny_refund";
  readonly notes?: string;
  readonly now?: Date;
}

export interface AdminResolutionResult {
  readonly returnCase: ReturnCase;
  readonly refund: RefundFigures | null;
  readonly orderTransition: "returned" | null;
  readonly restoreInventory: boolean;
  readonly notifications: readonly NotificationRequest[];
}

/**
 * An admin resolves a disputed or never-arrived case.
 *
 * The admin may refund a case the operator recorded as damaged, and the
 * artwork still does not go back on sale: inventory is restored only when the
 * artwork came back intact ("Return restores inventory only when resolved in
 * the buyer's favour" -- read together with "the return completes with the
 * artwork intact"). The database enforces that independently; see
 * `returns_inventory_requires_intact`.
 */
export async function resolveReturnByAdmin(
  db: Sql,
  input: AdminResolutionInput,
): Promise<AdminResolutionResult> {
  const now = input.now ?? new Date();
  const notes = (input.notes ?? "").slice(0, 4000);

  const existing = await db.maybeOne<ReturnRow>(`select ${COLUMNS} from returns where id = $1`, [
    input.returnId,
  ]);
  if (!existing) {
    throw AppError.notFound("No such return", {
      code: "returns.not_found",
      details: { returnId: input.returnId },
    });
  }
  if (existing.status !== "disputed" && existing.status !== "unreceived") {
    throw AppError.conflict(
      `Only a disputed or unreceived return needs an admin resolution; this one is "${existing.status}"`,
      { code: "returns.not_disputed", details: { returnId: input.returnId, status: existing.status } },
    );
  }

  if (input.outcome === "deny_refund") {
    const row = await db.one<ReturnRow>(
      `update returns
          set status = 'resolved_denied', resolved_at = $2::timestamptz, resolved_by = $3,
              resolution_notes = $4
        where id = $1
        returning ${COLUMNS}`,
      [input.returnId, now, input.adminId, notes],
    );
    const returnCase = toCase(row);
    return {
      returnCase,
      refund: null,
      orderTransition: null,
      restoreInventory: false,
      notifications: [
        {
          audience: "buyer",
          template: "returns.resolved_denied",
          recipientId: returnCase.buyerId,
          data: { returnId: returnCase.id, orderId: returnCase.orderId },
        },
        {
          audience: "artist",
          template: "returns.resolved_denied",
          recipientId: returnCase.artistId,
          data: { returnId: returnCase.id, orderId: returnCase.orderId },
        },
      ],
    };
  }

  const { feeAgorot, refundAgorot } = await refundFor(db, existing);
  const intact = existing.received_condition === "intact";

  const row = await db.one<ReturnRow>(
    `update returns
        set status = 'resolved_refunded', resolved_at = $2::timestamptz, resolved_by = $3,
            resolution_notes = $4,
            cancellation_fee_agorot = $5::bigint,
            refund_amount_agorot = $6::bigint,
            refund_authorised_at = $2::timestamptz,
            inventory_restored_at = case when received_condition = 'intact'
                                         then coalesce(inventory_restored_at, $2::timestamptz)
                                         else inventory_restored_at end
      where id = $1
      returning ${COLUMNS}`,
    [input.returnId, now, input.adminId, notes, toDbValue(feeAgorot), toDbValue(refundAgorot)],
  );

  const returnCase = toCase(row);
  return {
    returnCase,
    refund: { feeAgorot, refundAgorot },
    orderTransition: intact ? "returned" : null,
    restoreInventory: intact,
    notifications: [
      {
        audience: "buyer",
        template: "returns.refund_issued",
        recipientId: returnCase.buyerId,
        data: {
          returnId: returnCase.id,
          orderId: returnCase.orderId,
          refundAgorot,
          cancellationFeeAgorot: feeAgorot,
        },
      },
      {
        audience: "artist",
        template: "returns.resolved_refunded",
        recipientId: returnCase.artistId,
        data: { returnId: returnCase.id, orderId: returnCase.orderId },
      },
    ],
  };
}

/**
 * Is this artwork held by a return that has not completed?
 *
 * `artworks` and `orders` ask before making an artwork purchasable again.
 * "A unique artwork under an unresolved return SHALL remain unavailable" --
 * and note that `resolved_denied` counts as resolved but does NOT restore the
 * artwork, because the artwork is with the buyer, not the artist. Only an
 * intact arrival puts it back on sale.
 */
export async function isArtworkHeldByOpenReturn(db: Sql, artworkId: string): Promise<boolean> {
  const row = await db.maybeOne<{ held: boolean }>(
    `select exists (
       select 1 from returns
        where artwork_id = $1
          and status in ('requested', 'disputed', 'unreceived')
     ) as held`,
    [artworkId],
  );
  return row?.held === true;
}
