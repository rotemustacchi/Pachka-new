/**
 * The legal surface and the crawlable surface, against a real database.
 *
 * TWO THINGS ARE BEING PROVEN HERE, AND NEITHER IS "IT RENDERS"
 * ------------------------------------------------------------
 * 1. THE RETURNS POLICY IS THE CONFIGURED POLICY. `returns.window_days` and
 *    `returns.cancellation_fee_rate` are `app_config` values an operator can
 *    change without a deployment, and three separate surfaces disclose them:
 *    the artwork page, the checkout summary, and this policy page. A policy
 *    page with "14 ימים" typed into it passes a rendering test and becomes a
 *    false disclosure the moment an operator changes the window — which, for a
 *    document that exists to satisfy a distance-selling disclosure duty, is the
 *    whole risk. So the window is changed here and the page is required to
 *    follow, exactly as `routes-return-terms.test.ts` does for the panel.
 *
 * 2. THE SITEMAP LISTS WHAT A VISITOR CAN ACTUALLY OPEN. `sitemapEntries` is
 *    driven with the real `catalogDeps` over a real database holding a real
 *    published artwork, so "the catalog is the SEO surface" is proven rather
 *    than asserted — and the private surfaces are proven absent from it, which
 *    is the half that matters. A certificate URL in a sitemap would undo the
 *    unguessable-identifier design that `certificates` is built around.
 *
 * Nothing is mocked. `createElement` rather than JSX only because the
 * integration project compiles `.ts`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createDraft, publishArtwork, type ArtworkInput } from "@/modules/artworks";
import { returnTerms } from "@/modules/shipping";
import { getConfig, setConfig } from "@/shared/config";
import { catalogDeps } from "@/app/_lib/deps";
import { ReturnsDocument } from "@/app/(legal)/returns/page";
import robots, { DISALLOWED_PATHS } from "@/app/robots";
import { sitemapEntries, STATIC_PATHS } from "@/app/sitemap";
import { useTestDatabase, type TestDatabase } from "../harness";

const SITE_URL = "https://pachka.test";

/**
 * `robots()` reads `publicEnv()`, which validates the whole public environment
 * rather than the one key it wants — so the Supabase pair has to be present
 * even though nothing here talks to Supabase. Set here rather than in the
 * harness because it is this route's dependency and not the database's, and
 * before the first call because `publicEnv()` parses lazily and caches.
 * `routes-catalog.test.ts` does the same for the image loader.
 */
beforeAll(() => {
  process.env["NEXT_PUBLIC_SUPABASE_URL"] ??= "https://stub.supabase.co";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??= "anon-key-for-tests";
  process.env["NEXT_PUBLIC_SITE_URL"] ??= SITE_URL;
});

// ---------------------------------------------------------------------------
// Seeding — the same shape routes-catalog.test.ts uses, for the same reasons.
// ---------------------------------------------------------------------------

async function seedArtist(database: TestDatabase, displayName = "יעל שוורץ"): Promise<string> {
  const db = database.db;
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, $2)", [id, displayName]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  await db.query("insert into user_roles (user_id, role) values ($1, 'artist')", [id]);
  await db.query(
    "insert into artist_profiles (user_id, display_name, city) values ($1, $2, 'תל אביב')",
    [id, displayName],
  );
  return id;
}

/** `textile_clothing`: the one medium needing neither a depth nor a framing answer. */
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

async function publish(database: TestDatabase, artistId: string): Promise<string> {
  const deps = catalogDeps(database.db);
  const draft = await createDraft(deps, artistId, COMPLETE);
  await publishArtwork(deps, artistId, draft.id);
  return draft.id;
}

/** Exactly what `/returns/page.tsx` does, with the test's database handle. */
async function serveReturns(database: TestDatabase): Promise<string> {
  const [terms, refundsOutboundShipping] = await Promise.all([
    returnTerms(database.db),
    getConfig(database.db, "returns.refund_includes_outbound_shipping"),
  ]);

  return renderToStaticMarkup(
    createElement(ReturnsDocument, { terms, refundsOutboundShipping }),
  );
}

