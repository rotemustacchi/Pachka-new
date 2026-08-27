/**
 * Publishing: the closed taxonomy, the mandatory specification, and the two
 * declarations.
 *
 * Every rejection scenario in `artwork-listings` has a test here asserting the
 * rejection, because ARCHITECTURE.md's test policy makes that mandatory and
 * because the rejections are the entire product requirement -- the MVP gives a
 * buyer no way to ask the artist a question, so a listing that publishes
 * incomplete is a listing that cannot be bought with confidence.
 *
 * Nothing is mocked. The database is real, the migrations are real, and the
 * code under test is the code that runs in production.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "@/shared/db";
import {
  artistDashboard,
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  findPublicArtwork,
  publishArtwork,
  updateArtwork,
  AI_ASSISTED_LABEL,
  MAX_STYLES,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import { useTestDatabase } from "../harness";

async function seedArtist(
  db: Database,
  options: { readonly verified?: boolean; readonly suspended?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, $2)", [
    id,
    options.verified === false ? null : new Date(),
  ]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [
    id,
  ]);
  if (options.suspended) {
    await db.query("update account_status set suspended_at = now() where user_id = $1", [id]);
  }
  return id;
}

/**
 * A complete, publishable listing.
 *
 * `textile_clothing` because it is the one medium that needs neither a depth
 * nor a framing answer, which keeps every test that is not about those two
 * conditional fields from having to carry them.
 */
const COMPLETE: ArtworkInput = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים, בשכבות דקות.",
  priceAgorot: 125_000,
  heightCm: 100,
  widthCm: 70,
  weightGrams: 1850,
  materials: "אקריליק על בד פשתן",
  leadTimeDays: 5,
  medium: "textile_clothing",
  styles: ["minimalist"],
  moods: ["calm"],
  affirmsOriginality: true,
  aiAssisted: false,
};

function deps(db: Database): ArtworksDeps {
  return depsWithoutOrdersOrMatchmaker(db);
}

describe("the taxonomy is a closed, server-defined set", () => {
  const database = useTestDatabase();

  it("accepts a complete classification and publishes", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, COMPLETE);

    const published = await publishArtwork(d, artistId, draft.id);

    expect(published.status).toBe("published");
    expect(published.medium).toBe("textile_clothing");
    expect(published.styles).toEqual(["minimalist"]);
    expect(published.moods).toEqual(["calm"]);
  });

  it("rejects a medium outside the set, naming the value and the permitted ones", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);

    await expect(createDraft(d, artistId, { ...COMPLETE, medium: "sculpture" })).rejects.toMatchObject(
      { kind: "validation", code: "artworks.taxonomy_value_outside_set" },
    );
  });

  it("rejects a style outside the set rather than silently dropping it", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);

    await expect(
      createDraft(d, artistId, { ...COMPLETE, styles: ["minimalist", "coastal_minimal"] }),
    ).rejects.toMatchObject({ kind: "validation", code: "artworks.taxonomy_value_outside_set" });

    // Nothing was written. A rejected classification must not leave a
    // half-classified draft behind for the artist to find later.
    const { rows } = await database.db.query("select id from artworks where artist_id = $1", [
      artistId,
    ]);
    expect(rows).toEqual([]);
  });

  it("rejects a taxonomy value outside the set on an edit as well as on create", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, COMPLETE);

    await expect(
      updateArtwork(d, artistId, draft.id, { moods: ["serene"] }),
    ).rejects.toMatchObject({ code: "artworks.taxonomy_value_outside_set" });

    const after = await database.db.one<{ moods: string[] }>(
      "select moods from artworks where id = $1",
      [draft.id],
    );
    expect(after.moods).toEqual(["calm"]);
  });

  it("blocks publication when no style is selected, identifying the axis", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, styles: [] });

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      kind: "validation",
      code: "artworks.incomplete_for_publication",
      details: { missing: ["styles"] },
    });
  });

  it("blocks publication when no mood is selected, identifying the axis", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, moods: [] });

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      details: { missing: ["moods"] },
    });
  });

  /**
   * SECURITY.md S2-20, "taxonomy stuffing": claiming every style maximises
   * taxonomy overlap in the matchmaker's scoring function and ranks the artwork
   * into every result set.
   */
  it("refuses more styles than the cap, rather than truncating the artist's choice", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);

    await expect(
      createDraft(d, artistId, {
        ...COMPLETE,
        styles: ["minimalist", "abstract", "boho_coastal", "modern_industrial", "pop_art"],
      }),
    ).rejects.toMatchObject({
      code: "artworks.taxonomy_axis_over_cap",
      details: { axis: "styles", max: MAX_STYLES },
    });
  });

  it("collapses duplicates and normalises order, so equal classifications compare equal", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);

    const draft = await createDraft(d, artistId, {
      ...COMPLETE,
      styles: ["pop_art", "minimalist", "pop_art"],
    });

    expect(draft.styles).toEqual(["minimalist", "pop_art"]);
  });
});

