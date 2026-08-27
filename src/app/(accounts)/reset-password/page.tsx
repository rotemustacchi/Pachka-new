/**
 * /reset-password.
 *
 * Says the same sentence for a registered and an unregistered address
 * (SECURITY.md S2-26 item 3, which groups password reset with registration for
 * exactly this reason — it is the easier of the two to forget).
 */
import { SectionHeading, Input } from "@/shared/ui";
import { AccountForm } from "../AccountForm";
import { passwordResetAction } from "../actions";

export const metadata = { title: "איפוס סיסמה — פאצ׳קה" };

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-12 py-14">
      <SectionHeading as="h1">איפוס סיסמה</SectionHeading>

      <AccountForm action={passwordResetAction} submitLabel="שליחת קישור">
        {(state) => (
          <Input
            label="כתובת אימייל"
            name="email"
            type="email"
            required
            autoComplete="email"
            error={state.fields?.email?.[0]}
          />
        )}
      </AccountForm>
    </div>
  );
}
