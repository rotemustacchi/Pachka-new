/**
 * /register — open self-service registration.
 *
 * accounts-and-profiles: any visitor may register with an email address and a
 * password, without operator approval. The account gets the `buyer` role and a
 * verification email.
 *
 * The success and duplicate-address cases produce the same banner, on purpose.
 */
import { SectionHeading, Input } from "@/shared/ui";
import { AccountForm } from "../AccountForm";
import { registerAction } from "../actions";

export const metadata = { title: "הרשמה — פאצ׳קה" };

export default function RegisterPage() {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-12 py-14">
      <SectionHeading as="h1">הרשמה</SectionHeading>

      <AccountForm action={registerAction} submitLabel="יצירת חשבון">
        {(state) => (
          <>
            <Input
              label="שם לתצוגה"
              name="displayName"
              required
              autoComplete="nickname"
              hint="השם שיוצג לצד ביקורות שתכתבו."
              error={state.fields?.displayName?.[0]}
            />
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
              autoComplete="new-password"
              hint="לפחות 10 תווים. משפט שקל לכם לזכור עדיף על צירוף סימנים."
              error={state.fields?.password?.[0]}
            />
          </>
        )}
      </AccountForm>
    </div>
  );
}
