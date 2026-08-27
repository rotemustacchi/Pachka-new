import type { SVGProps } from "react";

/**
 * The PACHKA brush monogram — a rho-form "P" whose stem is crossed by a long
 * horizontal sweep, beside an open "C".
 *
 * PLACEHOLDER, traced by hand from the supplied brand renders. Those renders
 * are raster mockups photographed on paper, so the mark has never existed as
 * a vector and this is an imitation of it, not the asset. Replace it with the
 * designer's SVG export before launch — see OPEN-QUESTIONS.md.
 *
 * The brush terminals are drawn as a few thin strokes fanning off each stroke
 * end, because the dry-bristle fray is most of what makes the original read
 * as ink rather than as a font.
 *
 * Colour comes from `currentColor`, so callers set it with a text utility.
 */
export function LogoMark({
  width = 58,
  height = 39,
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 300 200"
      width={width}
      height={height}
      role="img"
      aria-label="פאצ׳קה"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {/* P — one continuous stroke: tail, stem, then the bowl looping back. */}
      <path
        d="M84 188 C 92 148, 99 112, 104 82 C 110 44, 130 24, 152 29 C 173 34, 179 62, 160 78 C 141 95, 114 92, 102 80"
        strokeWidth="19"
      />
      {/* The horizontal sweep crossing the stem. */}
      <path d="M28 106 C 52 94, 78 104, 120 90" strokeWidth="16" />

      {/* Dry-bristle fray: sweep, left terminal. */}
      <path d="M20 100 C 40 92, 60 96, 76 96" strokeWidth="2.6" />
      <path d="M22 112 C 44 104, 62 108, 80 106" strokeWidth="2.2" />
      <path d="M26 118 C 48 112, 64 114, 78 113" strokeWidth="1.8" />

      {/* Dry-bristle fray: stem, bottom terminal. */}
      <path d="M79 186 C 84 158, 89 132, 93 112" strokeWidth="2.6" />
      <path d="M91 190 C 95 162, 99 138, 102 118" strokeWidth="2.2" />
      <path d="M86 196 C 90 170, 94 146, 97 124" strokeWidth="1.8" />

      {/* C. */}
      <path
        d="M263 44 C 250 20, 211 11, 186 31 C 153 57, 157 112, 193 123 C 226 133, 257 114, 267 91"
        strokeWidth="19"
      />
      {/* Dry-bristle fray: C, both open terminals. */}
      <path d="M272 38 C 262 22, 244 12, 228 9" strokeWidth="2.6" />
      <path d="M276 48 C 266 30, 248 19, 232 15" strokeWidth="2.2" />
      <path d="M276 86 C 270 104, 256 118, 242 125" strokeWidth="2.6" />
      <path d="M281 94 C 275 112, 261 126, 246 132" strokeWidth="2.2" />
    </svg>
  );
}
