import type { SVGProps } from "react";

/**
 * The PACHKA brush monogram: a rho-form "P" — round bowl, single descender,
 * and a long horizontal sweep crossing it — followed by an open "C".
 *
 * PLACEHOLDER. The supplied brand files are raster mockups on a paper
 * background, so the real mark has never been exported as SVG. This is a
 * trace, not the asset. Replace it with the designer's export before launch;
 * see OPEN-QUESTIONS.md.
 *
 * An earlier version lifted the paths from design/Main.dc.html, where the
 * first stroke ended in a leg kicking down to the right. That reads as "R",
 * not "P". The leg is gone.
 */
export function LogoMark({
  width = 52,
  height = 30,
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 120 62"
      width={width}
      height={height}
      role="img"
      aria-label="פאצ׳קה"
      fill="none"
      stroke="currentColor"
      strokeWidth="7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {/* Bowl of the P, closing back onto the stem rather than kicking out a leg. */}
      <path d="M40 34 C 39 20, 47 12, 57 13 C 68 14, 73 24, 67 32 C 61 40, 48 40, 41 35" />
      {/* Single descender, tapering away to the lower left. */}
      <path d="M43 24 C 41 36, 38 47, 33 57" strokeWidth="6" />
      {/* The long horizontal brush sweep that crosses the descender. */}
      <path d="M8 33 C 20 28, 32 35, 46 30" strokeWidth="6" />
      {/* Open C. */}
      <path d="M113 22 C 107 12, 93 9, 84 17 C 74 26, 77 43, 89 45 C 99 47, 108 41, 112 34" />
    </svg>
  );
}
