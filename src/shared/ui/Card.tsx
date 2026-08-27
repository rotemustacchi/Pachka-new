import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly children: ReactNode;
}

/** The elevated surface used for artwork tiles etc. (`.card` in the mockups: `--card` background, 1px `--rule` border). */
export function Card({ className, children, ...rest }: CardProps) {
  const classes = ["border border-rule bg-card", className].filter(Boolean).join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
