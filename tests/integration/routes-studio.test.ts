/**
 * The artist's studio routes: what the upload form actually does.
 *
 * These are route tests, so they test what a route is for -- that an
 * unauthenticated visitor is redirected, that a submission reaches the module
 * and changes a row, that a refusal comes back as something a form can render,
 * and that one artist cannot address another artist's artwork.
 *
 * Nothing is mocked. `artworks` is real, the database is real, and the form
 * data is real `FormData` built the way the browser would build it. A test that
 * asserted "the module was called" would prove the wiring exists and nothing
 * about whether it works.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "@/shared/db";
import {
  asPublishCandidate,
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  findOwnArtwork,
  missingForPublication,
  remainingRequirementCount,
  type ArtworkInput,
  type ArtworksDeps,
} from "@/modules/artworks";
import { readArtworkInput, submitArtworkForm } from "@/app/studio/artwork-form";
import { toCandidate, valuesOf } from "@/app/studio/artworks/[artworkId]/values";
import { SIGN_IN_PATH, signedInOrRedirect } from "@/app/_lib/viewer";
import { useTestDatabase } from "../harness";

function deps(db: Database): ArtworksDeps {
  return depsWithoutOrdersOrMatchmaker(db);
}

async function seedArtist(db: Database, verified = true): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, $2)", [
    id,
    verified ? new Date() : null,
  ]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  return id;
}

/**
 * The form as the browser would post it.
 *
 * Arrays get the `.present` marker the parser looks for, because that marker is
 * how "the axis was on the page and nothing is selected" is told apart from
 * "the axis was not submitted at all".
 */
function formOf(values: Readonly<Record<string, string | readonly string[]>>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      form.set(`${key}.present`, "1");
      for (const entry of value) form.append(key, entry);
    } else {
      form.set(key, value as string);
    }
  }
  return form;
}

/** Everything a listing needs, as the form posts it. */
const COMPLETE = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים, בשכבות דקות.",
  priceShekels: "1,250.00",
  heightCm: "100",
  widthCm: "70",
  weightGrams: "1850",
  materials: "אקריליק על בד פשתן",
  leadTimeDays: "5",
  medium: "textile_clothing",
  styles: ["minimalist"],
  moods: ["calm"],
  targetSpaces: [] as readonly string[],
  inventoryType: "unique",
  madeToOrder: "no",
  affirmsOriginality: "yes",
  aiAssisted: "no",
} as const;

describe("an unauthenticated visitor", () => {
  it("is redirected to sign in rather than shown an empty studio", () => {
    // `redirect()` works by throwing; the digest is the whole answer.
    expect(() => signedInOrRedirect(null)).toThrowError(
      expect.objectContaining({ digest: `NEXT_REDIRECT;replace;${SIGN_IN_PATH};307;` }),
    );
  });

  it("is not redirected once signed in", () => {
    const id = randomUUID();
    expect(signedInOrRedirect(id)).toBe(id);
  });
});

describe("reading the form", () => {
  it("tells an absent field from a blank one", () => {
    // Absent means "this section was not submitted, leave it alone"; blank
    // means "clear it". Getting this wrong makes saving one step wipe another.
    const input = readArtworkInput(formOf({ title: "" }));

    expect(input.title).toBeNull();
    expect(input.description).toBeUndefined();
    expect(input.materials).toBeUndefined();
  });

  it("reads an empty axis as an empty selection, not as an absent one", () => {
    const input = readArtworkInput(formOf({ styles: [] }));

    expect(input.styles).toEqual([]);
    expect(input.moods).toBeUndefined();
  });

  it("reads the unanswered AI question as unanswered", () => {
    const input = readArtworkInput(formOf({ affirmsOriginality: "yes" }));

    expect(input.aiAssisted).toBeUndefined();
    expect(readArtworkInput(formOf({ aiAssisted: "no" })).aiAssisted).toBe(false);
  });

  it("turns a shekel string into whole agorot without ever making a float", () => {
    expect(readArtworkInput(formOf({ priceShekels: "1,250.50" })).priceAgorot).toBe(125_050);
  });
});

