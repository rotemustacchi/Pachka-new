/**
 * What the certificate actually asserts — and, more importantly, what it does
 * not.
 *
 * THIS FILE IS THE LIABILITY BOUNDARY. Read it before changing a word of it.
 *
 * PACHKA has never seen the object. It has not held the canvas, not met the
 * artist, not traced the provenance. A "Certificate of Authenticity" issued by
 * a party in that position, with no statement of its own limits, is a
 * misrepresentation with the platform's name on it — and the buyer is the party
 * who would discover that at resale, years later, when it matters most.
 *
 * So `authenticity-certificate` requires: "Every certificate SHALL carry
 * explicit text stating that its contents reflect the declaration made by the
 * artist and that PACHKA has not independently verified the authenticity,
 * provenance, or originality of the artwork."
 *
 * Two consequences for how this is written:
 *
 * 1. **It is not a disclaimer to bury.** It is not small print, not a footnote,
 *    not collapsed behind "details". `CertificateDocument` renders it as a
 *    titled section of the document body, at full size. If a redesign ever
 *    makes it visually secondary, the redesign is wrong.
 *
 * 2. **It is versioned.** `DECLARATION_VERSION` is written onto every
 *    certificate row at issue. When this wording is next revised — and it will
 *    be, because it is the sort of text lawyers revise — "what did the
 *    certificate issued in March actually say" stays answerable. A document
 *    whose terms can be rewritten retroactively is not a document.
 *
 * The AI line is part of the same declaration, not a separate warning. Where
 * the artist declared generative AI assistance the certificate states it,
 * because a buyer's understanding of what they own depends on it, and because
 * the artwork's own listing already said so — a certificate that quietly
 * dropped the disclosure would contradict the page the buyer bought from.
 */

/**
 * The revision of the wording below.
 *
 * Bump this — and only this — when any string in this file changes. Existing
 * rows keep the version they were issued under; nothing is backfilled, which is
 * the point.
 */
export const DECLARATION_VERSION = "2026-09-a";

/**
 * The sentence that makes the whole document honest.
 *
 * Three claims are disclaimed by name because the spec names three:
 * authenticity, provenance, originality. A general "PACHKA is not responsible"
 * would cover none of them precisely enough to be useful to a buyer.
 */
export const ARTIST_DECLARATION_STATEMENT =
  "תוכן תעודה זו מבוסס כולו על ההצהרה שמסר/ה האמן/ית. " +
  "PACHKA לא אימתה באופן עצמאי את האותנטיות, המקוריות או מקור היצירה, " +
  "ולא בדקה את היצירה עצמה.";

/** The heading that section is rendered under. */
export const ARTIST_DECLARATION_HEADING = "הצהרת האמן/ית";

/**
 * Stated only where the artist declared AI assistance
 * (`authenticity-certificate`, *AI-assisted work*).
 *
 * Deliberately phrased as a report of what the artist declared, not as a
 * finding of PACHKA's: the platform is in no position to detect generative AI
 * assistance, and wording that implied otherwise would be the same
 * over-claiming this file exists to prevent.
 */
export const AI_ASSISTANCE_STATEMENT =
  "האמן/ית הצהיר/ה כי בתהליך יצירת העבודה נעשה שימוש בסיוע של בינה מלאכותית גנרטיבית.";

/** How a one-of-a-kind piece is described (`authenticity-certificate`). */
export const UNIQUE_WORK_STATEMENT = "יצירה יחידה במינה";

/** How a numbered edition is described: "עותק 3 מתוך 10". */
export function editionStatement(position: number, size: number): string {
  return `עותק ${position} מתוך ${size}`;
}

/** The document's own title. */
export const CERTIFICATE_TITLE = "תעודת מקוריות";

/**
 * Shown on a certificate whose sale was reversed by a completed return.
 *
 * The certificate is not deleted and not edited; this is what the derived
 * validity renders as. A buyer at resale needs to be able to tell a void
 * certificate from one that was never issued, and silence cannot do that.
 */
export const VOID_STATEMENT =
  "תעודה זו בוטלה: המכירה שבגינה הונפקה הוחזרה והושבה.";

/** Shown on a certificate whose sale stands. */
export const VALID_STATEMENT = "תעודה זו תקפה.";

/**
 * Every sentence that must appear on a certificate, assembled.
 *
 * Returned as a list rather than a paragraph so the renderer cannot decide to
 * show some of them and not others, and so the tests can assert on the same
 * values the document is built from rather than on a copy of the prose.
 */
export function declarationStatements(input: {
  readonly aiAssisted: boolean;
}): readonly string[] {
  const statements = [ARTIST_DECLARATION_STATEMENT];
  if (input.aiAssisted) statements.push(AI_ASSISTANCE_STATEMENT);
  return statements;
}
