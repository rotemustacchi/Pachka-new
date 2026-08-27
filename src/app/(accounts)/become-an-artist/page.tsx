/**
 * /become-an-artist — the buyer-to-artist upgrade.
 *
 * accounts-and-profiles: a signed-in buyer completes the artist profile form
 * and the account gains the `artist` role and access to artwork upload, with no
 * operator approval step.
 *
 * The form collects display name, biography, photo and city. It does not
 * collect a role, and the action does not accept one — see actions.ts.
 *
 * Contact details are collected separately, on the payout and shipping screens
 * that other modules own, and land in `artist_contact_details`. They are never
 * typed into this form, because everything on this form is published.
 */
import { SectionHeading, Input } from "@/shared/ui";
import { AccountForm } from "../AccountForm";
import { upgradeToArtistAction } from "../actions";

export const metadata = { title: "הצטרפות כאמן — פאצ׳קה" };

export default function BecomeAnArtistPage() {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-12 py-14">
      <SectionHeading as="h1">הצטרפות כאמן</SectionHeading>

      <p className="m-0 max-w-[760px] text-[17px] font-light leading-[1.75] text-ink-soft">
        הפרופיל הזה מוצג לקונים. אל תכתבו בו טלפון, אימייל או שם משתמש ברשתות —
        אנחנו חוסמים את זה בשמירה, וכל השיחות והתשלומים עוברים דרך פאצ׳קה.
      </p>

      <AccountForm action={upgradeToArtistAction} submitLabel="פרסום הפרופיל">
        {(state) => (
          <>
            <Input
              label="שם אמן לתצוגה"
              name="displayName"
              required
              error={state.fields?.displayName?.[0]}
            />
            <Input
              label="עיר"
              name="city"
              hint="עיר בלבד — לא כתובת."
              error={state.fields?.city?.[0]}
            />
            <Input
              label="קישור לתמונת פרופיל"
              name="avatarPath"
              error={state.fields?.avatarPath?.[0]}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="biography" className="text-sm font-medium text-ink-soft">
                קצת עליכם
              </label>
              <textarea
                id="biography"
                name="biography"
                rows={6}
                maxLength={2000}
                className={[
                  "rounded-button border bg-card px-3 py-2 text-base text-ink",
                  "focus:outline-none focus:ring-2 focus:ring-ink",
                  state.fields?.biography ? "border-alert" : "border-rule",
                ].join(" ")}
                aria-describedby={state.fields?.biography ? "biography-error" : undefined}
              />
              {state.fields?.biography ? (
                <p id="biography-error" className="m-0 text-sm text-alert">
                  {state.fields.biography[0]}
                </p>
              ) : null}
            </div>
          </>
        )}
      </AccountForm>
    </div>
  );
}
