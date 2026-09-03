/**
 * /admin/shipping — the rate table (task 8.1's route tail).
 *
 * The table is admin-editable "as configuration, no deployment needed", and the
 * module has had `readRateTable`, `listZones`, `listTiers` and `setRate` since
 * it shipped. What was missing was a screen. This route authorises, reads, and
 * renders a matrix; the single cell edit is `RateForm`.
 *
 * A missing cell shows as "—" and not as zero. `rateFor` treats an absent cell
 * as a conflict rather than a free delivery, and the screen has to agree with
 * it: a zero here would read as "shipping is free to Eilat" instead of "nobody
 * has set this yet".
 */
import { getDatabase } from "@/shared/db";
import { formatAgorot } from "@/shared/money";
import { Card, SectionHeading } from "@/shared/ui";
import { listTiers, listZones, readRateTable } from "@/modules/shipping";
import { currentUserId } from "../../_lib/viewer";
import { adminOrNotFound } from "../access";
import { RateForm } from "./RateForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "טבלת המשלוחים — פאצ׳קה" };

export default async function AdminShippingPage() {
  const db = getDatabase();
  await adminOrNotFound(db, await currentUserId());

  const [zones, tiers, rates] = await Promise.all([listZones(db), listTiers(db), readRateTable(db)]);

  const byCell = new Map(rates.map((rate) => [`${rate.zoneCode}:${rate.tierCode}`, rate] as const));

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-6 py-12 sm:px-12">
      <SectionHeading as="h1">טבלת המשלוחים</SectionHeading>

      <Card className="overflow-x-auto p-5">
        <table className="w-full border-collapse text-[15px]">
          <caption className="mb-3 text-start text-[13px] text-ink-muted">
            תעריף שטוח לכל אזור וגודל, בשקלים.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="border-b border-rule pb-2 text-start font-bold">
                אזור
              </th>
              {tiers.map((tier) => (
                <th
                  key={tier.code}
                  scope="col"
                  className="border-b border-rule pb-2 text-start font-bold"
                >
                  {tier.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zones.map((zone) => (
              <tr key={zone.code}>
                <th scope="row" className="border-b border-rule py-2 text-start font-medium">
                  {zone.displayName}
                </th>
                {tiers.map((tier) => {
                  const rate = byCell.get(`${zone.code}:${tier.code}`);
                  return (
                    <td key={tier.code} className="border-b border-rule py-2">
                      {rate === undefined ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <span className="numeric">{formatAgorot(rate.amountAgorot)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="max-w-[520px]">
        <RateForm
          zones={zones.map((zone) => ({ value: zone.code, label: zone.displayName }))}
          tiers={tiers.map((tier) => ({ value: tier.code, label: tier.displayName }))}
        />
      </div>
    </div>
  );
}
