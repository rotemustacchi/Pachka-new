/**
 * Creating, editing, and moving an artwork listing through its lifecycle.
 *
 * This is the only write path to `artworks`. There is no INSERT, UPDATE or
 * DELETE policy for `anon` or `authenticated` on the table (see the migration's
 * section 4), so the PostgREST data API cannot reach it at all -- which is what
 * makes "this file is the only write path" a fact about the system rather than
 * a convention this file is asking other files to respect. Every rule the
 * artwork-listings spec states is enforced here, and there is no second door.
 *
 * ORDER OF CHECKS
 * ---------------
 * Every mutating function asks the same questions in the same order, and the
 * order is not arbitrary:
 *
 *   1. Does the artwork exist and does this actor own it?  -> not_found
 *   2. Is the account suspended?                           -> forbidden
 *   3. Is the address verified? (publish only)             -> forbidden
 *   4. Is the transition permitted by the state machine?   -> conflict
 *   5. Is the artwork complete enough? (publish only)      -> validation
 *
 * Ownership first, and answered with `not_found` rather than `forbidden`,
 * because `forbidden` confirms the artwork exists. SECURITY.md S3-29 is about
 * exactly this: identifiers should not be a directory, and "this one is not
 * yours" is a lookup oracle.
 *
 * Suspension before anything else the actor wants, because SECURITY.md S1-13 is
 * that a live token belonging to a suspended account authorises nothing. The
 * token stays valid for its full lifetime after suspension, so "cannot sign in"
 * has to be backed by "cannot act".
 */
import { z } from "zod";
import { AppError } from "@/shared/errors";
import type { Sql, Tx } from "@/shared/db";
import { toDbValue, type Agorot } from "@/shared/money";
import {
  assertEmailVerified,
  explainFindings,
  isSuspended,
  scanForContactDetails,
} from "@/modules/accounts";
import type { ArtworksDeps } from "./deps";
import { centimetresToMillimetres } from "./dimensions";
import {
  listingLimits,
  type ListingLimits,
} from "./limits";
import { assertTransition, type Actor } from "./lifecycle";
import { availabilityFor, lockArtworkForUpdate, type Availability } from "./inventory";
import {
  asPublishCandidate,
  missingForPublication,
  toFieldErrors,
} from "./publish-requirements";
import { parseTaxonomyList, parseTaxonomyValue, type Medium, type Mood, type Style, type TargetSpace } from "./taxonomy";
import { ARTWORK_COLUMNS, toArtwork, type Artwork, type ArtworkRow, type InventoryType } from "./types";

/**
 * What an artist submits from the upload form.
 *
 * Every field is optional because the form saves a draft continuously
 * ("טיוטה · נשמר אוטומטית" in design/Upload.dc.html) and a draft is allowed to
 * be as incomplete as it likes. Completeness is a publish-time question, asked
 * once, by `missingForPublication`.
 *
 * Dimensions arrive in CENTIMETRES, because that is what the artist typed and
 * what the spec states. They are stored as millimetres; see dimensions.ts.
 * Price arrives already in agorot -- routes convert from the shekel string with
 * `parseAgorot` from shared/money, so a float never exists at any point.
 */
export interface ArtworkInput {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly priceAgorot?: number | null;
  readonly heightCm?: number | null;
  readonly widthCm?: number | null;
  readonly depthCm?: number | null;
  readonly weightGrams?: number | null;
  readonly materials?: string | null;
  readonly isFramed?: boolean | null;
  readonly leadTimeDays?: number | null;
  readonly yearCreated?: number | null;

  readonly medium?: string | null;
  readonly styles?: readonly string[];
  readonly targetSpaces?: readonly string[];
  readonly moods?: readonly string[];

  readonly inventoryType?: InventoryType;
  /** Declared edition size. Ignored for a unique piece, which is always 1. */
  readonly stock?: number;
  readonly madeToOrder?: boolean;
  readonly productionLeadTimeDays?: number | null;

