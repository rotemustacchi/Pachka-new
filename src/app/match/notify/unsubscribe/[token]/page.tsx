import Link from "next/link";
import { unsubscribeNotifyRequest } from "@/modules/matchmaker";
import { getDatabase } from "@/shared/db";
import { SectionHeading } from "@/shared/ui";

export const metadata = { title: "הסרה מרשימת העדכונים — פאצ׳קה" };

/**
 * The unsubscribe link every notification carries.
 *
 * Reachable without an account and without confirming anything else: an
 * unsubscribe that asks the reader to sign in first is not an unsubscribe.
 *
 * Like confirm, this says the same thing whether or not the token matched.
 * Reporting "no such subscription" would turn the page into an oracle for
 * testing tokens.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await unsubscribeNotifyRequest(getDatabase(), token);

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-12 py-14">
      <SectionHeading as="h1">הוסרתם מרשימת העדכונים</SectionHeading>
      <p className="m-0 text-[17px] font-light leading-[1.75] text-ink-soft">
        לא נשלח אליכם עוד הודעות על התאמות. הכתובת נמחקה מהרשימה, לא רק סומנה.
      </p>
      <div>
        <Link href="/" className="border border-ink px-8 py-[15px] text-[15px] font-bold text-ink">
          לעמוד הבית
        </Link>
      </div>
    </div>
  );
}
