"use client";

/**
 * Setting one zone x tier rate.
 *
 * One form rather than a grid of inputs: the table is a matrix an admin READS
 * and a cell they occasionally CHANGE, and a page that posts forty cells at
 * once turns a typo in one of them into forty audit rows. The zone and tier
 * lists come from the module, so a cell that does not exist cannot be chosen —
 * and `setRate` refuses an unknown pair anyway rather than creating one.
 */
import { Input, Select, type SelectOption } from "@/shared/ui";
import { TextArea } from "../../_lib/TextArea";
import { AdminForm } from "../AdminForm";
import { setRateAction } from "./actions";

export interface RateFormProps {
  readonly zones: readonly SelectOption[];
  readonly tiers: readonly SelectOption[];
}

export function RateForm({ zones, tiers }: RateFormProps) {
  return (
    <AdminForm
      action={setRateAction}
      title="עדכון תעריף"
      description="התעריף שטוח לכל שילוב של אזור וגודל. אין קריאה לחברת שילוח."
      submitLabel="שמירת התעריף"
    >
      {(state) => (
        <>
          <Select label="אזור" name="zoneCode" options={zones} error={state.fields?.zoneCode?.[0]} />
          <Select label="גודל" name="tierCode" options={tiers} error={state.fields?.tierCode?.[0]} />
          <Input
            label="תעריף (₪)"
            name="amountShekels"
            inputMode="decimal"
            required
            error={state.fields?.amountShekels?.[0]}
          />
          <TextArea label="הערה לתיעוד" name="note" rows={2} />
        </>
      )}
    </AdminForm>
  );
}
