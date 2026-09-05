/**
 * /match — what the matchmaker route actually serves.
 *
 * The states that matter most here are the ones a marketplace with no artists
 * in it produces, because that is what PACHKA launches as. So the empty and
 * nearly-empty answers get more tests than the happy path, and each of them
 * asserts the escape hatch is present — revise, browse the pre-filtered
 * catalog, or leave an address — because a buyer told "nothing matched" with no
 * way onward has been shown a dead end.
 *
 * The other half is the contract change: a budget ceiling AND both wall
 * dimensions are required, and a submission missing any of them has to come
 * back as a message beside the field rather than as a banner or a blank form.
 *
 * Nothing is mocked. The database is real, the migrations are real, and
 * `MatchScreen` is rendered to markup — the same function `page.tsx` mounts —
 * so what these tests execute is what a visitor receives. `createElement`
 * rather than JSX only because the integration project compiles `.ts`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/shared/db";
import { createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import {
  NO_MATCHES_MESSAGE,
  SPARSE_CATALOG_MESSAGE,
  consumeNotifyRateLimit,
  hashSubject,
} from "@/modules/matchmaker";
import { httpStatusFor, isAppError } from "@/shared/errors";
import { catalogDeps } from "@/app/_lib/deps";
import { errorResponse } from "@/app/_lib/error-response";
import { MatchScreen } from "@/app/match/MatchScreen";
import { answersFromParams, paramsFromForm, wasSubmitted } from "@/app/match/answers";
import { useTestDatabase, type TestDatabase } from "../harness";

beforeAll(() => {
  process.env["NEXT_PUBLIC_SUPABASE_URL"] ??= "https://stub.supabase.co";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??= "anon-key-for-tests";
});

const EMBEDDING_DIMENSIONS = 1024;

function vectorLiteral(): string {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  vector[EMBEDDING_DIMENSIONS - 1] = 0.1;
  return `[${vector.join(",")}]`;
}

async function seedArtist(db: Database): Promise<string> {
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query("insert into artist_profiles (user_id, display_name) values ($1, 'יעל שוורץ')", [id]);
  return id;
}

const COMPLETE: ArtworkInput = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים.",
  priceAgorot: 80_000,
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

/**
 * A published artwork the matchmaker can actually rank.
 *
 * The embedding row is the point: `fetchCandidates` INNER JOINs
 * `artwork_embeddings`, because "browsable but unmatched" is the absence of a
 * row rather than a flag. An artwork without one is published and browsable and
 * correctly invisible here.
 */
async function seedRankableArtwork(database: TestDatabase, artistId: string): Promise<string> {
  const deps = catalogDeps(database.db);
  const draft = await createDraft(deps, artistId, COMPLETE);
  await publishArtwork(deps, artistId, draft.id);

  const image = randomUUID();
  await database.db.query(
    `insert into artwork_images (id, artwork_id, original_path, display_path, position)
     values ($1, $2, $3, $4, 0)`,
    [image, draft.id, `${draft.id}/original.jpg`, `${draft.id}/display.webp`],
  );
  await database.db.query(
    `insert into artwork_embeddings (artwork_id, image_id, embedding, description, model)
     values ($1, $2, $3::vector, 'תיאור לבדיקה', 'test-embed-v1')`,
    [draft.id, image, vectorLiteral()],
  );
  return draft.id;
}

/** Exactly what `/match/page.tsx` mounts, with the test's database handle. */
async function serve(database: TestDatabase, query: string): Promise<string> {
  const fingerprint = hashSubject(`test-${randomUUID()}`);
  const screen = await MatchScreen({
    deps: { db: database.db },
    catalog: catalogDeps(database.db),
    params: new URLSearchParams(query),
    clientFingerprint: fingerprint,
    viewerFingerprint: fingerprint,
  });
  return renderToStaticMarkup(screen);
}

/** A complete, valid submission. */
const ANSWERED = "submitted=1&budgetMax=1500&wallHeight=120&wallWidth=180&styles=minimalist&moods=calm";

// ---------------------------------------------------------------------------

