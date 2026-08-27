/**
 * The return terms, shown before purchase.
 *
 * `shipping-and-returns`: "The system SHALL display the return terms --
 * including who bears return shipping and transit risk -- on the artwork page
 * and at checkout, before purchase." Before, not after: a buyer who discovers
 * on the cancellation screen that the return postage is theirs has been told
 * too late, and under Israeli distance-selling law that is a disclosure
 * failure, not a UX complaint.
 *
 * This returns the terms as data. The artwork page belongs to `catalog` and the
 * checkout summary to `orders`; both render this rather than writing their own
 * wording, so the two screens cannot drift apart or from the configured window.
 */
import { getConfig } from "@/shared/config";
import type { Sql } from "@/shared/db";

export interface ReturnTermStatement {
  /** Stable identifier a test can assert on without depending on wording. */
  readonly code: string;
  readonly text: string;
}

export interface ReturnTerms {
  /** Calendar days from delivery, per Israeli distance-selling law. */
  readonly windowDays: number;
  readonly returnShippingPaidBy: "buyer";
  readonly transitRiskBorneBy: "buyer";
  /** Fraction of the item subtotal. Bounded at the statutory maximum by `shared/config`. */
  readonly cancellationFeeRate: number;
  /** Returns go to PACHKA, never to the artist. */
  readonly returnsRouteTo: "pachka";
  readonly breakageInsuranceOffered: false;
  readonly statements: readonly ReturnTermStatement[];
}

export async function returnTerms(db: Sql): Promise<ReturnTerms> {
  const windowDays = await getConfig(db, "returns.window_days");
  const cancellationFeeRate = await getConfig(db, "returns.cancellation_fee_rate");
  const feePercent = Math.round(cancellationFeeRate * 1000) / 10;

  const statements: ReturnTermStatement[] = [
    {
      code: "window",
      text: `ניתן לבטל עסקה ולהחזיר את היצירה תוך ${windowDays} ימים מיום קבלתה.`,
    },
    {
      code: "return_shipping_paid_by_buyer",
      text: "עלות משלוח ההחזרה חלה על הקונה.",
    },
    {
      code: "transit_risk_on_buyer",
      text: "האחריות לנזק שייגרם ליצירה במשלוח ההחזרה חלה על הקונה.",
    },
    {
      code: "returns_route_to_pachka",
      text: "ההחזרה נשלחת לכתובת ההחזרות של PACHKA, ולא לאמן. הכתובת המלאה נמסרת עם אישור בקשת ההחזרה.",
    },
    {
      code: "refund_on_intact_receipt",
      text: "הזיכוי מבוצע לאחר שנציג PACHKA מאשר את קבלת היצירה במצבה המקורי.",
    },
    {
      code: "no_breakage_insurance",
      text: "אין ביטוח שבר בפלטפורמה.",
    },
  ];

  if (cancellationFeeRate > 0) {
    statements.push({
      code: "cancellation_fee",
      text: `מהזיכוי עשויים להיגרע דמי ביטול בשיעור של עד ${feePercent}% ממחיר היצירה.`,
    });
  }

  return {
    windowDays,
    returnShippingPaidBy: "buyer",
    transitRiskBorneBy: "buyer",
    cancellationFeeRate,
    returnsRouteTo: "pachka",
    breakageInsuranceOffered: false,
    statements,
  };
}