describe("the mandatory specification fields", () => {
  const database = useTestDatabase();

  /**
   * artwork-listings: publication is blocked and the system "lists every
   * missing field". Not the first one -- all of them, in one response.
   */
  it("lists every missing field at once rather than one per attempt", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, {
      ...COMPLETE,
      heightCm: null,
      widthCm: null,
      weightGrams: null,
      leadTimeDays: null,
    });

    const error = await publishArtwork(d, artistId, draft.id).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: "validation", code: "artworks.incomplete_for_publication" });
    expect((error as { details: { missing: string[] } }).details.missing).toEqual([
      "heightMm",
      "widthMm",
      "weightGrams",
      "leadTimeDays",
    ]);
    // Every one of them carries a message the form can render in place.
    const fields = (error as { fields: Record<string, string[]> }).fields;
    expect(Object.keys(fields).sort()).toEqual(
      ["heightMm", "leadTimeDays", "weightGrams", "widthMm"].sort(),
    );
  });

  it("leaves the artwork in draft when publication is refused", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, weightGrams: null });

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      kind: "validation",
    });

    const after = await database.db.one<{ status: string; published_at: Date | null }>(
      "select status, published_at from artworks where id = $1",
      [draft.id],
    );
    expect(after.status).toBe("draft");
    expect(after.published_at).toBeNull();
  });

  it("requires a depth for a three-dimensional medium and not for a flat one", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const vase = await createDraft(d, artistId, { ...COMPLETE, medium: "ceramics_objects" });

    await expect(publishArtwork(d, artistId, vase.id)).rejects.toMatchObject({
      details: { missing: ["depthMm"] },
    });

    const published = await publishArtwork(d, artistId, vase.id, { depthCm: 16 });
    expect(published.status).toBe("published");
    expect(published.depthMm).toBe(160);
  });

  it("requires the framing answer for a wall-mounted medium", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const painting = await createDraft(d, artistId, {
      ...COMPLETE,
      medium: "painting_illustration",
    });

    await expect(publishArtwork(d, artistId, painting.id)).rejects.toMatchObject({
      details: { missing: ["isFramed"] },
    });

    // "Not framed" is a complete answer. Only the absence of one blocks.
    const published = await publishArtwork(d, artistId, painting.id, { isFramed: false });
    expect(published.status).toBe("published");
    expect(published.isFramed).toBe(false);
  });

  /** artwork-listings: "Specifications rendered to buyers". */
  it("shows dimensions, weight, materials, framing and lead time to a buyer", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, {
      ...COMPLETE,
      medium: "painting_illustration",
      isFramed: true,
    });
    await publishArtwork(d, artistId, draft.id);

    const page = await findPublicArtwork(d, draft.id);

    expect(page.dimensionsFormatted).toBe("100 × 70 ס״מ");
    expect(page.weightFormatted).toBe("1,850 גרם");
    expect(page.materials).toBe("אקריליק על בד פשתן");
    expect(page.isFramed).toBe(true);
    expect(page.leadTimeDays).toBe(5);
    expect(page.priceFormatted).toBe("₪1,250.00");
  });

  /**
   * Dimensions are stored as exact millimetres and spoken about in centimetres.
   * A half-centimetre must survive the round trip without becoming 28.499999.
   */
  it("stores a fractional centimetre exactly", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, heightCm: 28.5, widthCm: 16.3 });

    expect(draft.heightMm).toBe(285);
    expect(draft.widthMm).toBe(163);

    await publishArtwork(d, artistId, draft.id);
    const page = await findPublicArtwork(d, draft.id);
    expect(page.dimensionsFormatted).toBe("28.5 × 16.3 ס״מ");
  });
});

describe("the originality declaration", () => {
  const database = useTestDatabase();

  it("records the account identifier and a timestamp when the artist affirms it", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const before = new Date();

    const draft = await createDraft(d, artistId, COMPLETE);
    const published = await publishArtwork(d, artistId, draft.id);

    expect(published.originality).not.toBeNull();
    expect(published.originality?.declaredBy).toBe(artistId);
    expect(new Date(published.originality!.declaredAt).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
  });

  it("blocks publication without the affirmation", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, affirmsOriginality: false });

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      details: { missing: ["originality"] },
    });
  });

  it("blocks publication when the question was never reached at all", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    // The field is absent from the input entirely, not set to false: an artist
    // who never reached the declaration step is a different situation from one
    // who unticked it, and both must block.
    const withoutDeclaration: ArtworkInput = { ...COMPLETE };
    delete (withoutDeclaration as { affirmsOriginality?: boolean }).affirmsOriginality;
    const draft = await createDraft(d, artistId, withoutDeclaration);

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      details: { missing: ["originality"] },
    });
  });

  /**
   * The record has to survive the artist editing the listing afterwards -- it
   * is an attributable affirmation, not a form field. An edit that does not
   * touch the declaration must not silently re-date it either.
   */
  it("keeps the original timestamp when the artist edits something else", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, COMPLETE);
    const published = await publishArtwork(d, artistId, draft.id);

    const edited = await updateArtwork(d, artistId, draft.id, { title: "קו החוף, זריחה" });

    expect(edited.title).toBe("קו החוף, זריחה");
    expect(edited.originality?.declaredAt).toBe(published.originality?.declaredAt);
  });

  it("cannot be attributed to another account by the request", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const someoneElse = randomUUID();

    // There is no input field for this at all: the affirming account is taken
    // from the authenticated actor, server-side.
    const draft = await createDraft(d, artistId, {
      ...COMPLETE,
      ...({ originalityDeclaredBy: someoneElse } as Partial<ArtworkInput>),
    });

    expect(draft.originality?.declaredBy).toBe(artistId);
  });
});

