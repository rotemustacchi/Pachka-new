/**
 * /catalog and /artworks/[artworkId] — what those two routes actually serve.
 *
 * These are route tests, so they test what a route is for. The catalog route's
 * whole job is that a URL and a rendered grid say the same thing; the artwork
 * route's is that everything catalog-browse requires on the page is on it, and
 * that a piece which cannot be bought carries no way to buy it.
 *
 * Nothing is mocked. The database is real, the migrations are real, the
 * visibility rules are production's, and the demand source is `orders`' own
 * `sqlInventoryDemand` — wired the way `_lib/deps.ts` wires it for the running
 * application, so an availability answer here is the answer a visitor gets.
 * `createElement` rather than JSX only because the integration project compiles
 * `.ts`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createDraft,
  publishArtwork,
  unlistArtwork,
  removeArtwork,
  type ArtworkInput,
} from "@/modules/artworks";
import {
  ArtworkDetailView,
  CatalogView,
  browseCatalog,
  catalogHref,
  findCatalogArtwork,
  parseCatalogQuery,
  toSearchParams,
  DEFAULT_SORT,
  NO_FILTERS,
  type CatalogQuery,
} from "@/modules/catalog";
import { returnTerms } from "@/modules/shipping";
import { agorot } from "@/shared/money";
import { isAppError } from "@/shared/errors";
import { catalogDeps } from "@/app/_lib/deps";
import { renderCardImage, renderDetailImage, storageUrl } from "@/app/_lib/images";
import { shippingRangeFor } from "@/app/_shipping/range";
import { AddToCartForm } from "@/app/_cart/AddToCartForm";
import { grantAdminRole, useTestDatabase, type TestDatabase } from "../harness";

/**
 * The storage origin the image loader builds URLs against.
 *
 * Set here rather than in the harness because it is this route's dependency,
 * not the database's: `publicEnv()` parses lazily and caches, so a value set
 * before the first render is the value the loader uses.
 */
beforeAll(() => {
  process.env["NEXT_PUBLIC_SUPABASE_URL"] ??= "https://stub.supabase.co";
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??= "anon-key-for-tests";
});

// ---------------------------------------------------------------------------
// Seeding — the same shape catalog-browse.test.ts uses, for the same reasons.
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

async function publish(
  database: TestDatabase,
  artistId: string,
  overrides: Partial<ArtworkInput> = {},
): Promise<string> {
  const deps = catalogDeps(database.db);
  const draft = await createDraft(deps, artistId, { ...COMPLETE, ...overrides });
  await publishArtwork(deps, artistId, draft.id);
  return draft.id;
}

async function attachPrimaryImage(database: TestDatabase, artworkId: string): Promise<void> {
  await database.db.query(
    `insert into artwork_images (artwork_id, original_path, display_path, alt_text, position)
     values ($1, $2, $3, 'ציור של קו חוף בשקיעה', 0)`,
    [artworkId, `${artworkId}/original.jpg`, `${artworkId}/display.jpg`],
  );
}

/** Exactly what `/catalog/page.tsx` does, with the test's database handle. */
async function serveCatalog(database: TestDatabase, url: string): Promise<string> {
  const { query, ignored } = parseCatalogQuery(new URL(url, "https://pachka.test").searchParams);
  const page = await browseCatalog(catalogDeps(database.db), query);
  return renderToStaticMarkup(
    createElement(CatalogView, { page, ignored, renderImage: renderCardImage }),
  );
}

/** Exactly what `/artworks/[artworkId]/page.tsx` does. */
async function serveArtwork(database: TestDatabase, artworkId: string): Promise<string> {
  const detail = await findCatalogArtwork(catalogDeps(database.db), artworkId);
  const [terms, shippingRange] = await Promise.all([
    returnTerms(database.db),
    shippingRangeFor(database.db, detail.artwork),
  ]);

  return renderToStaticMarkup(
    createElement(ArtworkDetailView, {
      artwork: detail.artwork,
      artist: detail.artist,
      artistProfileIsPublic: detail.artistProfileIsPublic,
      returnTerms: terms,
      shippingRange,
      purchaseAction: createElement(AddToCartForm, { artworkId: detail.artwork.id }),
      renderImage: renderDetailImage,
    }),
  );
}

// ---------------------------------------------------------------------------