  /**
   * The originality affirmation, as a tick.
   *
   * artwork-listings requires the system to record who affirmed and when, so
   * this boolean becomes two columns: the affirming account and a timestamp,
   * set here, server-side. The client cannot supply either -- an artist who
   * could post `originalityDeclaredBy` could attribute the affirmation to
   * someone else, which is precisely the thing the record is for.
   */
  readonly affirmsOriginality?: boolean;

  /**
   * The answer to the AI-assistance question. `null` is "not answered", which
   * is a distinct state from `false` and blocks publication on its own.
   */
  readonly aiAssisted?: boolean | null;
}

const Title = z.string().trim().min(2).max(120);
const Materials = z.string().trim().min(2).max(400);

/**
 * Built per call rather than once at module load, because two of its bounds are
 * operator-configurable now and a schema frozen at import time would hold
 * whatever they were when the process started.
 */
const inputSchema = (limits: ListingLimits) =>
  z.object({
  title: Title.nullish(),
  description: z.string().trim().min(1).max(limits.maxDescriptionLength).nullish(),
  priceAgorot: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
  heightCm: z.number().positive().nullish(),
  widthCm: z.number().positive().nullish(),
  depthCm: z.number().positive().nullish(),
  weightGrams: z.number().int().min(1).max(500_000).nullish(),
  materials: Materials.nullish(),
  isFramed: z.boolean().nullish(),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  yearCreated: z.number().int().min(1900).max(2200).nullish(),
  medium: z.string().nullish(),
  styles: z.array(z.string()).optional(),
  targetSpaces: z.array(z.string()).optional(),
  moods: z.array(z.string()).optional(),
  inventoryType: z.enum(["unique", "edition"]).optional(),
  stock: z.number().int().min(1).max(limits.maxEditionSize).optional(),
  madeToOrder: z.boolean().optional(),
  productionLeadTimeDays: z.number().int().min(0).max(365).nullish(),
    affirmsOriginality: z.boolean().optional(),
    aiAssisted: z.boolean().nullish(),
  });

/** Free-text fields that reach a public page, and therefore the contact scanner. */
const SCANNED_FIELDS = ["title", "description", "materials"] as const;

/**
 * Run the contact scanner over every free-text field at once.
 *
 * SECURITY.md S2-19: artwork title, description and materials are
 * artist-controlled text on a public page, and the MVP deliberately has no
 * buyer-artist messaging channel, so they are the obvious place to put a phone
 * number and take the transaction off-platform. The scanner is `accounts`'
 * single implementation, called through its public API rather than
 * reimplemented -- a second copy of these patterns would drift the first time
 * one of them was tightened.
 *
 * All fields in one pass, so an artist with a handle in the title and a number
 * in the description is told about both rather than discovering the second
 * after fixing the first.
 */
