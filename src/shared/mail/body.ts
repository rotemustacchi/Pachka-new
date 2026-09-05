/**
 * Hebrew, right to left, in an email client.
 *
 * PACHKA's audience is Israeli and every message this transport carries is
 * Hebrew. A Hebrew paragraph rendered without an explicit direction is not
 * merely ugly: a line that mixes Hebrew with a Latin order id or a URL — which
 * every transactional message here does — has its bidirectional runs reordered
 * by the client's own guess, and the guess differs between Gmail, Outlook and
 * Apple Mail. So the direction is stated, not inferred.
 *
 * TWO PARTS, AND WHY THE PLAIN ONE IS THE REAL ONE
 * ------------------------------------------------
 * `body` is authored as plain text by whoever composes the message, and the
 * HTML part is DERIVED from it here. That ordering is deliberate. It means a
 * message can never say one thing in HTML and another in text, which is how a
 * marketplace ends up with a payment instruction that only some recipients can
 * read. It also means there is no template language to learn, no partials, and
 * nothing to escape at a call site: `escapeHtml` runs over every line here.
 *
 * `text-align: right` rather than the logical `text-align: start`, and
 * `dir="rtl"` on the element rather than a stylesheet rule. Both are
 * concessions to email clients, which strip `<style>` blocks and support very
 * little CSS: Outlook's word-processor renderer has no support for logical
 * alignment at all. This is the one place in PACHKA where a physical direction
 * is the correct choice, and it is confined to this file.
 *
 * There is deliberately no image, no tracking pixel, no web font and no
 * external stylesheet. A transactional email that fetches a remote asset tells
 * its sender when it was opened, which is data PACHKA has no reason to collect.
 */

/** The five characters that can end an HTML context. Nothing else is escaped. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The plain-text body, as a minimal RTL HTML document.
 *
 * Blank-line-separated blocks become paragraphs; single newlines inside a block
 * become `<br>`, because a payment instruction's account line and reference line
 * are two lines of one thought and a paragraph break between them reads as two
 * unrelated facts.
 *
 * Inline styles only. Gmail strips `<style>` from the head, so a rule that lives
 * there is a rule that applies in the developer's browser and nowhere else.
 */
export function hebrewHtmlBody(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n").map((line) => escapeHtml(line.trim()));
      return `<p style="margin:0 0 1em">${lines.join("<br>")}</p>`;
    });

  // No <html>/<head>: providers wrap a fragment, and a partial document is a
  // more reliable thing to hand them than a full one they will rewrite.
  return [
    `<div dir="rtl" lang="he" style="direction:rtl;text-align:right;`,
    `font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.7;`,
    `color:#1a1a1a">`,
    paragraphs.join(""),
    `</div>`,
  ].join("");
}

/**
 * Join lines into a plain-text body.
 *
 * Trivial, and exported anyway so that every composer in this directory
 * produces the same trailing-whitespace-free shape and the tests can assert
 * against one.
 */
export function textBody(lines: readonly string[]): string {
  return lines.map((line) => line.trimEnd()).join("\n").trim();
}