describe("the catalog route", () => {
  const database = useTestDatabase();

  it("reproduces the view its URL describes, so a filtered link is shareable", async () => {
    const artist = await seedArtist(database);
    const minimal = await publish(database, artist, {
      title: "קווים מס׳ 7",
      styles: ["minimalist"],
    });
    await publish(database, artist, { title: "מעגלים, פופ", styles: ["pop_art"] });
    await attachPrimaryImage(database, minimal);

    const query: CatalogQuery = {
      filters: { ...NO_FILTERS, styles: ["minimalist"] },
      sort: DEFAULT_SORT,
      page: 1,
    };

    // The link the module itself would write, served back through the route.
    const markup = await serveCatalog(database, catalogHref(query));

    expect(markup).toContain("קווים מס׳ 7");
    expect(markup).not.toContain("מעגלים, פופ");
  });

  it("round-trips a filter through the URL without drift", () => {
    const query: CatalogQuery = {
      filters: {
        ...NO_FILTERS,
        media: ["textile_clothing"],
        styles: ["minimalist"],
        moods: ["calm"],
        maxPriceAgorot: agorot(200_000),
      },
      sort: "price_asc",
      page: 2,
    };

    // What the address bar holds, parsed back the way the route parses it.
    expect(parseCatalogQuery(toSearchParams(query)).query).toEqual(query);
  });

  it("says the catalog is empty rather than blaming the filters, before any artist joins", async () => {
    const markup = await serveCatalog(database, "/catalog");

    // PACHKA launches with zero artists, so this is what the first visitors
    // see. The two empty states say opposite things, and telling someone to
    // clear filters they never set sends them round a loop — so the empty
    // catalog invites an artist in instead.
    expect(markup).toContain("הקטלוג עוד מחכה ליצירה הראשונה");
    expect(markup).toContain("/become-an-artist");
    expect(markup).not.toContain("ניקוי כל הסינון");
  });

  it("builds every image URL against the display bucket", async () => {
    const artist = await seedArtist(database);
    const artwork = await publish(database, artist);
    await attachPrimaryImage(database, artwork);

    const markup = await serveCatalog(database, "/catalog");

    expect(markup).toContain(storageUrl(`${artwork}/display.jpg`));
    // The originals bucket holds the artist's full-resolution file and is not
    // a public read path.
    expect(markup).not.toContain("artwork-originals");
  });
});

describe("the artwork route", () => {
  const database = useTestDatabase();

  it("carries the whole specification set, because nothing else on the site does", async () => {
    const artist = await seedArtist(database);
    const artwork = await publish(database, artist);
    await attachPrimaryImage(database, artwork);

    const markup = await serveArtwork(database, artwork);

    // catalog-browse names these in one requirement. The MVP has no
    // buyer-to-artist messaging, so a buyer who cannot read a dimension here
    // cannot read it anywhere.
    expect(markup).toContain("100 × 70 ס״מ"); // dimensions
    expect(markup).toContain("אקריליק על בד פשתן"); // materials
    expect(markup).toContain("יעל שוורץ"); // the artist's display name
    expect(markup).toContain(COMPLETE.description ?? "");
  });

  it("shows the return terms the module configures, not a number typed into a page", async () => {
    const artist = await seedArtist(database);
    const artwork = await publish(database, artist);

    const terms = await returnTerms(database.db);
    const markup = await serveArtwork(database, artwork);

    expect(markup).toContain(`${terms.windowDays} יום להחזרה`);
    for (const statement of terms.statements) expect(markup).toContain(statement.text);
  });

  it("estimates shipping as a band from the configured rate table", async () => {
    const artist = await seedArtist(database);
    const artwork = await publish(database, artist);

    const detail = await findCatalogArtwork(catalogDeps(database.db), artwork);
    const range = await shippingRangeFor(database.db, detail.artwork);

    // A real range from the seeded zone x tier table — not a placeholder, and
    // never a single figure, because the zone depends on an address nobody has
    // entered yet.
    expect(range).toBeDefined();
    expect(range?.minAgorot).toBeLessThanOrEqual(range?.maxAgorot ?? 0);
    expect(await serveArtwork(database, artwork)).toContain("משלוח מוערך");
  });

  it("offers the purchase action while the piece can be bought", async () => {
    const artist = await seedArtist(database);
    const artwork = await publish(database, artist);

    expect(await serveArtwork(database, artwork)).toContain("הוספה לעגלה");
  });

  it("renders an unlisted piece read-only, with no way to buy it", async () => {
    const artist = await seedArtist(database);
    const artwork = await publish(database, artist);
    await unlistArtwork(catalogDeps(database.db), artist, artwork);

    const markup = await serveArtwork(database, artwork);

    // The route passes `purchaseAction` unconditionally; the VIEW withholds it.
    // That is the point — a route cannot forget the check because it never
    // makes it.
    expect(markup).not.toContain("הוספה לעגלה");
    expect(markup).toContain(COMPLETE.title ?? "");
  });

  it("answers not-found for a removed artwork, the same way it does for one that never existed", async () => {
    const artist = await seedArtist(database);
    const admin = randomUUID();
    await database.db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [
      admin,
    ]);
    await database.db.query("insert into account_status (user_id, verified_at) values ($1, now())", [
      admin,
    ]);
    await grantAdminRole(database, admin);

    const artwork = await publish(database, artist);
    await removeArtwork(catalogDeps(database.db), admin, artwork);

    const removed = await findCatalogArtwork(catalogDeps(database.db), artwork).catch(
      (error: unknown) => error,
    );
    const nonexistent = await findCatalogArtwork(catalogDeps(database.db), randomUUID()).catch(
      (error: unknown) => error,
    );

    // Identical answers. Two different ones would tell a prober that they had
    // guessed a real id — the same enumeration oracle the artist route avoids.
    expect(isAppError(removed) && removed.kind).toBe("not_found");
    expect(isAppError(nonexistent) && nonexistent.kind).toBe("not_found");
  });

  it("refuses a malformed id without letting it reach Postgres", async () => {
    const error = await findCatalogArtwork(catalogDeps(database.db), "not-a-uuid").catch(
      (caught: unknown) => caught,
    );

    // A type error from the database would be a 500, and a 500 that differs
    // from the 404 is another way to tell a prober they got the shape right.
    expect(isAppError(error) && error.kind).toBe("not_found");
  });
});
