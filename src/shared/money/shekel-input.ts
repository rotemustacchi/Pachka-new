/**
 * Parse the amount forms a Hebrew-locale user actually types into a validated
 * shekel field: `1250`, `1,250`, `1250.50`, `1250.5`, `₪1,250.50`, with
 * optional surrounding whitespace and an optional leading `-`/`+`.
 */
import { AppError } from "@/shared/errors";
import { CURRENCY_SIGN } from "./constants";
import { agorot, nonNegativeAgorot, type Agorot } from "./types";

// After the optional sign and currency mark are stripped, what remains must
// be either plain digits or comma-grouped thousands, with at most two
// decimal places. Three decimals, "12,34" (wrong group size), a bare sign,
// and anything else non-numeric are all rejected — never rounded, never
// guessed at.
const NUMBER_PATTERN = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;

export interface ParseAgorotOptions {
  /**
   * Default `true`. The payout ledger needs negative adjusting entries
   * (see `./types.ts`), so parsing accepts a leading "-" unless the caller —
   * a price field, say — explicitly opts out.
   */
  readonly allowNegative?: boolean;
}

/**
 * The shekel sign may appear immediately before or immediately after the
 * digits (with optional whitespace between), which also lets
 * `formatAgorotCompact`'s `"₪ 480"` round-trip back through this parser.
 * More than two decimal places is a validation error, not a rounding.
 */
export function parseAgorot(raw: string, options: ParseAgorotOptions = {}): Agorot {
  const allowNegative = options.allowNegative ?? true;

  if (typeof raw !== "string") {
    throw AppError.validation("Amount must be a string", { code: "money.parse.not_a_string" });
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    throw AppError.validation("Amount is required", { code: "money.parse.empty" });
  }

  let rest = trimmed;
  let negative = false;
  if (rest.startsWith("-")) {
    negative = true;
    rest = rest.slice(1).trim();
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1).trim();
  }

  if (rest.startsWith(CURRENCY_SIGN)) {
    rest = rest.slice(CURRENCY_SIGN.length).trim();
  } else if (rest.endsWith(CURRENCY_SIGN)) {
    rest = rest.slice(0, rest.length - CURRENCY_SIGN.length).trim();
  }

  if (!NUMBER_PATTERN.test(rest)) {
    throw AppError.validation(
      `"${raw}" is not a valid amount. Use digits with at most two decimal places, e.g. "1,250.50".`,
      { code: "money.parse.invalid_format", details: { raw } },
    );
  }

  const [integerPart = "", fractionPart = ""] = rest.split(".");
  const digits = `${integerPart.replace(/,/g, "")}${fractionPart.padEnd(2, "0")}`;
  const magnitude = Number.parseInt(digits, 10);
  const value = negative ? -magnitude : magnitude;

  return allowNegative ? agorot(value) : nonNegativeAgorot(value);
}