describe("the AI-assistance declaration", () => {
  const database = useTestDatabase();

  it("blocks publication when the question is unanswered", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, aiAssisted: null });

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      details: { missing: ["aiAssisted"] },
    });
  });

  it("treats an unanswered question as different from answering no", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const unanswered = await createDraft(d, artistId, { ...COMPLETE, aiAssisted: null });
    const answeredNo = await createDraft(d, artistId, { ...COMPLETE, aiAssisted: false });

    expect(unanswered.aiAssisted).toBeNull();
    expect(answeredNo.aiAssisted).toBe(false);

    await expect(publishArtwork(d, artistId, unanswered.id)).rejects.toMatchObject({
      details: { missing: ["aiAssisted"] },
    });
    expect((await publishArtwork(d, artistId, answeredNo.id)).status).toBe("published");
  });

  it("shows the label on the detail page when AI assistance is declared", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, aiAssisted: true });
    await publishArtwork(d, artistId, draft.id);

    const page = await findPublicArtwork(d, draft.id);

    expect(page.aiAssisted).toBe(true);
    expect(page.aiAssistedLabel).toBe(AI_ASSISTED_LABEL);
  });

  it("shows no label when the artist declared no AI assistance", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, { ...COMPLETE, aiAssisted: false });
    await publishArtwork(d, artistId, draft.id);

    const page = await findPublicArtwork(d, draft.id);

    expect(page.aiAssisted).toBe(false);
    expect(page.aiAssistedLabel).toBeNull();
  });
});

describe("who may publish", () => {
  const database = useTestDatabase();

  /** accounts-and-profiles gates publishing on a verified address. */
  it("refuses an artist whose email address is not verified", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db, { verified: false });
    const draft = await createDraft(d, artistId, COMPLETE);

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      kind: "forbidden",
      code: "accounts.email_not_verified",
    });
  });

  /**
   * SECURITY.md S1-13: a Supabase access token stays valid for its full
   * lifetime after suspension, so "cannot sign in" has to be backed by "cannot
   * act". This is the server-side half of that.
   */
  it("refuses a suspended artist holding a token from before the suspension", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, COMPLETE);

    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      artistId,
    ]);

    await expect(publishArtwork(d, artistId, draft.id)).rejects.toMatchObject({
      kind: "forbidden",
      code: "artworks.account_suspended",
    });
  });

  it("does not let an artist publish an artwork belonging to someone else", async () => {
    const d = deps(database.db);
    const owner = await seedArtist(database.db);
    const stranger = await seedArtist(database.db);
    const draft = await createDraft(d, owner, COMPLETE);

    // `not_found`, not `forbidden`: "this one is not yours" is a lookup oracle
    // (SECURITY.md S3-29).
    await expect(publishArtwork(d, stranger, draft.id)).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("free text on a public page", () => {
  const database = useTestDatabase();

  /**
   * SECURITY.md S2-19: the MVP has no buyer-artist messaging channel, so the
   * artwork description is the obvious place to put a phone number and take the
   * transaction off-platform. Same scanner `accounts` uses, called through its
   * public API rather than reimplemented.
   */
  it("refuses a phone number in the description", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);

    await expect(
      createDraft(d, artistId, { ...COMPLETE, description: "לפרטים חייגו 050-1234567" }),
    ).rejects.toMatchObject({
      kind: "validation",
      code: "artworks.contact_details_not_permitted",
    });
  });

  it("refuses an email address in the title", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);

    await expect(
      createDraft(d, artistId, { ...COMPLETE, title: "yael@example.com" }),
    ).rejects.toMatchObject({ code: "artworks.contact_details_not_permitted" });
  });
});

describe("the artist dashboard", () => {
  const database = useTestDatabase();

  it("shows what still stands between a draft and publication", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    await createDraft(d, artistId, { ...COMPLETE, weightGrams: null, leadTimeDays: null });

    const dashboard = await artistDashboard(d, artistId);

    expect(dashboard.listings).toHaveLength(1);
    expect(dashboard.listings[0]?.missingForPublication.map((r) => r.field)).toEqual([
      "weightGrams",
      "leadTimeDays",
    ]);
  });

  it("reports nothing missing for a published artwork", async () => {
    const d = deps(database.db);
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(d, artistId, COMPLETE);
    await publishArtwork(d, artistId, draft.id);

    const dashboard = await artistDashboard(d, artistId);

    expect(dashboard.listings[0]?.missingForPublication).toEqual([]);
    expect(dashboard.listings[0]?.priceFormatted).toBe("₪1,250.00");
  });
});