function scanFreeText(values: Readonly<Record<string, unknown>>): void {
  const problems: Record<string, string[]> = {};

  for (const field of SCANNED_FIELDS) {
    const value = values[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const findings = scanForContactDetails(value);
    if (findings.length > 0) problems[field] = [explainFindings(findings)];
  }

  if (Object.keys(problems).length > 0) {
    throw AppError.fieldsInvalid(problems, { code: "artworks.contact_details_not_permitted" });
  }
}

function capped<T>(axis: string, values: readonly T[], max: number, label: string): readonly T[] {
  if (values.length <= max) return values;

  // SECURITY.md S2-20 item 2, "cap the shape": claiming every style and every
  // target space maximises taxonomy overlap in the matchmaker's scoring
  // function and ranks the artwork into every result set. Refused rather than
  // truncated -- truncating would silently classify the artwork differently
  // from what the artist chose, and there is a person here to tell.
  throw AppError.validation(`Choose at most ${max} ${axis} values, got ${values.length}.`, {
    code: "artworks.taxonomy_axis_over_cap",
    details: { axis, max, submitted: values.length },
    fields: { [axis]: [`ניתן לבחור עד ${max} ${label}`] },
  });
}

interface NormalisedInput {
  readonly title: string | null | undefined;
  readonly description: string | null | undefined;
  readonly priceAgorot: number | null | undefined;
  readonly heightMm: number | null | undefined;
  readonly widthMm: number | null | undefined;
  readonly depthMm: number | null | undefined;
  readonly weightGrams: number | null | undefined;
  readonly materials: string | null | undefined;
  readonly isFramed: boolean | null | undefined;
  readonly leadTimeDays: number | null | undefined;
  readonly yearCreated: number | null | undefined;
  readonly medium: Medium | null | undefined;
  readonly styles: readonly Style[] | undefined;
  readonly targetSpaces: readonly TargetSpace[] | undefined;
  readonly moods: readonly Mood[] | undefined;
  readonly inventoryType: InventoryType | undefined;
  readonly stock: number | undefined;
  readonly madeToOrder: boolean | undefined;
  readonly productionLeadTimeDays: number | null | undefined;
  readonly affirmsOriginality: boolean | undefined;
  readonly aiAssisted: boolean | null | undefined;
}

function normalise(limits: ListingLimits, input: ArtworkInput): NormalisedInput {
  const parsed = inputSchema(limits).safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "input";
      (fields[key] ??= []).push(issue.message);
    }
    throw AppError.fieldsInvalid(fields, { code: "artworks.invalid_input" });
  }

  const value = parsed.data;
  scanFreeText(value);

  return {
    title: value.title,
    description: value.description,
    priceAgorot: value.priceAgorot,
    heightMm: value.heightCm == null ? value.heightCm : centimetresToMillimetres(value.heightCm, "heightCm"),
    widthMm: value.widthCm == null ? value.widthCm : centimetresToMillimetres(value.widthCm, "widthCm"),
    depthMm: value.depthCm == null ? value.depthCm : centimetresToMillimetres(value.depthCm, "depthCm"),
    weightGrams: value.weightGrams,
    materials: value.materials,
    isFramed: value.isFramed,
    leadTimeDays: value.leadTimeDays,
    yearCreated: value.yearCreated,
    // The closed set, enforced on every value that enters the system. A value
    // outside it is rejected, never coerced (artwork-listings: "Client submits
    // a value outside the taxonomy -> the system rejects the request").
    medium: value.medium == null ? value.medium : parseTaxonomyValue("medium", value.medium),
    styles:
      value.styles === undefined
        ? undefined
        : (capped("styles", parseTaxonomyList("styles", value.styles), limits.maxStyles, "סגנונות") as readonly Style[]),
    targetSpaces:
      value.targetSpaces === undefined
        ? undefined
        : (capped(
            "target_spaces",
            parseTaxonomyList("target_spaces", value.targetSpaces),
            limits.maxTargetSpaces,
            "חללים",
          ) as readonly TargetSpace[]),
    moods:
      value.moods === undefined
        ? undefined
        : (capped("moods", parseTaxonomyList("moods", value.moods), limits.maxMoods, "וייבים") as readonly Mood[]),
    inventoryType: value.inventoryType,
    stock: value.stock,
    madeToOrder: value.madeToOrder,
    productionLeadTimeDays: value.productionLeadTimeDays,
    affirmsOriginality: value.affirmsOriginality,
    aiAssisted: value.aiAssisted,
  };
}

/**
 * Refuse any write by a suspended account.
 *
 * SECURITY.md S1-13 item 2: enforcement must not depend on session revocation
 * having landed. Every server-side authorization check tests this, so a
 * captured token from before the suspension authorises nothing.
 */
async function assertActive(db: Sql, userId: string): Promise<void> {
  if (await isSuspended(db, userId)) {
    throw AppError.forbidden("This account is suspended and cannot change listings.", {
      code: "artworks.account_suspended",
    });
  }
}

