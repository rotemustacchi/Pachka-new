/**
 * The contact-detail scanner.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is a deterrent, not a boundary. SECURITY.md S2-19 is explicit about it
 * and so is this comment, because the difference decides how much weight other
 * code is allowed to put on it.
 *
 * An artist who is determined to publish their phone number will succeed. They
 * can paint it into the photograph, put a QR code in the corner of a canvas,
 * write "same handle as my name, on IG", spell the digits out in a way nobody
 * anticipated, or register a personal domain. A text scanner reads none of
 * that. Anyone who treats a green result from this function as proof that a
 * string is clean has misunderstood what it does.
 *
 * The enforcement that actually keeps transactions on the platform is
 * structural: there is no buyer-to-artist messaging channel, and PACHKA holds
 * the money. This function's job is narrower and still worth doing -- stop the
 * casual and the accidental, and make the deliberate case evidenced, because a
 * rejection an artist worked around is a rejection somebody can point at later.
 *
 * WHY IT NORMALISES FIRST
 * -----------------------
 * A plain regex over Hebrew right-to-left free text is defeated without
 * effort. `\d{10}` does not match a phone number with a right-to-left mark
 * between two digits, and that mark renders as nothing at all. In an RTL
 * application those characters are ordinary in real user input, so they cannot
 * simply be banned at the input layer. Same for Arabic-Indic digits, full-width
 * digits, Cyrillic letters that are pixel-identical to Latin ones, and
 * `yael [at] gmail [dot] com`.
 *
 * So every check runs against a normalised form: NFKC, control characters
 * stripped, digits folded to ASCII, homoglyphs folded to Latin, lower-cased.
 * The artist is always shown their original text -- the normalised form is an
 * internal artefact and displaying it would be baffling.
 */

/**
 * Bumped whenever the rules below change. Rows carrying an older version are
 * re-scanned by a backfill that FLAGS them for an operator rather than editing
 * or deleting what an artist wrote (SECURITY.md S2-19 item 4).
 */
export const SCANNER_VERSION = 1;

export type ContactFindingKind = "phone" | "email" | "social_handle" | "external_link";

export interface ContactFinding {
  readonly kind: ContactFindingKind;
  /**
   * The matched text, taken from the NORMALISED form. Useful in an operator's
   * queue and in tests. It is deliberately not shown to the artist: the
   * normalised form of their input is not something they wrote.
   */
  readonly match: string;
}

/**
 * Hosts an artist may legitimately link to. Everything else is treated as an
 * off-platform contact route, which is what a link in an artist biography
 * almost always is.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["pachka.co.il", "www.pachka.co.il"]);

/** Zero-width and bidirectional controls. Invisible, and therefore free evasion. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Letters that render as Latin but are not. Folding them means a handle spelled
 * with a Cyrillic `а` is the same string to us as one spelled with a Latin `a`.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c",
  т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ѡ: "w",
  // Greek
  α: "a", ε: "e", ι: "i", κ: "k", μ: "m", ν: "v", ο: "o", ρ: "p", τ: "t",
  υ: "u", χ: "x",
};

/**
 * Hebrew number words, so that a phone number written out in words is still a
 * phone number. Both the masculine and feminine forms, because both get used.
 */
const HEBREW_DIGITS: ReadonlyArray<readonly [string, string]> = [
  ["אפס", "0"],
  ["אחת", "1"], ["אחד", "1"],
  ["שתיים", "2"], ["שניים", "2"], ["שתים", "2"], ["שנים", "2"],
  ["שלוש", "3"], ["שלושה", "3"],
  ["ארבע", "4"], ["ארבעה", "4"],
  ["חמש", "5"], ["חמישה", "5"],
  ["שש", "6"], ["שישה", "6"],
  ["שבע", "7"], ["שבעה", "7"],
  ["שמונה", "8"],
  ["תשע", "9"], ["תשעה", "9"],
];

/** Messaging and link-in-bio hosts, named in SECURITY.md S2-19 item 3. */
const CONTACT_HOSTS = ["wa.me", "t.me", "instagram.com", "linktr.ee", "facebook.com", "tiktok.com"];

/**
 * NFKC, controls stripped, digits and homoglyphs folded, lower-cased.
 *
 * NFKC already folds full-width digits to ASCII. It does NOT fold Arabic-Indic
 * digits, so those are mapped explicitly.
 */
export function normaliseForScanning(text: string): string {
  const folded = text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();

  return [...folded].map((ch) => HOMOGLYPHS[ch] ?? ch).join("");
}

/**
 * Hebrew number words replaced by their digits.
 *
 * The lookbehind and lookahead are explicit Hebrew ranges rather than `\b`,
 * because `\b` in JavaScript is defined against ASCII word characters and does
 * nothing useful next to Hebrew letters.
 */
function foldHebrewNumberWords(text: string): string {
  let out = text;
  for (const [word, digit] of HEBREW_DIGITS) {
    out = out.replace(new RegExp(`(?<![א-ת])${word}(?![א-ת])`, "g"), digit);
  }
  return out;
}

/**
 * Undo the usual ways of writing an address without writing an address:
 * `[at]`, `(a)`, `-dot-`, and the Hebrew `שטרודל` / `נקודה`.
 *
 * Each replacement requires a separator or bracket on both sides, so the
 * English word "at" in an ordinary sentence is not rewritten unless it is
 * sitting where an `@` would sit. Even then nothing is reported unless the
 * result forms a complete address with a top-level domain.
 */
