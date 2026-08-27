import type { ElementType, ReactNode } from "react";
import { BrushUnderline } from "@/assets";

export interface SectionHeadingProps {
  readonly children: ReactNode;
  /** @default "h2" */
  readonly as?: ElementType;
  readonly className?: string;
}

/**
 * A heading with the brush-stroke bar behind it (design/Main.dc.html, behind
 * "יצירות נבחרות"): the stroke sits behind the text at ~.12 opacity and
 * extends 10px past the text on the inline-start side. Built with logical
 * properties so the extension lands on the correct side in RTL without a
 * mirrored variant, and works at any text length since the stroke stretches
 * to the heading's own box.
 */
export function SectionHeading({ children, as: Tag = "h2", className }: SectionHeadingProps) {
  const wrapperClasses = ["relative inline-block", className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClasses}>
      <BrushUnderline
        className="absolute bottom-[2px] start-[-10px] h-5 text-ink opacity-[.12]"
        style={{ width: "calc(100% + 20px)" }}
      />
      <Tag className="relative m-0 text-[30px] font-black tracking-[-.01em] text-ink">{children}</Tag>
    </div>
  );
}
