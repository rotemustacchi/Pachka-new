import type { ReactNode } from "react";

export type BadgeVariant = "tag" | "tag-selected" | "ai" | "sold";

export interface BadgeProps {
  readonly variant?: BadgeVariant;
  readonly children: ReactNode;
  readonly className?: string;
}

// Each of these is an exact treatment from design/Catalog.dc.html:
//  - tag / tag-selected: the style-filter `.tag` chip, unselected and selected.
//  - ai: the "נוצר בעזרת AI" corner label (absolute-positioned by the variant
//    itself, since every use of it in the mockup is a top-start corner label —
//    the parent just needs `position: relative`).
//  - sold: the "נמכר" pill. See `SoldOverlay` below for the dimmed-image
//    composition the mockup uses it in.
const VARIANT_STYLES: Record<BadgeVariant, string> = {
  tag: "inline-flex border border-rule bg-card px-3 py-[5px] text-[13px] text-ink",
  "tag-selected": "inline-flex border border-ink bg-ink px-3 py-[5px] text-[13px] text-paper",
  ai: "absolute top-3 start-3 border border-rule bg-paper-deep px-[9px] py-1 text-[11px] font-bold text-ink",
  sold: "inline-flex bg-ink px-[18px] py-2 text-[13px] font-bold text-paper",
};

export function Badge({ variant = "tag", children, className }: BadgeProps) {
  const classes = [VARIANT_STYLES[variant], className].filter(Boolean).join(" ");
  return <span className={classes}>{children}</span>;
}

export interface SoldOverlayProps {
  readonly children: ReactNode;
}

/**
 * The dimmed-card-plus-centered-pill treatment for a sold artwork
 * (design/Catalog.dc.html: opacity .65 on the card, "נמכר" centered over it).
 * Wrap whatever the card normally renders.
 */
export function SoldOverlay({ children }: SoldOverlayProps) {
  return (
    <div className="relative">
      <div className="opacity-65">{children}</div>
      <div className="absolute inset-0 flex items-center justify-center">
        <Badge variant="sold">נמכר</Badge>
      </div>
    </div>
  );
}
