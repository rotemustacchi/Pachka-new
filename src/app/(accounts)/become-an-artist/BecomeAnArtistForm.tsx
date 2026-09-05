"use client";

/**
 * The form body, split out of the page as its own Client Component.
 *
 * `AccountForm` takes its children as a RENDER PROP so each field can read the
 * action state. A function cannot cross the server/client boundary, so a Server
 * Component page passing one fails to prerender and 500s at runtime — which is
 * exactly what `npm run build` was doing on all four accounts pages, invisibly,
 * because `npm run verify` does not run a build.
 *
 * The page stays a Server Component so it keeps `export const metadata`, and
 * this file carries the interactivity. Note what is still absent: no data row
 * is a prop here either, for the reason `AccountForm` documents — React
 * serialises a Client Component's whole prop object into the RSC payload.
 */
import { SectionHeading, Input } from "@/shared/ui";
import { AccountForm } from "../AccountForm";
import { upgradeToArtistAction } from "../actions";

export function BecomeAnArtistForm() {
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
