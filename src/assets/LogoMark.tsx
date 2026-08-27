import type { SVGProps } from "react";

/**
 * The PACHKA brush monogram — a rho-form "P" whose descender is crossed by a
 * long horizontal sweep, beside an open "C".
 *
 * PLACEHOLDER, traced by hand from the supplied brand renders.
 *
 * Every brand file supplied so far is a raster mockup photographed on paper,
 * so no vector of this mark exists and this only imitates it. Put the real
 * artwork in `design/brand/` and re-trace — see that folder's README.
 *
 * The thin strokes fanning off each terminal are the dry-bristle fray. They
 * are not decoration: the fray is most of what makes the original read as ink
 * rather than as a font, and dropping them makes the mark look like a
 * geometric logotype.
 *
 * Colour comes from `currentColor`, so callers set it with a text utility and
 * the mark follows the theme. Inline SVG, so it costs no network request and
 * stays crisp at any size.
 */
export function LogoMark({
  width = 64,
  height = 45,
  ...rest
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 1000 700"
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
      {/* P — one continuous stroke: tail, descender, then the bowl looping back. */}
      <path
        d="M285 640 C 310 520, 345 400, 372 310 C 400 205, 415 135, 470 112 C 545 80, 600 150, 570 228 C 540 305, 435 322, 378 282"
        strokeWidth="62"
      />
      {/* The long horizontal sweep crossing the descender. */}
      <path
        d="M18 268 C 110 250, 250 330, 380 348 C 440 356, 490 350, 525 330"
        strokeWidth="52"
      />

      {/* Dry-bristle fray — sweep, left terminal. */}
      <path d="M6 250 C 100 236, 190 280, 268 306" strokeWidth="8" />
      <path d="M10 282 C 108 268, 196 306, 274 330" strokeWidth="7" />
      <path d="M20 302 C 116 292, 200 324, 276 344" strokeWidth="6" />
      <path d="M34 318 C 126 312, 204 340, 278 356" strokeWidth="5" />

      {/* Dry-bristle fray — descender, bottom tail. */}
      <path d="M268 648 C 292 552, 318 456, 340 386" strokeWidth="8" />
      <path d="M300 660 C 322 560, 346 466, 366 396" strokeWidth="7" />
      <path d="M284 672 C 306 576, 330 486, 350 420" strokeWidth="6" />
      <path d="M316 640 C 336 552, 358 470, 376 408" strokeWidth="5" />

      {/* C. */}
      <path
        d="M905 96 C 862 40, 760 26, 690 84 C 596 162, 604 330, 704 380 C 800 428, 900 372, 934 288"
        strokeWidth="62"
      />
      {/* Dry-bristle fray — C, upper terminal. */}
      <path d="M930 74 C 900 34, 852 8, 806 2" strokeWidth="8" />
      <path d="M946 104 C 916 60, 866 30, 818 22" strokeWidth="7" />
      <path d="M956 132 C 928 86, 880 54, 832 44" strokeWidth="6" />
      {/* Dry-bristle fray — C, lower terminal. */}
      <path d="M952 268 C 946 330, 912 386, 862 418" strokeWidth="8" />
      <path d="M974 286 C 968 350, 932 406, 880 438" strokeWidth="7" />
      <path d="M986 314 C 980 372, 948 424, 900 454" strokeWidth="6" />
    </svg>
  );
}
