/**
 * The scanner's evasion suite.
 *
 * Every rejection case named in SECURITY.md S2-19 is here, and so is the
 * accept list -- which matters just as much. A scanner that blocks a legitimate
 * artwork description gets switched off by the first operator who has to field
 * the complaint, and then it protects nothing at all. The false-positive tests
 * are what keep it switched on.
 */
import { describe, expect, it } from "vitest";
import {
  SCANNER_VERSION,
  containsContactDetails,
  explainFindings,
  normaliseForScanning,
  scanForContactDetails,
} from "./contact-scanner";

/** `050-123-4567`, with a right-to-left mark and a zero-width space woven in. */
const INVISIBLE_PHONE = "05‏0-12​3-45‏67";
/** The same digits in Arabic-Indic numerals. */
const ARABIC_INDIC_PHONE = "٠٥٠١٢٣٤٥٦٧";
/** The same digits, full-width. */
const FULLWIDTH_PHONE = "０５０１２３４５６７";
/** The same digits spelled out in Hebrew words. */
const HEBREW_WORD_PHONE = "אפס חמש אפס אחת שתיים שלוש ארבע חמש שש שבע";
/** `yael@gmail.com` with Cyrillic `у` and `а`. Pixel-identical, different bytes. */
const CYRILLIC_EMAIL = "уаel@gmаil.com";

describe("text the scanner must reject", () => {
  it.each([
    ["a plain Israeli mobile number", "050-123-4567"],
    ["the same number with bidi and zero-width characters woven in", INVISIBLE_PHONE],
    ["the same number in Arabic-Indic numerals", ARABIC_INDIC_PHONE],
    ["the same number in full-width numerals", FULLWIDTH_PHONE],
    ["the same number spelled out in Hebrew words", HEBREW_WORD_PHONE],
    ["a number with no separators at all", "0501234567"],
    ["an ordinary email address", "yael@gmail.com"],
    ["an address written with bracketed words", "yael [at] gmail [dot] com"],
    ["an address written with a parenthesised a", "yael(a)gmail.com"],
    ["an address written with hyphenated words", "artist(a)gmail-dot-com"],
    ["an address spelled with Cyrillic homoglyphs", CYRILLIC_EMAIL],
    ["an Instagram handle", "@yael_ceramics"],
    ["a WhatsApp link", "wa.me/972501234567"],
    ["a link-in-bio page", "linktr.ee/yael"],
    ["a Telegram link", "t.me/yaelceramics"],
    ["a personal domain", "more work at https://yael-ceramics.co.il"],
    ["a phone number inside a Hebrew sentence", "אפשר להתקשר אליי ל 050-123-4567 בכל שעה"],
    ["an address inside a Hebrew sentence", "אפשר לכתוב לי yael@gmail.com"],
  ])("rejects %s", (_why, text) => {
    expect(containsContactDetails(text)).toBe(true);
  });
});

describe("text the scanner must accept", () => {
  it.each([
    ["a Hebrew sentence containing a year", "התחלתי לצייר בסדרה הזאת בשנת 2019 אחרי תערוכה בחיפה"],
    ["dimensions", "50x70 ס\"מ, אקריליק על פשתן"],
    ["dimensions written with a multiplication sign", "50×70 ס\"מ"],
    ["the Hebrew word for email used as a noun", "אפשר להשאיר אימייל בטופס ההזמנה ואשלח עדכון"],
    ["the other Hebrew word for email", "דואר אלקטרוני נשלח אוטומטית אחרי הרכישה"],
    ["a weight", "משקל היצירה 1200 גרם"],
    ["a year range in an artwork title", "סדרת החוף 2019-2021"],
    ["a year range with spaces", "עבודות מהתקופה 2019 - 2021"],
    ["a price-like number", "המחיר 1,250 שקלים"],
    ["a plain Hebrew biography", "ציירת מתל אביב, עובדת בעיקר באקריליק על פשתן ומסיימת בסטודיו בפלורנטין"],
    ["a materials list", "אקריליק, פשתן, מסגרת עץ אלון"],
    ["a small count written in Hebrew words", "הצגתי בשתיים או שלוש תערוכות קבוצתיות"],
    ["an edition number", "הדפס מספר 3 מתוך 25"],
    ["empty text", ""],
  ])("accepts %s", (_why, text) => {
    const findings = scanForContactDetails(text);
    expect(findings, `unexpectedly flagged: ${JSON.stringify(findings)}`).toEqual([]);
  });
});

describe("normalisation", () => {
  it("strips invisible characters rather than matching around them", () => {
    // The point of the whole design: after normalisation the evasive form and
    // the plain form are the same string, so one rule covers both.
    expect(normaliseForScanning(INVISIBLE_PHONE)).toBe("050-123-4567");
  });

  it("folds Arabic-Indic digits to ASCII", () => {
    expect(normaliseForScanning(ARABIC_INDIC_PHONE)).toBe("0501234567");
  });

  it("folds full-width digits to ASCII", () => {
    expect(normaliseForScanning(FULLWIDTH_PHONE)).toBe("0501234567");
  });

  it("folds Cyrillic homoglyphs to their Latin twins", () => {
    expect(normaliseForScanning(CYRILLIC_EMAIL)).toBe("yael@gmail.com");
  });

  it("leaves Hebrew alone", () => {
    expect(normaliseForScanning("ציירת מתל אביב")).toBe("ציירת מתל אביב");
  });
});

describe("what the artist is told", () => {
  it("names the kind of thing found", () => {
    const findings = scanForContactDetails("קוראים לי יעל, 050-123-4567");

    expect(explainFindings(findings)).toContain("a phone number");
  });

  it("names every kind when there is more than one", () => {
    const message = explainFindings(scanForContactDetails("yael@gmail.com or @yael_ceramics"));

    expect(message).toContain("an email address");
    expect(message).toContain("a social media handle");
  });

  it("does not echo the normalised form back at the artist", () => {
    // The artist wrote digits with a right-to-left mark in them. Quoting the
    // scanner's internal rewrite would show them a string they never typed.
    const message = explainFindings(scanForContactDetails(INVISIBLE_PHONE));

    expect(message).not.toContain("050-123-4567");
    expect(message).toContain("a phone number");
  });
});

describe("what the scanner reports", () => {
  it("reports both problems rather than stopping at the first", () => {
    // Otherwise an artist with two mistakes finds the second one only after
    // fixing the first, which is how people conclude a form is broken.
    const kinds = scanForContactDetails("yael@gmail.com, and @yael_ceramics").map((f) => f.kind);

    expect(kinds).toContain("email");
    expect(kinds).toContain("social_handle");
  });

  it("reports a messaging link as a link, and the number inside it as a number", () => {
    // `wa.me/972501234567` really is both, and saying so is more useful than
    // picking one: the artist needs to remove the whole thing.
    expect(scanForContactDetails("wa.me/972501234567")).toEqual([
      { kind: "phone", match: "972501234567" },
      { kind: "external_link", match: "wa.me" },
    ]);
  });

  it("does not report an address twice as both an address and a link", () => {
    expect(scanForContactDetails("yael@gmail.com")).toEqual([
      { kind: "email", match: "yael@gmail.com" },
    ]);
  });

  it("has a version, so stored text can be re-scanned when the rules change", () => {
    // SECURITY.md S2-19 item 4. Text saved before a pattern existed stays
    // saved, so rows carry the version that cleared them.
    expect(SCANNER_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(SCANNER_VERSION)).toBe(true);
  });
});
