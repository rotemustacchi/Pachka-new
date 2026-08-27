import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

// Exact colours, radius and padding lifted from the two buttons in
// design/Main.dc.html ("התחילו את ההתאמה" / "הצטרפו כאמן").
const BASE =
  "inline-flex items-center justify-center rounded-button text-base font-bold " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "border-0 bg-ink px-10 py-4 text-paper hover:bg-ink-soft",
  secondary: "border-[1.5px] border-ink bg-transparent px-[38px] py-[15px] text-ink hover:bg-paper-deep",
};

export function Button({
  variant = "primary",
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [BASE, VARIANT_STYLES[variant], className].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
