import type { SVGProps } from "react";

/**
 * The brush-stroke bar behind section headings (design/Main.dc.html, behind
 * "יצירות נבחרות"). Path lifted verbatim. Consumers position it with
 * `preserveAspectRatio="none"` already applied here, so it stretches to fill
 * whatever box it's given — see `SectionHeading`.
 */
export function BrushUnderline(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 220 40" preserveAspectRatio="none" aria-hidden="true" {...props}>
      <path
        d="M0 8 C 50 3, 110 14, 160 7 C 190 3, 205 11, 220 6 L 220 34 C 205 39, 190 31, 160 36 C 110 43, 50 32, 0 38 Z"
        fill="currentColor"
      />
    </svg>
  );
}
