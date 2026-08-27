/**
 * /sign-in.
 *
 * A failed sign-in says one thing for a wrong password and for an address with
 * no account. The difference between them is an enumeration oracle, and
 * registration went to some trouble to close it on the other endpoint.
 */
import { SectionHeading, Input } from "@/shared/ui";
import { AccountForm } from "../AccountForm";
import { signInAction } from "../actions";

export const metadata = { title: "כניסה — פאצ׳קה" };

export default function SignInPage() {
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
