import type { SVGProps } from "react";

/**
 * The "PACHKA" wordmark, shipped as a vector asset rather than a webfont.
 *
 * design.md is explicit: the brush lettering is SVG, never a webfont, and
 * never used in Hebrew (the brush script has no Hebrew glyphs). The approved
 * mockups render this in the Google-fonts webfont "Caveat Brush" — that
 * dependency is deliberately dropped here in favour of a hand-built,
 * monoline brush-stroke logotype so the wordmark never depends on a font
 * being available and always renders pixel-identically. The word itself is
 * Latin and always reads left-to-right regardless of document direction.
 */
export function Wordmark({
  width,
  height = 24,
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 360 90"
      width={width}
      height={height}
      role="img"
      aria-label="PACHKA"
      {...rest}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* P */}
        <path d="M30 76 L30 14 C 30 11, 56 11, 56 29 C 56 45, 30 45, 28 43" />
        {/* A */}
        <path d="M75 76 L95 14 L115 76 M83 55 L107 55" />
        {/* C */}
        <path d="M172 24 C 150 8, 118 18, 122 47 C 126 76, 155 84, 172 68" />
        {/* H */}
        <path d="M190 14 L190 76 M225 14 L225 76 M190 45 L225 45" />
        {/* K */}
        <path d="M245 14 L245 76 M245 45 L276 14 M245 45 L280 76" />
        {/* A */}
        <path d="M300 76 L320 14 L340 76 M308 55 L332 55" />
      </g>
    </svg>
  );
}
