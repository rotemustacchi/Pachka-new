/**
 * A status pill, built on the design system's `Badge` rather than beside it.
 *
 * `shared/ui`'s `Badge` owns the chip treatment from the approved mockups. This
 * maps an order's tone onto the variants that exist instead of introducing a
 * second chip style, which is how a design system quietly acquires four
 * near-identical pills.
 */
import { Badge } from "@/shared/ui";
import type { StatusTone } from "./status";

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly label: string;
}

/**
 * `attention` takes the filled treatment — the same one the catalog uses for a
 * selected filter — because it is the one state where the person reading has
 * something to do. Everything else takes the outlined chip, so a screen full of
 * ordinary progress does not shout.
 */
const TONE_VARIANT: Record<StatusTone, "tag" | "tag-selected"> = {
  attention: "tag-selected",
  progress: "tag",
  done: "tag",
  ended: "tag",
};

export function StatusBadge({ tone, label }: StatusBadgeProps) {
  return (
    <Badge
      variant={TONE_VARIANT[tone]}
      // Ended states are legible but recede: a cancelled order is still on the
      // screen and should not compete with a live one.
      className={tone === "ended" ? "opacity-70" : undefined}
    >
      {label}
    </Badge>
  );
}
