/**
 * The certificate domain types, and the one place a database row becomes one.
 *
 * TWO SHAPES, AND THE DIFFERENCE BETWEEN THEM IS THE SECURITY CONTROL
 * -------------------------------------------------------------------
 * `PublicCertificate` is what the public verification page renders.
 * `BuyerCertificate` is what the buyer's private copy renders. The second is
 * the first PLUS a name.
 *
 * That is a type-level guarantee, not a convention: `PublicCertificate` has no
 * field that could carry a buyer's name, address, phone or account id, so a
 * page that accepts a `PublicCertificate` cannot render one however it is
 * composed. SECURITY.md S0-6 item 3 and SPEC-B require the public page to
 * disclose nothing about the buyer, and a redaction step performed on the way
 * out would put that requirement one careless spread away from failing.
 *
 * The same reasoning as `orders/types.ts`, which puts it well: mapping is
 * explicit, key by key, with no spread, because "a spread would make the shape
 * of a domain object depend on the shape of whatever query produced it".
 *
 * `CertificateRecord` — the full row, buyer_id included — is internal to this
 * module and is not exported from `index.ts`. Nothing outside gets a shape that
 * links a person to a purchase.
 */
import { MEDIUM_LABELS, formatDimensionsCm, isMedium } from "@/modules/artworks";
import {
  DECLARATION_VERSION,
  UNIQUE_WORK_STATEMENT,
  declarationStatements,
  editionStatement,
} from "./declaration";

/**
 * Whether the sale behind a certificate still stands.
 *
 * Derived at read time, never stored — see the migration's note C3. Both halves
 * of `authenticity-certificate` ("SHALL NOT be modifiable", "SHALL show as
 * void") are satisfiable only this way.
 */
export const CERTIFICATE_VALIDITIES = ["valid", "void"] as const;
export type CertificateValidity = (typeof CERTIFICATE_VALIDITIES)[number];

/** Which edition slot this certificate covers, or `null` for a unique piece. */
export interface EditionPosition {
  readonly position: number;
  readonly size: number;
}

/**
 * The certificate row as stored. INTERNAL — not re-exported from `index.ts`.
 *
 * There is no `buyerName` here and there is no such column: the private
 * document reads the name through `orders.buyerOrder()` at render time. See the
 * migration, note C2.
 */
export interface CertificateRecord {
  readonly id: string;
  readonly orderId: string;
  readonly fulfilmentId: string;
  readonly artworkId: string;
  readonly artistId: string;
  readonly buyerId: string;
  readonly unitOrdinal: number;
  readonly inventoryType: "unique" | "edition";
  readonly edition: EditionPosition | null;
  readonly title: string;
  readonly artistDisplayName: string;
  readonly medium: string;
  readonly heightMm: number | null;
  readonly widthMm: number | null;
  readonly depthMm: number | null;
  readonly materials: string | null;
  readonly yearCreated: number | null;
  readonly aiAssisted: boolean;
  readonly imagePath: string | null;
  readonly soldAt: string;
  readonly deliveredAt: string;
  readonly issuedAt: string;
  readonly declarationVersion: string;
}

export interface CertificateRow {
  readonly id: string;
  readonly order_id: string;
  readonly fulfilment_id: string;
  readonly artwork_id: string;
  readonly artist_id: string;
  readonly buyer_id: string;
  readonly unit_ordinal: number;
  readonly inventory_type: string;
  readonly edition_position: number | null;
  readonly edition_size: number | null;
  readonly title: string;
  readonly artist_display_name: string;
  readonly medium: string;
  readonly height_mm: number | null;
  readonly width_mm: number | null;
  readonly depth_mm: number | null;
  readonly materials: string | null;
  readonly year_created: number | null;
  readonly ai_assisted: boolean;
  readonly image_path: string | null;
  readonly sold_at: Date | string;
  readonly delivered_at: Date | string;
  readonly issued_at: Date | string;
  readonly declaration_version: string;
}

/**
 * The column list every certificate query uses.
 *
 * Exported for the reason `orders` and `artworks` give: the query and the
 * mapper cannot drift, and `select *` never appears against this table.
 */
export const CERTIFICATE_COLUMNS = [
  "id",
  "order_id",
  "fulfilment_id",
  "artwork_id",
  "artist_id",
  "buyer_id",
  "unit_ordinal",
  "inventory_type",
  "edition_position",
  "edition_size",
  "title",
  "artist_display_name",
  "medium",
  "height_mm",
  "width_mm",
  "depth_mm",
  "materials",
  "year_created",
  "ai_assisted",
  "image_path",
  "sold_at",
  "delivered_at",
  "issued_at",
  "declaration_version",
].join(", ");

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toCertificateRecord(row: CertificateRow): CertificateRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    fulfilmentId: row.fulfilment_id,
    artworkId: row.artwork_id,
    artistId: row.artist_id,
    buyerId: row.buyer_id,
    unitOrdinal: row.unit_ordinal,
    inventoryType: row.inventory_type === "edition" ? "edition" : "unique",
    edition:
      row.edition_position === null || row.edition_size === null
        ? null
        : { position: row.edition_position, size: row.edition_size },
    title: row.title,
    artistDisplayName: row.artist_display_name,
    medium: row.medium,
    heightMm: row.height_mm,
    widthMm: row.width_mm,
    depthMm: row.depth_mm,
    materials: row.materials,
    yearCreated: row.year_created,
    aiAssisted: row.ai_assisted,
    imagePath: row.image_path,
    soldAt: iso(row.sold_at),
    deliveredAt: iso(row.delivered_at),
    issuedAt: iso(row.issued_at),
    declarationVersion: row.declaration_version,
  };
}