describe("the questionnaire", () => {
  const database = useTestDatabase();

  it("is what a first visit gets, with the budget named as the required answer", async () => {
    const markup = await serve(database, "");

    expect(markup).toContain("מה טווח התקציב?");
    expect(markup).toContain("(חובה)");
    // The whole taxonomy is on the page, so an answer is a choice from a closed
    // set rather than free text.
    expect(markup).toContain("אילו סגנונות מדברים אליכם?");
  });

  it("blocks a submission with no budget and says so beside the budget field", async () => {
    const markup = await serve(database, "submitted=1&budgetMax=&wallHeight=120&wallWidth=180");

    expect(markup).toContain("יש להזין תקציב");
    // Back on the form, not on an empty results page.
    expect(markup).toContain("מה טווח התקציב?");
  });

  it("requires BOTH wall dimensions, and names each missing one", async () => {
    const markup = await serve(database, "submitted=1&budgetMax=1500");

    // Both, not either: without an area there is nothing continuous to rank on,
    // so every artwork carrying the tags ties and "the top three" is arbitrary.
    expect(markup).toContain("יש להזין את רוחב הקיר");
    expect(markup).toContain("יש להזין את גובה הקיר");
  });

  it("names only the dimension that is actually missing", async () => {
    const markup = await serve(database, "submitted=1&budgetMax=1500&wallWidth=180");

    expect(markup).toContain("יש להזין את גובה הקיר");
    expect(markup).not.toContain("יש להזין את רוחב הקיר");
  });

  it("leaves no questionnaire row behind when it rejects a submission", async () => {
    await serve(database, "submitted=1&budgetMax=&wallHeight=120&wallWidth=180");

    const { rows } = await database.db.query<{ count: string }>(
      "select count(*)::text as count from match_queries",
    );
    // Parsed before the rate limit is consumed and before anything is written,
    // so a rejected submission costs the database nothing.
    expect(rows[0]?.count).toBe("0");
  });

  it("rejects an answer outside the closed taxonomy rather than quietly dropping it", async () => {
    const markup = await serve(database, `${ANSWERED}&styles=not-a-real-style`);

    // Rejected, and the buyer is told. A dropped answer would produce a ranking
    // they did not ask for with nothing saying so.
    //
    // The message arrives as the top-level banner rather than beside the style
    // chips: `parseAnswers` does return `fields: { styles: [...] }`, but
    // `QuestionnaireForm` renders `FieldError` only for the budget and the two
    // wall dimensions, so a taxonomy field message has nowhere to land. That is
    // the module's form to change and is reported rather than worked around
    // with a second form here.
    expect(markup).toContain("not a permitted styles answer");
    expect(markup).toContain("מה טווח התקציב?");
    // Emphatically NOT treated as a valid search.
    expect(markup).not.toContain(NO_MATCHES_MESSAGE);
  });
});

describe("the results", () => {
  const database = useTestDatabase();

  it("says plainly that nothing matched, on the catalog PACHKA launches with", async () => {
    const markup = await serve(database, ANSWERED);

    expect(markup).toContain(NO_MATCHES_MESSAGE);
  });

  it("offers all three doors even when it found nothing", async () => {
    const markup = await serve(database, ANSWERED);

    expect(markup).toContain("לשנות תשובות");
    expect(markup).toContain("לכל הקטלוג");
    expect(markup).toContain("רוצים שנעדכן כשיגיע משהו מתאים?");
  });

  it("points the catalog door at a catalog already filtered by the answers given", async () => {
    const markup = await serve(database, ANSWERED);

    // The escape hatch lands somewhere shaped by what the buyer already said,
    // not at the undifferentiated front page.
    expect(markup).toContain("styles=minimalist");
    expect(markup).toContain("/catalog?");
  });

  it("admits the community is small rather than padding the list", async () => {
    const artist = await seedArtist(database.db);
    await seedRankableArtwork(database, artist);

    const markup = await serve(database, ANSWERED);

    // One good match is one result, not five with four poor ones behind it.
    expect(markup).toContain(SPARSE_CATALOG_MESSAGE);
    expect(markup).toContain("קו החוף, שקיעה");
  });

  it("still offers the escape hatch when it did find something", async () => {
    const artist = await seedArtist(database.db);
    await seedRankableArtwork(database, artist);

    const markup = await serve(database, ANSWERED);

    // "Every matchmaker result view SHALL offer the buyer a way to continue" —
    // every, including a view with matches on it.
    expect(markup).toContain("לשנות תשובות");
    expect(markup).toContain("לכל הקטלוג");
  });

  it("acknowledges a notify-me without saying whether the address was new", async () => {
    const markup = await serve(database, `${ANSWERED}&notified=1`);

    expect(markup).toContain("אם הכתובת תקינה");
    // The form is gone, replaced by one constant acknowledgement. There is no
    // second wording for an address already stored.
    expect(markup).not.toContain('name="email"');
  });
});

describe("the answers in the URL", () => {
  it("survives the round trip a shared results link depends on", () => {
    const form = new FormData();
    form.set("budgetMax", "1500");
    form.set("wallHeight", "120");
    form.set("wallWidth", "180");
    form.set("medium", "textile_clothing");
    form.append("styles", "minimalist");
    form.append("moods", "calm");

    const params = paramsFromForm(form);

    expect(wasSubmitted(params)).toBe(true);
    expect(answersFromParams(params)).toEqual({
      budgetMax: "1500",
      wallHeight: "120",
      wallWidth: "180",
      medium: "textile_clothing",
      styles: ["minimalist"],
      targetSpaces: [],
      moods: ["calm"],
    });
  });

  it("keeps a blank budget in the URL, so the page can say it is missing", () => {
    const form = new FormData();
    form.set("budgetMax", "");
    form.set("medium", "");

    const params = paramsFromForm(form);

    // A dropped field is indistinguishable from one that was never on the form,
    // and the page's whole job on a blank budget is to say so.
    expect(params.get("budgetMax")).toBe("");
    expect(params.has("medium")).toBe(false);
  });
});

describe("a refused notify-me", () => {
  const database = useTestDatabase();

  it("comes back as 429, because the same request will succeed later", async () => {
    const client = hashSubject("192.0.2.7");
    const email = hashSubject("buyer@example.com");

    // Drive the real limiter until it genuinely refuses. No fabricated error:
    // this is the AppError the route would catch.
    let refusal: unknown;
    for (let attempt = 0; attempt < 200 && refusal === undefined; attempt += 1) {
      refusal = await consumeNotifyRateLimit(database.db, client, email).then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    expect(isAppError(refusal) && refusal.kind).toBe("rate_limited");
    // 429 and not 409: nothing about the request is wrong.
    expect(httpStatusFor(refusal)).toBe(429);
    expect(errorResponse(refusal).status).toBe(429);
  });
});
