import Link from "next/link";
import { confirmNotifyRequest } from "@/modules/matchmaker";
import { getDatabase } from "@/shared/db";
import { SectionHeading } from "@/shared/ui";

export const metadata = { title: "אישור הרשמה לעדכונים — פאצ׳קה" };

/**
 * The destination of the link in the confirmation email.
 *
 * Without this route the whole notify-me feature was inert: capture writes an
 * unconfirmed row, double opt-in means only a confirmed row may ever be
 * mailed, and the link in the email 404'd — so no subscription could become
 * mailable no matter how well the transport worked.
 *
 * `confirmNotifyRequest` is idempotent and says nothing about whether the
 * token matched. That is deliberate and this page keeps it: a page that
 * distinguished "confirmed" from "no such token" would let anyone test tokens,
 * and the tokens are the only thing protecting an address.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await confirmNotifyRequest(getDatabase(), token);

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-12 py-14">
      <SectionHeading as="h1">ההרשמה אושרה</SectionHeading>
      <p className="m-0 text-[17px] font-light leading-[1.75] text-ink-soft">
        נעדכן אתכם כשיעלו יצירות שמתאימות למה שחיפשתם. אפשר להסיר את ההרשמה
        בכל רגע — הקישור נמצא בתחתית כל הודעה שנשלח.
      </p>
      <div className="flex flex-wrap gap-4">
        <Link href="/catalog" className="border-0 bg-ink px-9 py-4 text-[16px] font-bold text-paper">
          לקטלוג
        </Link>
        <Link href="/match" className="border border-ink px-8 py-[15px] text-[15px] font-bold text-ink">
          להתאמה חדשה
        </Link>
      </div>
    </div>
  );
}
