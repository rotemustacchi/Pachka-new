/**
 * The AI-assistance label.
 *
 * artwork-listings: where an artist declares substantial generative AI
 * assistance, "a visible label SHALL appear on the artwork card and detail
 * page". This is that label, in one component, used on both -- so the two
 * surfaces cannot end up disclosing different things after a copy edit.
 *
 * The text comes from `AI_ASSISTED_LABEL` rather than being written here, and
 * the visual treatment is the shared `Badge`'s `ai` variant, which is already
 * the exact corner label from design/Catalog.dc.html. Neither is restated.
 *
 * `showsAiAssistedLabel` is what decides. It answers false for both `false` and
 * `null`, and that is safe ONLY because an unanswered question blocks
 * publication -- a published artwork always carries a real answer. The gate is
 * what makes the label trustworthy; without it, "no label" would mean "either
 * no AI, or nobody asked".
 */
import { Badge } from "@/shared/ui";
import { AI_ASSISTED_LABEL, showsAiAssistedLabel } from "../serialize";

export interface AiAssistedLabelProps {
  /** The artist's declaration. `null` cannot occur on a published artwork. */
  readonly aiAssisted: boolean | null;
}

/**
 * The corner label for an artwork card.
 *
 * Renders nothing at all when no AI assistance was declared -- not an empty
 * span, so a card without the disclosure has no stray element for a stylesheet
 * to give a border to.
 */
export function AiAssistedLabel({ aiAssisted }: AiAssistedLabelProps) {
  if (!showsAiAssistedLabel(aiAssisted)) return null;
  return <Badge variant="ai">{AI_ASSISTED_LABEL}</Badge>;
}
