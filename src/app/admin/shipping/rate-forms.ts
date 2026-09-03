/**
 * Editing one cell of the shipping rate table (task 8.1's route tail).
 *
 * `shipping`'s public API says exactly what a route owes it: "checking that the
 * caller is an admin... The route verifies the role against `user_roles` and
 * writes the `admin_audit` row." So this file does both, and does them in one
 * transaction — `withAdminAction` re-authorises inside the transaction, sets
 * the actor the audit trigger reads, and hands back the `Tx` that both the rate
 * write and the audit row run on. An action that succeeded unaudited, or an
 * audit row for a rate change that rolled back, are both impossible as a
 * result (SECURITY.md S1-14 item 3).
 *
 * `shipping` is not in `moderation`'s dependency table and does not import it;
 * the audit writer lives with the table it writes and other modules record
 * their admin actions by calling it on their own open transaction, which is
 * what ARCHITECTURE.md describes and what this does.
 *
 * The rate itself is `shipping.setRate`: it is the module's write path, it
 * refuses an unknown zone-and-tier pair with a not-found rather than creating
 * one, and it stores whole agorot.
 */
import type { Database } from "@/shared/db";
import { AppError } from "@/shared/errors";
import { formatAgorot, parseAgorot } from "@/shared/money";
import { recordAdminAction, requireAdmin, withAdminAction } from "@/modules/moderation";
import { setRate } from "@/modules/shipping";
import { text, toFormState, type FormState } from "../../_lib/form-state";

function required(form: FormData, field: string, message: string): string {
  const value = text(form, field).trim();
  if (value === "") {
    throw AppError.validation(message, {
      code: "admin.missing_field",
      fields: { [field]: [message] },
    });
  }
  return value;
}

export async function setRateFromForm(
  db: Database,
  actorId: string | null,
  form: FormData,
): Promise<FormState> {
  try {
    // Before the input is parsed, so every refusal of a non-admin is the same
    // not-found whatever was posted. See src/app/admin/queue-forms.ts.
    await requireAdmin(db, actorId);

    const zoneCode = required(form, "zoneCode", "יש לבחור אזור");
    const tierCode = required(form, "tierCode", "יש לבחור גודל");
    const amountRaw = required(form, "amountShekels", "יש להזין תעריף בשקלים");

    let amountAgorot: number;
    try {
      amountAgorot = parseAgorot(amountRaw, { allowNegative: false });
    } catch {
      throw AppError.validation("יש להזין תעריף תקין בשקלים", {
        code: "admin.unreadable_rate",
        fields: { amountShekels: ["יש להזין תעריף תקין בשקלים"] },
      });
    }

    const note = text(form, "note").trim();

    return await withAdminAction(db, actorId, async (tx) => {
      const entry = await setRate(tx, { zoneCode, tierCode, amountAgorot });

      await recordAdminAction(tx, {
        action: "rate_table_change",
        targetType: "shipping_rate",
        targetId: `${zoneCode}:${tierCode}`,
        ...(note === "" ? {} : { note }),
        details: {
          zone_code: zoneCode,
          tier_code: tierCode,
          amount_agorot: entry.amountAgorot,
        },
      });

      return {
        status: "ok" as const,
        message: `התעריף ל${zoneCode} · ${tierCode} עודכן ל-${formatAgorot(entry.amountAgorot)}.`,
      };
    });
  } catch (error) {
    return toFormState(error);
  }
}