/**
 * Load an artwork the actor is entitled to act on.
 *
 * `not_found` for an artwork owned by someone else, deliberately -- see the
 * header. An admin sees everything, because moderation acts on artworks it does
 * not own by definition.
 */
async function loadForActor(
  sql: Sql,
  artworkId: string,
  actorId: string,
  actor: Actor,
): Promise<Artwork> {
  const row = await sql.maybeOne<ArtworkRow>(
    `select ${ARTWORK_COLUMNS} from artworks where id = $1`,
    [artworkId],
  );

  if (row === null) throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });

  const artwork = toArtwork(row);
  if (actor !== "admin" && actor !== "system" && artwork.artistId !== actorId) {
    throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
  }
  return artwork;
}

/**
 * Build the `set` clause from whichever fields the caller actually supplied.
 *
 * `undefined` means "not submitted, leave it alone"; `null` means "clear it".
 * The distinction is what lets the upload form autosave one step at a time
 * without the untouched steps being wiped, and it is why every optional field
 * on `ArtworkInput` is `?: T | null` rather than just `?: T`.
 */
function assignments(
  input: NormalisedInput,
  actorId: string,
): { readonly sql: string[]; readonly params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];

  const set = (column: string, value: unknown): void => {
    params.push(value);
    sql.push(`${column} = $${params.length}`);
  };

  if (input.title !== undefined) set("title", input.title);
  if (input.description !== undefined) set("description", input.description);
  if (input.priceAgorot !== undefined) {
    // bigint column: pass a string. `toDbValue` is the sanctioned rendering.
    set("price_agorot", input.priceAgorot === null ? null : toDbValue(input.priceAgorot as Agorot));
  }
  if (input.heightMm !== undefined) set("height_mm", input.heightMm);
  if (input.widthMm !== undefined) set("width_mm", input.widthMm);
  if (input.depthMm !== undefined) set("depth_mm", input.depthMm);
  if (input.weightGrams !== undefined) set("weight_grams", input.weightGrams);
  if (input.materials !== undefined) set("materials", input.materials);
  if (input.isFramed !== undefined) set("is_framed", input.isFramed);
  if (input.leadTimeDays !== undefined) set("lead_time_days", input.leadTimeDays);
  if (input.yearCreated !== undefined) set("year_created", input.yearCreated);
  if (input.medium !== undefined) set("medium", input.medium);
  if (input.styles !== undefined) set("styles", input.styles);
  if (input.targetSpaces !== undefined) set("target_spaces", input.targetSpaces);
  if (input.moods !== undefined) set("moods", input.moods);
  if (input.inventoryType !== undefined) set("inventory_type", input.inventoryType);
  if (input.madeToOrder !== undefined) set("made_to_order", input.madeToOrder);
  if (input.productionLeadTimeDays !== undefined) {
    set("production_lead_time_days", input.productionLeadTimeDays);
  }
  if (input.aiAssisted !== undefined) set("ai_assisted", input.aiAssisted);

  // A unique piece is pinned to one unit. The check constraint enforces it too;
  // doing it here means the artist gets a listing rather than an error when
  // they switch a stocked edition back to unique.
  if (input.stock !== undefined || input.inventoryType !== undefined) {
    const type = input.inventoryType;
    if (type === "unique") {
      set("stock", 1);
    } else if (input.stock !== undefined) {
      set("stock", input.stock);
    }
  }

  // The declaration, recorded server-side with the affirming account and the
  // moment of affirmation -- never taken from the request.
  if (input.affirmsOriginality !== undefined) {
    if (input.affirmsOriginality) {
      set("originality_declared_by", actorId);
      sql.push("originality_declared_at = coalesce(originality_declared_at, now())");
    } else {
      set("originality_declared_by", null);
      set("originality_declared_at", null);
    }
  }

  return { sql, params };
}

export interface ArtworkWithAvailability {
  readonly artwork: Artwork;
  readonly availability: Availability;
}