function deobfuscateAddresses(text: string): string {
  return text
    .replace(/[\s._\-]*[([{]\s*(?:at|a|שטרודל)\s*[)\]}][\s._\-]*/g, "@")
    .replace(/[\s._\-]+(?:at|שטרודל)[\s._\-]+/g, "@")
    .replace(/[\s._\-]*[([{]\s*(?:dot|נקודה)\s*[)\]}][\s._\-]*/g, ".")
    .replace(/[\s._\-]+(?:dot|נקודה)[\s._\-]+/g, ".")
    .replace(/\s*@\s*/g, "@")
    .replace(/\s*\.\s*/g, ".");
}

const EMAIL = /[a-z0-9!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/g;

/**
 * A pair of four-digit years joined by a dash: `2019-2021`.
 *
 * Without this exception the "eight or more digits" rule in SECURITY.md S2-19
 * item 3 rejects an artwork title containing a year range -- which the same
 * finding's own accept list requires to pass. A scanner that blocks legitimate
 * descriptions gets turned off, so the narrow exception is the safer rule.
 * `20192021` written as one token is still eight digits and still rejected.
 */
const YEAR_RANGE = /^(1[5-9]\d{2}|20\d{2})\s*[-–—]\s*(1[5-9]\d{2}|20\d{2})$/;

/** Digits possibly broken up by separators, the way phone numbers are written. */
const DIGIT_RUN = /\d[\d\s.\-–—_()[\]/]*\d/g;

function findPhones(normalised: string): ContactFinding[] {
  const candidates = foldHebrewNumberWords(normalised).match(DIGIT_RUN) ?? [];

  return candidates
    .filter((candidate) => {
      if (YEAR_RANGE.test(candidate.trim())) return false;
      return (candidate.match(/\d/g) ?? []).length >= 8;
    })
    .map((match) => ({ kind: "phone" as const, match: match.trim() }));
}

function findEmails(normalised: string): ContactFinding[] {
  const found = new Set<string>();
  for (const source of [normalised, deobfuscateAddresses(normalised)]) {
    for (const match of source.match(EMAIL) ?? []) found.add(match);
  }
  return [...found].map((match) => ({ kind: "email" as const, match }));
}

/** An `@handle` token that is not part of an address. */
const HANDLE = /(?:^|[\s([{"'׳״,:;])@([a-z0-9](?:[a-z0-9._]{1,29}))/g;

function findHandles(normalised: string): ContactFinding[] {
  const findings: ContactFinding[] = [];
  for (const match of normalised.matchAll(HANDLE)) {
    const handle = match[1]!;
    // `yael@gmail.com` is an address, and findEmails already has it. Reporting
    // it twice would just make the message to the artist noisier.
    if (/\.[a-z]{2,}$/.test(handle)) continue;
    findings.push({ kind: "social_handle", match: `@${handle}` });
  }
  return findings;
}

/**
 * A bare or schemed host. Deliberately matches without requiring `https://`,
 * because `wa.me/972501234567` is how such a link is actually written.
 */
const HOST = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/\S*)?/g;

function findLinks(normalised: string): ContactFinding[] {
  const findings: ContactFinding[] = [];
  const seen = new Set<string>();

  for (const match of normalised.matchAll(HOST)) {
    const host = match[1]!;
    // A host must end in something that looks like a top-level domain, or
    // `acrylic.oil` in a materials field becomes a link.
    if (!/\.[a-z]{2,}$/.test(host)) continue;
    if (ALLOWED_HOSTS.has(host)) continue;
    // Addresses are reported as addresses, not twice.
    if (new RegExp(`[a-z0-9._%+-]@${host.replace(/\./g, "\\.")}`).test(normalised)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    findings.push({ kind: "external_link", match: host });
  }

  return findings;
}

/**
 * Scan a piece of artist- or buyer-supplied free text.
 *
 * Returns every finding rather than the first, so an artist who has put both a
 * phone number and an Instagram handle in their biography is told about both
 * instead of discovering the second one on the next save.
 */
export function scanForContactDetails(text: string): ContactFinding[] {
  if (!text) return [];
  const normalised = normaliseForScanning(text);

  return [
    ...findEmails(normalised),
    ...findPhones(normalised),
    ...findHandles(normalised),
    ...findLinks(normalised),
  ];
}

/** Whether the text is free of anything the scanner recognises. */
export function containsContactDetails(text: string): boolean {
  return scanForContactDetails(text).length > 0;
}

const EXPLANATION: Readonly<Record<ContactFindingKind, string>> = {
  phone: "a phone number",
  email: "an email address",
  social_handle: "a social media handle",
  external_link: "a link to another site",
};

/**
 * A message for the artist explaining what was rejected and why.
 *
 * It names the kind of thing found and does not echo the text back. The artist
 * is looking at their original text in the form; quoting the normalised form
 * at them -- digits folded, homoglyphs replaced, separators collapsed -- would
 * show them something they did not write.
 */
export function explainFindings(findings: readonly ContactFinding[]): string {
  const kinds = [...new Set(findings.map((f) => f.kind))].map((k) => EXPLANATION[k]);
  const list =
    kinds.length <= 1
      ? (kinds[0] ?? "contact details")
      : `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}`;

  return (
    `This looks like it contains ${list}. ` +
    "PACHKA keeps conversations and payments on the platform, so contact details cannot appear " +
    "in public text. Please remove them and save again."
  );
}
