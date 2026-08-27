/**
 * Dimensions: stored as whole millimetres, spoken about in centimetres.
 *
 * artwork-listings states the unit as centimetres, and the approved design
 * (design/Upload.dc.html) asks the artist for "גובה (ס״מ)". That is a
 * presentation decision. Storage is an exact integer count of millimetres for
 * the same reason money is an exact integer count of agorot: a 28.5 cm vase
 * stored as a float is 28.499999999999996 on some path eventually, and
 * `shipping` bands these into size tiers where a boundary value must fall on
 * one definite side.
 *
 * Millimetre precision is a deliberate floor, not an accident. An artist
 * measuring a canvas with a tape measure does not know the width to a tenth of
 * a millimetre, and pretending otherwise in the schema invites a validation
 * rule nobody can satisfy.
 */
import { AppError } from "@/shared/errors";

/** Largest dimension accepted, matching the column check constraints: 100 metres. */
const MAX_MM = 100_000;

/**
 * Convert a centimetre figure typed by an artist into stored millimetres.
 *
 * Accepts one decimal place, which is the finest a tape measure reads. A finer
 * value is rejected rather than rounded: rounding is how "I typed 28.55 and it
 * saved 28.6" becomes a support ticket, and there is a person at the keyboard
 * who can be asked.
 */
export function centimetresToMillimetres(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw AppError.validation(`${field} must be a number in centimetres, got ${String(value)}`, {
      code: "artworks.dimension_not_a_number",
      fields: { [field]: ["יש להזין מספר בסנטימטרים"] },
    });
  }

  // Round to the nearest tenth first, then check that the rounding changed
  // nothing. Comparing `value * 10` against its own integer directly would
  // reject 28.5 on some inputs, because 28.5 * 10 is not exactly 285 for every
  // decimal a browser can produce.
  const millimetres = Math.round(value * 10);
  if (Math.abs(value * 10 - millimetres) > 1e-6) {
    throw AppError.validation(
      `${field} is measured to the nearest millimetre; ${value} cm is finer than that.`,
      {
        code: "artworks.dimension_too_precise",
        fields: { [field]: ["ניתן להזין עד ספרה אחת אחרי הנקודה"] },
      },
    );
  }

  if (millimetres < 1 || millimetres > MAX_MM) {
    throw AppError.validation(
      `${field} must be between 0.1 cm and ${MAX_MM / 10} cm, got ${value} cm.`,
      {
        code: "artworks.dimension_out_of_range",
        fields: { [field]: [`יש להזין מידה בין 0.1 ל-${MAX_MM / 10} ס״מ`] },
      },
    );
  }

  return millimetres;
}

/** Stored millimetres back to centimetres, for display and for the API surface. */
export function millimetresToCentimetres(millimetres: number): number {
  return millimetres / 10;
}

/**
 * Render dimensions the way the approved artwork page does: "100 × 70 ס״מ",
 * with depth appended when the piece has one.
 *
 * Latin digits and a real multiplication sign, matching design/Artwork.dc.html.
 * The unit suffix is Hebrew, and the whole string is used inside an RTL
 * document, where the browser's bidirectional algorithm places the number run
 * correctly on its own.
 */
export function formatDimensionsCm(dimensions: {
  readonly heightMm: number | null;
  readonly widthMm: number | null;
  readonly depthMm: number | null;
}): string | null {
  const { heightMm, widthMm, depthMm } = dimensions;
  if (heightMm === null || widthMm === null) return null;

  const parts = [heightMm, widthMm, ...(depthMm === null ? [] : [depthMm])].map((mm) =>
    formatNumber(millimetresToCentimetres(mm)),
  );

  return `${parts.join(" × ")} ס״מ`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** "1,850 גרם", as the approved artwork page renders it. */
export function formatWeightGrams(grams: number | null): string | null {
  if (grams === null) return null;
  return `${grams.toLocaleString("en-US")} גרם`;
}
