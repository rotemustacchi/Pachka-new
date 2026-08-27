import type { SVGProps } from "react";

/**
 * The two-brush-stroke logo mark from the approved mockups
 * (design/Main.dc.html, design/Catalog.dc.html header). Paths lifted
 * verbatim; colour comes from `currentColor` so callers control it with a
 * text-color utility (e.g. `text-ink`).
 */
export function LogoMark({
  width = 44,
  height = 28,
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 40"
      width={width}
      height={height}
      role="img"
      aria-label="פאצ׳קה"
      {...rest}
    >
      <path
        d="M8 34 C 13 20, 21 9, 29 9 C 35 9, 37 15, 33 20 C 29 25, 21 26, 15 25 C 21 30, 26 34, 30 38"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
      <path
        d="M61 14 C 57 8, 47 6, 42 12 C 35 20, 38 31, 47 32 C 53 32, 58 28, 60 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
