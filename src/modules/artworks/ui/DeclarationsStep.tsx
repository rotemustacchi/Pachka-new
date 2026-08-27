/**
 * The declarations step: originality, and the AI-assistance question.
 *
 * Two controls, and both of them are the point of the whole form.
 *
 * ORIGINALITY is a checkbox because it is an affirmation the artist makes, and
 * the server records who made it and when. The wording is the design's
 * (design/Upload.dc.html) and states both halves the spec requires -- that the
 * work is their own original creation, and that they hold the rights to it.
 *
 * AI ASSISTANCE is a pair of radio buttons, NOT a checkbox, and that is the
 * whole design decision. A checkbox has two states and the spec needs three:
 * yes, no, and "has not answered". An unticked checkbox is indistinguishable
 * from an unanswered question, so it would silently answer "no" on behalf of
 * every artist who never scrolled this far -- turning a disclosure the platform
 * stands behind into a default. Radios with no initial selection make "not
 * answered" a state the artist has to leave deliberately, which is what makes
 * the label on the card mean something.
 */
"use client";

export interface DeclarationsStepProps {
  readonly affirmsOriginality: boolean;
  readonly onOriginalityChange: (affirmed: boolean) => void;
  /** `null` is "not answered yet" and is the initial state. */
  readonly aiAssisted: boolean | null;
  readonly onAiAssistedChange: (answer: boolean) => void;
  readonly errors?: Readonly<Record<string, string>>;
}

const ORIGINALITY_TEXT =
  "אני מצהיר/ה שהיצירה היא יצירה מקורית שלי, ושזכויות היוצרים בה שייכות לי.";
const AI_QUESTION = "האם היצירה נוצרה בעזרת בינה מלאכותית באופן משמעותי?";

export function DeclarationsStep({
  affirmsOriginality,
  onOriginalityChange,
  aiAssisted,
  onAiAssistedChange,
  errors,
}: DeclarationsStepProps) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <label className="flex items-start gap-3 text-base text-ink">
          <input
            type="checkbox"
            checked={affirmsOriginality}
            onChange={(event) => onOriginalityChange(event.target.checked)}
            aria-describedby={errors?.["originality"] ? "originality-error" : undefined}
            className="mt-1"
          />
          <span>{ORIGINALITY_TEXT}</span>
        </label>
        {errors?.["originality"] ? (
          <p id="originality-error" className="text-xs text-alert">
            {errors["originality"]}
          </p>
        ) : null}
      </div>

      <fieldset
        aria-describedby={errors?.["aiAssisted"] ? "ai-assisted-error" : undefined}
        className="flex flex-col gap-3"
      >
        <legend className="text-base text-ink">{AI_QUESTION}</legend>
        <p className="text-xs text-ink-muted">חובה לענות. תשובה חיובית תופיע כתווית על היצירה.</p>

        <div className="flex flex-wrap gap-6">
          {/*
            `checked={aiAssisted === true}` and `=== false`, never a truthiness
            test: with `aiAssisted` null, both must be unchecked, and that is
            exactly the state the publish gate refuses.
          */}
          <label className="flex items-center gap-2 text-base text-ink">
            <input
              type="radio"
              name="ai-assisted"
              checked={aiAssisted === true}
              onChange={() => onAiAssistedChange(true)}
            />
            <span>כן</span>
          </label>
          <label className="flex items-center gap-2 text-base text-ink">
            <input
              type="radio"
              name="ai-assisted"
              checked={aiAssisted === false}
              onChange={() => onAiAssistedChange(false)}
            />
            <span>לא</span>
          </label>
        </div>

        {errors?.["aiAssisted"] ? (
          <p id="ai-assisted-error" className="text-xs text-alert">
            {errors["aiAssisted"]}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
