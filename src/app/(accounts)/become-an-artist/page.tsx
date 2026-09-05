import Link from "next/link";
import { SectionHeading } from "@/shared/ui";
import { hasRole } from "@/modules/accounts";
import { getDatabase } from "@/shared/db";
import { currentUserId } from "../deps";
import { BecomeAnArtistForm } from "./BecomeAnArtistForm";

export const metadata = { title: "הצטרפות כאמן — פאצ׳קה" };

/**
 * Becoming an artist is an UPGRADE to an account, not a way to create one.
 *
 * `upgradeToArtist` takes the user id from the session, so a signed-out
 * visitor could never have completed this — but the page used to render the
 * whole form to them anyway and refuse only on submit, after they had typed a
 * display name, a city and a biography. The header links here from every page,
 * so that was the common path, not an edge case.
 *
 * The three states are now decided before anything is rendered: sign in first,
 * fill in the profile, or you already have one.
 */
export default async function Page() {
  const userId = await currentUserId();

  if (userId === null) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-12 py-14">
        <SectionHeading as="h1">הצטרפות כאמן</SectionHeading>
        <p className="m-0 text-[17px] font-light leading-[1.75] text-ink-soft">
          פרופיל האמן נוסף לחשבון קיים בפאצ׳קה — הוא לא חשבון נפרד. כדי להמשיך,
          התחברו לחשבון שלכם או פתחו אחד, ואז חזרו לכאן כדי למלא את הפרופיל.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/sign-in"
            className="border-0 bg-ink px-9 py-4 text-[16px] font-bold text-paper"
          >
            כניסה לחשבון קיים
          </Link>
          <Link
            href="/register"
            className="border border-ink px-8 py-[15px] text-[15px] font-bold text-ink"
          >
            פתיחת חשבון חדש
          </Link>
        </div>
        <p className="m-0 text-[14px] text-ink-muted">
          פתיחת החשבון לא עולה כלום, ואפשר להצטרף כאמן מיד אחריה.
        </p>
      </div>
    );
  }

  if (await hasRole(getDatabase(), userId, "artist")) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-12 py-14">
        <SectionHeading as="h1">כבר יש לכם פרופיל אמן</SectionHeading>
        <p className="m-0 text-[17px] font-light leading-[1.75] text-ink-soft">
          החשבון הזה כבר רשום כאמן. אפשר לערוך את הפרופיל ולהעלות יצירות מהסטודיו.
        </p>
        <div>
          <Link
            href="/studio"
            className="border-0 bg-ink px-9 py-4 text-[16px] font-bold text-paper"
          >
            לסטודיו שלי
          </Link>
        </div>
      </div>
    );
  }

  return <BecomeAnArtistForm />;
}
