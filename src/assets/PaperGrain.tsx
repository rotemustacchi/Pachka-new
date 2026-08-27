"use client";

import { useId } from "react";

/**
 * The paper-grain texture overlay (design/Main.dc.html, `.grain`). One
 * reusable asset applied once at the layout level — design.md: "one small
 * asset, no per-element texture".
 *
 * It is `position: fixed` with no explicit `z-index`, and every other layout
 * element is left un-positioned (normal flow). Under CSS stacking rules,
 * positioned elements with an auto z-index paint after in-flow content
 * regardless of source order, so this naturally sits visually on top and
 * `mix-blend-mode: multiply` can do its job — exactly how the approved
 * mockup relies on it, just without an explicit z-index arms race.
 */
export function PaperGrain() {
  const filterId = useId();
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none fixed inset-0 h-full w-full mix-blend-multiply"
    >
      <filter id={filterId}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={3} />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter={`url(#${filterId})`} opacity="0.055" />
    </svg>
  );
}