async function withAvailability(
  deps: ArtworksDeps,
  sql: Sql,
  artwork: Artwork,
): Promise<ArtworkWithAvailability> {
  const demand = await deps.demand.demandFor(sql, artwork.id);
  return { artwork, availability: availabilityFor(artwork, demand) };
}

/**
 * Create a draft.
 *
 * Starts in `draft` always: there is no "create published" path, because
 * publication has to run the completeness check and the state machine, and a
 * second door into `published` is a second place for those to be forgotten.
 */
export async function createDraft(
  deps: ArtworksDeps,
  artistId: string,
  input: ArtworkInput = {},
): Promise<Artwork> {
  await assertActive(deps.db, artistId);
  const normalised = normalise(await listingLimits(deps.db), input);

  return deps.db.withTransaction(async (tx) => {
    const created = await tx.one<{ id: string }>(
      "insert into artworks (artist_id) values ($1) returning id",
      [artistId],
    );

    const { sql, params } = assignments(normalised, artistId);
    if (sql.length === 0) {
      return toArtwork(
        await tx.one<ArtworkRow>(`select ${ARTWORK_COLUMNS} from artworks where id = $1`, [
          created.id,
        ]),
      );
    }

    params.push(created.id);
    const row = await tx.one<ArtworkRow>(
      `update artworks set ${sql.join(", ")} where id = $${params.length} returning ${ARTWORK_COLUMNS}`,
      params,
    );
    return toArtwork(row);
  });
}

/**
 * Edit a listing.
 *
 * Works in every state except `removed`, and that exception is the point: an
 * artist whose artwork was taken down cannot edit it back into acceptability
 * and cannot republish it (artwork-listings, moderation-admin). Editing a
 * `published` artwork is allowed and expected -- fixing a typo in a description
 * should not require unpublishing -- and the publish-completeness check
 * constraint in the migration is what stops an edit from hollowing out a live
 * listing.
 */
export async function updateArtwork(
  deps: ArtworksDeps,
  artistId: string,
  artworkId: string,
  input: ArtworkInput,
): Promise<Artwork> {
  await assertActive(deps.db, artistId);
  const normalised = normalise(await listingLimits(deps.db), input);

  return deps.db.withTransaction(async (tx) => {
    const existing = await loadForActor(tx, artworkId, artistId, "artist");

    if (existing.status === "removed") {
      throw AppError.conflict(
        "This artwork was removed by a platform admin and can no longer be edited.",
        { code: "artworks.removed_is_terminal" },
      );
    }

    const { sql, params } = assignments(normalised, artistId);
    if (sql.length === 0) return existing;

    params.push(artworkId);
    const row = await tx.one<ArtworkRow>(
      `update artworks set ${sql.join(", ")} where id = $${params.length} returning ${ARTWORK_COLUMNS}`,
      params,
    );
    return toArtwork(row);
  });
}

/**
 * Publish.
 *
 * The completeness survey runs against what the row will look like AFTER this
 * call's edits, not before, so an artist who fills in the last missing field
 * and hits publish in one action is published rather than told the field is
 * missing. `input` is therefore applied first, inside the same transaction --
 * and if the publish is then refused, the transaction rolls back and the edits
 * go with it, which keeps "the publish failed" from meaning "and also your
 * changes half-saved".
 */