describe("saving a draft", () => {
  const database = useTestDatabase();

  it("writes what the artist typed", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId);

    const state = await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ ...COMPLETE, artworkId: draft.id, intent: "save" }),
    );

    expect(state.status).toBe("ok");

    const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);
    expect(artwork.title).toBe(COMPLETE.title);
    expect(artwork.priceAgorot).toBe(125_000);
    // Typed in centimetres, stored in millimetres.
    expect(artwork.heightMm).toBe(1000);
    expect(artwork.styles).toEqual(["minimalist"]);
    expect(artwork.status).toBe("draft");
  });

  it("leaves the sections the form did not submit alone", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId, {
      title: "קו החוף, שקיעה",
      materials: "אקריליק על בד פשתן",
    } satisfies ArtworkInput);

    await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ artworkId: draft.id, weightGrams: "1850" }),
    );

    const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);
    expect(artwork.weightGrams).toBe(1850);
    expect(artwork.materials).toBe("אקריליק על בד פשתן");
    expect(artwork.title).toBe("קו החוף, שקיעה");
  });

  it("reports an unreadable price against the field the artist typed it in", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId);

    const state = await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ artworkId: draft.id, priceShekels: "בערך אלף", title: "קו החוף" }),
    );

    expect(state.status).toBe("error");
    expect(state.fields?.priceAgorot?.[0]).toBeTruthy();

    // And nothing was written: the whole submission is refused, so the artist
    // does not have to work out which half of it landed.
    const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);
    expect(artwork.title).toBeNull();
  });

  it("refuses a taxonomy value outside the closed set", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId);

    const state = await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ artworkId: draft.id, styles: ["graffiti"] }),
    );

    expect(state.status).toBe("error");
  });

  it("answers not-found for another artist's artwork, and says nothing more", async () => {
    const owner = await seedArtist(database.db);
    const stranger = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), owner);

    const state = await submitArtworkForm(
      deps(database.db),
      stranger,
      formOf({ artworkId: draft.id, title: "לא שלי" }),
    );

    // Not "forbidden": that would confirm the artwork exists (SECURITY.md
    // S3-29). The message is the module's, unchanged.
    expect(state).toMatchObject({ status: "error", message: "Artwork not found" });

    const { artwork } = await findOwnArtwork(deps(database.db), owner, draft.id);
    expect(artwork.title).toBeNull();
  });
});

describe("publishing from the form", () => {
  const database = useTestDatabase();

  it("lists every missing field at once rather than one per round trip", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId);

    const state = await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ artworkId: draft.id, intent: "publish", title: "קו החוף, שקיעה" }),
    );

    expect(state.status).toBe("error");
    const fields = Object.keys(state.fields ?? {});
    expect(fields).toEqual(
      expect.arrayContaining([
        "description",
        "priceAgorot",
        "medium",
        "styles",
        "moods",
        "heightMm",
        "widthMm",
        "weightGrams",
        "materials",
        "leadTimeDays",
        "originality",
        "aiAssisted",
      ]),
    );
    // Every message is the artist's language, ready to render next to a field.
    expect(state.fields?.["aiAssisted"]?.[0]).toContain("בינה מלאכותית");
  });

  it("publishes a complete listing", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId);

    const state = await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ ...COMPLETE, artworkId: draft.id, intent: "publish" }),
    );

    expect(state.status).toBe("ok");

    const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);
    expect(artwork.status).toBe("published");
  });

  it("refuses to publish for an unverified address, and says so in the banner", async () => {
    const artistId = await seedArtist(database.db, false);
    const draft = await createDraft(deps(database.db), artistId);

    const state = await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ ...COMPLETE, artworkId: draft.id, intent: "publish" }),
    );

    expect(state.status).toBe("error");
    expect(state.message).toBeTruthy();

    const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);
    expect(artwork.status).toBe("draft");
  });
});

/**
 * The number on the publish button has to be the number the server will give.
 *
 * The form counts from `toCandidate(valuesOf(artwork))` — strings, as an input
 * holds them — and the server counts from `asPublishCandidate(artwork)` — the
 * stored row. If those two ever disagree the button says "ready" while the
 * publish says "four fields missing", and the artist has no way to reconcile
 * the two. So they are asserted equal against real rows, in several states of
 * completeness, rather than assumed equal because both call the same function.
 */
describe("what the form counts and what the server counts", () => {
  const database = useTestDatabase();

  const STATES: readonly ArtworkInput[] = [
    {},
    { title: "קו החוף, שקיעה", medium: "textile_clothing" },
    { title: "קו החוף", description: "תיאור", priceAgorot: 125_000 },
    // A three-dimensional medium, which adds the conditional depth requirement.
    { medium: "ceramics_objects", styles: ["minimalist"], moods: ["calm"] },
    // Made to order, which adds the production lead time and refuses a unique piece.
    { medium: "textile_clothing", inventoryType: "edition", stock: 5, madeToOrder: true },
  ];

  it("agree, for every state of a real draft", async () => {
    const artistId = await seedArtist(database.db);

    for (const input of STATES) {
      const draft = await createDraft(deps(database.db), artistId, input);
      const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);

      const asTheFormSeesIt = toCandidate(valuesOf(artwork));
      const asTheServerSeesIt = asPublishCandidate(artwork);

      expect(missingForPublication(asTheFormSeesIt).map((r) => r.field)).toEqual(
        missingForPublication(asTheServerSeesIt).map((r) => r.field),
      );
      expect(remainingRequirementCount(asTheFormSeesIt)).toBe(
        remainingRequirementCount(asTheServerSeesIt),
      );
    }
  });

  it("agree once every field is filled in, so the button reads zero exactly when publish succeeds", async () => {
    const artistId = await seedArtist(database.db);
    const draft = await createDraft(deps(database.db), artistId);

    await submitArtworkForm(
      deps(database.db),
      artistId,
      formOf({ ...COMPLETE, artworkId: draft.id }),
    );

    const { artwork } = await findOwnArtwork(deps(database.db), artistId, draft.id);
    expect(remainingRequirementCount(toCandidate(valuesOf(artwork)))).toBe(0);
    expect(remainingRequirementCount(asPublishCandidate(artwork))).toBe(0);
  });
});