/**
 * What the PUBLIC verification page is allowed to know.
 *
 * `authenticity-certificate`, *Public verification does not name the buyer*:
 * "the page displays the artwork, artist, medium, dimensions, edition
 * information, sale date and validity — and SHALL NOT display the buyer's name
 * or any other buyer detail."
 *
 * Note what is absent and stays absent: no `buyerId`, no `orderId`, no
 * `fulfilmentId`. Not merely no name — no identifier that could be joined
 * against anything else to recover one, and nothing that reveals how many
 * orders the platform has processed.
 */
export interface PublicCertificate {
  /** The identifier this page was resolved by. Safe to show: it is what the holder typed. */
  readonly identifier: string;
  readonly title: string;
  readonly artistDisplayName: string;
  /** The taxonomy code, e.g. `painting_illustration`. */
  readonly medium: string;
  /** That code in Hebrew, resolved through the artworks taxonomy. */
  readonly mediumLabel: string;
  /** Formatted centimetres, e.g. `70 × 50 ס״מ`. `null` where dimensions were not recorded. */
  readonly dimensions: string | null;
  readonly materials: string | null;
  readonly yearCreated: number | null;
  /** `null` for a one-of-a-kind piece; `edition` describes which copy otherwise. */
  readonly edition: EditionPosition | null;
  /** "יצירה יחידה במינה", or "עותק 3 מתוך 10". Always present. */
  readonly editionStatement: string;
  /** ISO timestamp of the sale — when the order was placed. */
  readonly saleDate: string;
  readonly imagePath: string | null;
  readonly aiAssisted: boolean;
  readonly validity: CertificateValidity;
  /** Every sentence that must appear. See `declaration.ts`. */
  readonly declaration: readonly string[];
  /** Which revision of the wording this certificate was issued under. */
  readonly declarationVersion: string;
}

/**
 * The buyer's own copy: the public projection plus the one field that must
 * never leave it.
 *
 * Composed rather than flattened so that a component written against
 * `PublicCertificate` can render the buyer's copy too — it simply never sees
 * `buyerName`, because the field is not on the object it was handed.
 */
export interface BuyerCertificate {
  readonly certificate: PublicCertificate;
  /**
   * `authenticity-certificate`: the buyer's name, on the private document only.
   *
   * Read at render time from the delivery details of an order this buyer owns,
   * never stored on the certificate row (migration note C2).
   */
  readonly buyerName: string;
}

function mediumLabelFor(medium: string): string {
  // A medium that is no longer in the taxonomy still has to render: the
  // certificate is a historical document and the taxonomy is a live list. The
  // stored code is the fallback, which is ugly but honest.
  return isMedium(medium) ? MEDIUM_LABELS[medium] : medium;
}

/**
 * The redacted projection. The ONLY way a certificate reaches a public surface.
 *
 * Takes the record and the derived validity separately, because validity is not
 * a property of the row — it is a question about the order's current state, and
 * pretending otherwise is how a stored `void` flag gets added back.
 */
export function toPublicCertificate(
  record: CertificateRecord,
  validity: CertificateValidity,
): PublicCertificate {
  return {
    identifier: record.id,
    title: record.title,
    artistDisplayName: record.artistDisplayName,
    medium: record.medium,
    mediumLabel: mediumLabelFor(record.medium),
    dimensions: formatDimensionsCm({
      heightMm: record.heightMm,
      widthMm: record.widthMm,
      depthMm: record.depthMm,
    }),
    materials: record.materials,
    yearCreated: record.yearCreated,
    edition: record.edition,
    editionStatement:
      record.edition === null
        ? UNIQUE_WORK_STATEMENT
        : editionStatement(record.edition.position, record.edition.size),
    saleDate: record.soldAt,
    imagePath: record.imagePath,
    aiAssisted: record.aiAssisted,
    validity,
    declaration: declarationStatements({ aiAssisted: record.aiAssisted }),
    // Falls back to the current version only for a row written before the
    // column existed, which is no row at all — the column is NOT NULL from the
    // first migration. Kept explicit so the field is never undefined.
    declarationVersion: record.declarationVersion || DECLARATION_VERSION,
  };
}