export async function publishArtwork(
  deps: ArtworksDeps,
  artistId: string,
  artworkId: string,
  input: ArtworkInput = {},
): Promise<Artwork> {
  await assertActive(deps.db, artistId);

  // accounts-and-profiles gates publishing on a verified address, and exposes
  // this as the shared gate rather than letting each module read
  // `account_status` for itself.
  await assertEmailVerified(deps.db, artistId, "publish");

  const normalised = normalise(await listingLimits(deps.db), input);

  return deps.db.withTransaction(async (tx) => {
    const existing = await loadForActor(tx, artworkId, artistId, "artist");

    // The state machine answers "removed cannot be republished" before the
    // completeness survey does, so an artist whose artwork was taken down is
    // told why rather than handed a list of fields to fix that would not help.
    assertTransition({ from: existing.status, to: "published", by: "artist" });

    const { sql, params } = assignments(normalised, artistId);
    let artwork = existing;
    if (sql.length > 0) {
      params.push(artworkId);
      artwork = toArtwork(
        await tx.one<ArtworkRow>(
          `update artworks set ${sql.join(", ")} where id = $${params.length} returning ${ARTWORK_COLUMNS}`,
          params,
        ),
      );
    }

    const missing = missingForPublication(asPublishCandidate(artwork));
    if (missing.length > 0) {
      // Every missing field at once, as the spec requires.
      throw AppError.fieldsInvalid(toFieldErrors(missing), {
        code: "artworks.incomplete_for_publication",
        details: { missing: missing.map((requirement) => requirement.field) },
      });
    }

    if (existing.status === "published") return artwork;

    const row = await tx.one<ArtworkRow>(
      `update artworks
          set status = 'published',
              published_at = coalesce(published_at, now())
        where id = $1
        returning ${ARTWORK_COLUMNS}`,
      [artworkId],
    );
    return toArtwork(row);
  });
}

/**
 * Unlist.
 *
 * artwork-listings: "Artwork with a pending order cannot be unlisted -- the
 * system rejects the change and explains that the order must resolve first."
 *
 * The reservation check happens UNDER THE ARTWORK ROW LOCK, and that is what
 * makes it a check rather than a guess. `orders` takes the same lock before
 * inserting a reservation (SECURITY.md S0-4). Without it, an unlist and a
 * checkout that start at the same moment both read "nothing reserved" and both
 * succeed, and a buyer has paid for an artwork that is no longer listed. With
 * it, one of the two waits for the other and sees the truth.
 */
export async function unlistArtwork(
  deps: ArtworksDeps,
  artistId: string,
  artworkId: string,
): Promise<Artwork> {
  await assertActive(deps.db, artistId);

  return deps.db.withTransaction(async (tx) => {
    const existing = await loadForActor(tx, artworkId, artistId, "artist");

    // Lock first, then read demand under it. Order fixed by SECURITY.md S0-4.
    await lockArtworkForUpdate(tx, artworkId);
    const demand = await deps.demand.demandFor(tx, artworkId);

    if (demand.reservedUnits > 0) {
      throw AppError.conflict(
        "This artwork is being bought right now and cannot be withdrawn until that order " +
          "completes or expires. Try again shortly.",
        {
          code: "artworks.reserved_by_order_in_progress",
          details: { reservedUnits: demand.reservedUnits },
        },
      );
    }

    assertTransition({ from: existing.status, to: "unlisted", by: "artist" });
    if (existing.status === "unlisted") return existing;

    const row = await tx.one<ArtworkRow>(
      `update artworks set status = 'unlisted' where id = $1 returning ${ARTWORK_COLUMNS}`,
      [artworkId],
    );
    return toArtwork(row);
  });
}

/** Take a listing back to draft. Same reservation rule as unlisting: it leaves the catalog either way. */
export async function returnToDraft(
  deps: ArtworksDeps,
  artistId: string,
  artworkId: string,
): Promise<Artwork> {
  await assertActive(deps.db, artistId);

  return deps.db.withTransaction(async (tx) => {
    const existing = await loadForActor(tx, artworkId, artistId, "artist");

    await lockArtworkForUpdate(tx, artworkId);
    const demand = await deps.demand.demandFor(tx, artworkId);
    if (demand.reservedUnits > 0) {
      throw AppError.conflict(
        "This artwork is being bought right now and cannot be withdrawn until that order " +
          "completes or expires. Try again shortly.",
        {
          code: "artworks.reserved_by_order_in_progress",
          details: { reservedUnits: demand.reservedUnits },
        },
      );
    }

    assertTransition({ from: existing.status, to: "draft", by: "artist" });
    if (existing.status === "draft") return existing;

    const row = await tx.one<ArtworkRow>(
      `update artworks set status = 'draft' where id = $1 returning ${ARTWORK_COLUMNS}`,
      [artworkId],
    );
    return toArtwork(row);
  });
}

