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
import { signInAction } from "../actions";

export function SignInForm() {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-12 py-14">
      <SectionHeading as="h1">כניסה</SectionHeading>

      <AccountForm action={signInAction} submitLabel="כניסה">
        {(state) => (
          <>
            <Input
              label="כתובת אימייל"
              name="email"
              type="email"
              required
              autoComplete="email"
              error={state.fields?.email?.[0]}
            />
            <Input
              label="סיסמה"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              error={state.fields?.password?.[0]}
            />
          </>
        )}
      </AccountForm>

      <a href="/reset-password" className="text-[15px] text-ink-muted underline">
        שכחתם סיסמה?
      </a>
    </div>
  );
}
