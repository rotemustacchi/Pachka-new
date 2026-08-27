/**
 * Formatting is deterministic and does not depend on the running machine's
 * locale: grouping is done with a hand-written regex rather than
 * `toLocaleString`, which would silently pick up whatever locale Node (or a
 * browser) happens to be configured with and stop being reproducible.
 */
import { CURRENCY_SIGN } from "./constants";
import type { Agorot } from "./types";

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The canonical form: `₪1,250.00` (ARCHITECTURE.md, "Non-negotiable
 * technical decisions"). Latin numerals, LTR, no space after the sign,
 * always exactly two decimal places.
 */
export function formatAgorot(value: Agorot): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.trunc(magnitude / 100);
  const cents = magnitude % 100;
  const groupedWhole = groupThousands(String(whole));
  const centsStr = String(cents).padStart(2, "0");
  return `${negative ? "-" : ""}${CURRENCY_SIGN}${groupedWhole}.${centsStr}`;
}

/**
 * Compact, decimal-free form used for card prices in the approved designs
 * (`design/Catalog.dc.html`: `₪ 480`, `₪ 2,000`) — note the space after the
 * sign and the absence of decimals, both different from `formatAgorot`.
 *
 * This rounds to the nearest whole shekel (half away from zero) for DISPLAY
 * ONLY. It is lossy by design — never treat its output as an exact amount,
 * and never `parseAgorot` a compact string back expecting the original value
 * if that value carried agorot.
 */
export function formatAgorotCompact(value: Agorot): string {
  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.round(magnitude / 100);
  return `${negative ? "-" : ""}${CURRENCY_SIGN} ${groupThousands(String(whole))}`;
}