/**
 * Admin takedown. One-way (see lifecycle.ts).
 *
 * moderation-admin: takedown "SHALL NOT affect orders already placed for that
 * artwork", so this deliberately does not touch reservations and does not check
 * them. A takedown of a piece that is mid-checkout removes it from the catalog
 * and leaves the buyer's order alone, which is the intended asymmetry with
 * unlisting: an artist may not pull a listing out from under a buyer, and an
 * admin removing stolen work must be able to.
 *
 * The reason is not stored here. `moderation` owns `admin_audit` and the artist
 * notification, and the caller records both -- this function does not pretend
 * to (`shared/config`'s `setConfig` makes the same disclaimer for the same
 * reason).
 */
export async function removeArtwork(
  deps: ArtworksDeps,
  adminId: string,
  artworkId: string,
): Promise<Artwork> {
  await assertActive(deps.db, adminId);

  return deps.db.withTransaction(async (tx) => {
    const existing = await loadForActor(tx, artworkId, adminId, "admin");
    assertTransition({ from: existing.status, to: "removed", by: "admin" });
    if (existing.status === "removed") return existing;

    const row = await tx.one<ArtworkRow>(
      `update artworks set status = 'removed' where id = $1 returning ${ARTWORK_COLUMNS}`,
      [artworkId],
    );
    return toArtwork(row);
  });
}

/**
 * Recompute `sold` from derived availability.
 *
 * The seam `orders` calls after confirming an order and after releasing a
 * reservation. It is `system`-actor only: no route reaches it, and no artist
 * can mark their own work sold.
 *
 * Both directions, deliberately. An edition of ten that sells its last unit
 * becomes `sold`; if one of those orders is then cancelled, the derived
 * availability goes back to one and the artwork returns to `published` on its
 * own. That is what "availability is derived" buys -- with a counter column,
 * the return path is a second piece of code that someone has to remember to
 * write, and the failure mode is an edition that stays sold out forever with
 * stock sitting in the artist's studio.
 *
 * Runs inside the caller's transaction when given one, so `orders` can confirm
 * and reconcile atomically under the lock it already holds.
 */
export async function reconcileAvailability(
  deps: ArtworksDeps,
  artworkId: string,
  tx?: Tx,
): Promise<ArtworkWithAvailability> {
  const run = async (handle: Tx): Promise<ArtworkWithAvailability> => {
    const locked = await lockArtworkForUpdate(handle, artworkId);
    if (locked === null) {
      throw AppError.notFound("Artwork not found", { code: "artworks.not_found" });
    }

    const demand = await deps.demand.demandFor(handle, artworkId);
    const availability = availabilityFor(locked, demand);

    const target =
      locked.status === "published" && availability.availableUnits === 0
        ? "sold"
        : locked.status === "sold" && availability.availableUnits > 0
          ? "published"
          : null;

    if (target === null) return { artwork: locked, availability };

    assertTransition({ from: locked.status, to: target, by: "system" });
    const row = await handle.one<ArtworkRow>(
      `update artworks set status = $2 where id = $1 returning ${ARTWORK_COLUMNS}`,
      [artworkId, target],
    );
    const artwork = toArtwork(row);
    return { artwork, availability: availabilityFor(artwork, demand) };
  };

  return tx ? run(tx) : deps.db.withTransaction(run);
}

/** Read one artwork as its own artist or an admin sees it, in any state. */
export async function findOwnArtwork(
  deps: ArtworksDeps,
  actorId: string,
  artworkId: string,
  actor: Actor = "artist",
): Promise<ArtworkWithAvailability> {
  const artwork = await loadForActor(deps.db, artworkId, actorId, actor);
  return withAvailability(deps, deps.db, artwork);
}