describe("the returns policy page", () => {
  const database = useTestDatabase();

  it("renders every statement the shipping module publishes, so three surfaces cannot drift", async () => {
    const terms = await returnTerms(database.db);

    const markup = await serveReturns(database);

    for (const statement of terms.statements) {
      expect(markup).toContain(statement.text);
    }
  });

  it("makes the two disclosures Israeli distance-selling law turns on", async () => {
    const markup = await serveReturns(database);

    // Who pays to send it back, and who carries the risk if it breaks on the
    // way. A buyer who learns either of these after cancelling was told late.
    expect(markup).toContain("עלות משלוח ההחזרה חלה על הקונה");
    expect(markup).toContain("האחריות לנזק");
  });

  it("says returns go to PACHKA and never to the artist", async () => {
    const markup = await serveReturns(database);

    expect(markup).toContain("כתובת ההחזרות של פאצ׳קה");
    // The reason, not just the rule: the artist's home address is the thing
    // being protected, on the outbound label as much as the return one.
    expect(markup).toContain("כתובתו הפרטית של האמן");
  });

  it("follows the configured window rather than a number typed into the page", async () => {
    await setConfig(database.db, "returns.window_days", 21);

    const markup = await serveReturns(database);

    expect(markup).toContain("21");
    expect(markup).not.toContain(">14<");
  });

  it("follows the configured cancellation fee, and says so only when one is charged", async () => {
    const withoutFee = await serveReturns(database);
    expect(withoutFee).toContain("לא נגבים דמי ביטול");

    await setConfig(database.db, "returns.cancellation_fee_rate", 0.05);
    const withFee = await serveReturns(database);

    expect(withFee).toContain("5%");
    expect(withFee).not.toContain("לא נגבים דמי ביטול");
  });

  it("states the outbound-shipping decision the refund calculation actually uses", async () => {
    // `false` is the shipped default and the conservative reading of the law.
    expect(await getConfig(database.db, "returns.refund_includes_outbound_shipping")).toBe(false);
    expect(await serveReturns(database)).toContain("אינם מוחזרים");

    await setConfig(database.db, "returns.refund_includes_outbound_shipping", true);
    expect(await serveReturns(database)).toContain("מוחזרים לו");
  });

  it("marks the open questions rather than answering them", async () => {
    const markup = await serveReturns(database);

    // The cancellation-fee decision and the return address are not facts this
    // repository can invent. See docs/launch-readiness.md.
    expect(markup).toContain("לבדיקת עו״ד");
    expect(markup).toContain("להשלמה על ידי המפעיל");
  });
});

describe("robots.txt", () => {
  it("lets a crawler at the catalog, which is the reason the catalog exists", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;

    expect(rule?.userAgent).toBe("*");
    expect(rule?.allow).toBe("/");
  });

  it("keeps every private surface out of the index", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallow = rule?.disallow ?? [];
    const disallowed = Array.isArray(disallow) ? disallow : [disallow];

    // The four the brief names, plus the auth routes and the two match
    // handlers. `/certificates` is the load-bearing one: the identifiers are
    // unguessable by design and rate limited against enumeration, and a
    // crawler that indexed one would undo both.
    expect(disallowed).toEqual(
      expect.arrayContaining([
        "/admin",
        "/studio",
        "/checkout",
        "/certificates",
        "/orders",
        "/sign-in",
      ]),
    );
  });

  it("points at an absolute sitemap URL", () => {
    expect(robots().sitemap).toMatch(/^https?:\/\/.+\/sitemap\.xml$/);
  });
});

describe("the sitemap", () => {
  const database = useTestDatabase();

  it("lists a published artwork and its artist", async () => {
    const artistId = await seedArtist(database);
    const artworkId = await publish(database, artistId);

    const urls = (await sitemapEntries(catalogDeps(database.db), SITE_URL)).map((e) => e.url);

    expect(urls).toContain(`${SITE_URL}/artworks/${artworkId}`);
    expect(urls).toContain(`${SITE_URL}/artists/${artistId}`);
  });

  it("lists an artist once however many works they have published", async () => {
    const artistId = await seedArtist(database, "נועה ברק");
    await publish(database, artistId);
    await publish(database, artistId);

    const urls = (await sitemapEntries(catalogDeps(database.db), SITE_URL)).map((e) => e.url);
    const artistUrls = urls.filter((url) => url === `${SITE_URL}/artists/${artistId}`);

    expect(artistUrls).toHaveLength(1);
  });

  it("lists the public pages including the three legal documents", async () => {
    const urls = (await sitemapEntries(catalogDeps(database.db), SITE_URL)).map((e) => e.url);

    for (const { path } of STATIC_PATHS) {
      expect(urls).toContain(new URL(path, SITE_URL).toString());
    }
    expect(urls).toContain(`${SITE_URL}/catalog`);
    expect(urls).toContain(`${SITE_URL}/terms`);
  });

  it("lists nothing robots.txt disallows", async () => {
    await publish(database, await seedArtist(database, "רות אלון"));

    const urls = (await sitemapEntries(catalogDeps(database.db), SITE_URL)).map((e) => e.url);

    expect(urls.length).toBeGreaterThan(STATIC_PATHS.length); // not vacuous
    for (const url of urls) {
      const pathname = new URL(url).pathname;
      for (const blocked of DISALLOWED_PATHS) {
        expect(pathname, `${pathname} is in the sitemap and disallowed by robots.txt`).not.toMatch(
          new RegExp(`^${blocked}(/|$)`),
        );
      }
    }
  });

  it("does not list an unpublished artwork", async () => {
    const artistId = await seedArtist(database, "עמית שגב");
    const draft = await createDraft(catalogDeps(database.db), artistId, COMPLETE);

    const urls = (await sitemapEntries(catalogDeps(database.db), SITE_URL)).map((e) => e.url);

    expect(urls).not.toContain(`${SITE_URL}/artworks/${draft.id}`);
  });
});
