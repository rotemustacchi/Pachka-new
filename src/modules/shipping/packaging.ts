/**
 * Packaging obligations for fragile work.
 *
 * `shipping-and-returns`, "Packaging obligations for fragile work": for
 * artworks whose medium is ceramics and objects, or that the artist marked
 * fragile, the requirements are presented before the fulfilment can be marked
 * shipped and the artist must confirm compliance. And, explicitly: the MVP
 * offers no breakage insurance.
 *
 * The confirmation is not a formality. There is no insurance product behind it,
 * so when a ceramic arrives in pieces the only thing that exists is the record
 * of what the artist was shown and what they confirmed.
 */

/**
 * The medium `artwork-listings` calls "ceramics and objects".
 *
 * Compared after normalisation, so it matches whichever encoding `artworks`
 * settles on -- "ceramics and objects", "ceramics_and_objects",
 * "Ceramics And Objects". TODO(taxonomy): `artworks` owns the closed set; if it
 * lands on a code other than these, this constant is the one line to change.
 */
export const FRAGILE_BY_MEDIUM = "ceramics_and_objects";

function normaliseMedium(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface PackagingRequirement {
  /** Stable identifier. The UI renders `text`; a test asserts on this. */
  readonly code: string;
  readonly text: string;
}

export type FragileReason = "medium" | "artist_marked";

export interface PackagingObligation {
  readonly required: boolean;
  /** Why it applies, or `null` when it does not. Both reasons can be true; `medium` is reported first. */
  readonly reason: FragileReason | null;
  readonly requirements: readonly PackagingRequirement[];
  /**
   * Always false. The MVP sells no breakage cover, and a field that says so is
   * harder to forget than a comment: a checkout that offered one would have to
   * invent the value.
   */
  readonly breakageInsuranceOffered: false;
}

/**
 * What the artist must do, and confirm, before a fragile parcel may ship.
 *
 * Written as obligations rather than advice because that is what the artist
 * confirms compliance with.
 */
const FRAGILE_REQUIREMENTS: readonly PackagingRequirement[] = [
  {
    code: "double_wall_box",
    text: "אריזה בקרטון דו-שכבתי, בגודל המאפשר לפחות 5 ס״מ ריפוד מכל צד.",
  },
  {
    code: "wrap_each_item",
    text: "עטיפת כל פריט בנפרד בניילון בועות בשתי שכבות לפחות.",
  },
  {
    code: "immobilise",
    text: "מילוי החללים כך שהפריט אינו זז כלל בתוך הקופסה בניעור.",
  },
  {
    code: "no_direct_contact",
    text: "הפרדה בין פריטים ובין הפריט לדפנות הקופסה — ללא מגע ישיר.",
  },
  {
    code: "fragile_marking",
    text: "סימון החבילה כשביר בשני צדדים לפחות.",
  },
  {
    code: "no_insurance",
    text: "אין ביטוח שבר בפלטפורמה. אריזה לקויה היא באחריות האמן.",
  },
];

export interface FragilityInput {
  /** The artwork's medium, as `artworks` stores it. */
  readonly medium?: string | null;
  /** The artist's own fragile flag, independent of medium. */
  readonly fragile?: boolean;
}

export function packagingObligationFor(input: FragilityInput): PackagingObligation {
  const byMedium = typeof input.medium === "string" && normaliseMedium(input.medium) === FRAGILE_BY_MEDIUM;
  const byFlag = input.fragile === true;

  if (!byMedium && !byFlag) {
    return { required: false, reason: null, requirements: [], breakageInsuranceOffered: false };
  }

  return {
    required: true,
    reason: byMedium ? "medium" : "artist_marked",
    requirements: FRAGILE_REQUIREMENTS,
    breakageInsuranceOffered: false,
  };
}
