/**
 * The public catalog — tasks 5.1 through 5.5, against real PostgreSQL.
 *
 * Every scenario in `catalog-browse` that concerns the listing surface has a
 * test here, and the exclusions get more of them than the happy path: an
 * artwork that should have disappeared and did not is a buyer being offered
 * something that cannot be sold to them, which is the failure this module can
 * actually cause.
 *
 * Nothing is mocked. The database is real, the migrations are real, the
 * visibility rules are the ones production runs, and the suite connects as a
 * non-superuser so a missing grant or policy fails loudly.
 *
 * The one injected thing is `InventoryDemandSource`, which `artworks` defines
 * and exports precisely so `orders` can implement it — it does not exist yet,
 * so this file supplies it, backed by a real table rather than a canned return
 * value. That is supplying a port, not mocking PACHKA's own logic:
 * `artworks-inventory.test.ts` and `moderation-takedown.test.ts` do the same.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sql } from "@/shared/db";
import { nonNegativeAgorot } from "@/shared/money";
import {
  createDraft,
  depsWithoutOrdersOrMatchmaker,
  publishArtwork,
  reconcileAvailability,
  removeArtwork,
  unlistArtwork,
  type ArtworkInput,
  type ArtworksDeps,
  type InventoryDemand,
  type InventoryDemandSource,
} from "@/modules/artworks";
import {
  DEFAULT_QUERY,
  NO_FILTERS,
  browseCatalog,
  catalogHref,
  findCatalogArtwork,
  parseCatalogQuery,
  type CatalogQuery,
} from "@/modules/catalog";
import {
  defineScratchTable,
  grantAdminRole,
  useTestDatabase,
  asAnon,
  type TestDatabase,
} from "../harness";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seedArtist(
  database: TestDatabase,
  displayName = "יעל שוורץ",
): Promise<string> {
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

async function seedAdmin(database: TestDatabase): Promise<string> {
  const db = database.db;
  const id = randomUUID();
  await db.query("insert into profiles (user_id, display_name) values ($1, 'מנהלת')", [id]);
  await db.query("insert into account_status (user_id, verified_at) values ($1, now())", [id]);
  // Out of band: SECURITY.md S0-2 item 4 puts granting `admin` outside the app.
  await grantAdminRole(database, id);
  return id;
}

/**
 * A complete, publishable listing.
 *
 * `textile_clothing` is the default because it is the one medium needing
 * neither a depth nor a framing answer, which keeps a test about filtering from
 * carrying fields that have nothing to do with filtering.
 */
const COMPLETE: ArtworkInput = {
  title: "קו החוף, שקיעה",
  description: "ציור שנעשה בחוף פולג בשעת בין ערביים.",
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

/** Media that also need a depth, and media that also need a framing answer. */
function completeFor(input: ArtworkInput): ArtworkInput {
  const medium = input.medium ?? COMPLETE.medium;
  const needsDepth = medium === "ceramics_objects" || medium === "jewelry";
  const needsFraming = medium === "painting_illustration" || medium === "photography";

  return {
    ...COMPLETE,
    ...(needsDepth ? { depthCm: 20 } : {}),
    ...(needsFraming ? { isFramed: true } : {}),
    ...input,
  };
}

interface PublishOptions extends ArtworkInput {
  /** Pinned so "newest first" has a defined answer rather than a racy one. */
  readonly publishedAt?: string;
}

async function publish(
  deps: ArtworksDeps,
  database: TestDatabase,
  artistId: string,
  overrides: PublishOptions = {},
): Promise<string> {
  const { publishedAt, ...input } = overrides;
  const draft = await createDraft(deps, artistId, completeFor(input));
  await publishArtwork(deps, artistId, draft.id);

  if (publishedAt !== undefined) {
    // Set directly rather than through the module: `publishArtwork` stamps
    // `now()`, and several artworks published inside one test would otherwise
    // tie to the millisecond and make an ordering assertion depend on the clock.
    // This is fixture arrangement, not a code path under test.
    await database.db.query("update artworks set published_at = $2 where id = $1", [
      draft.id,
      publishedAt,
    ]);
  }

  return draft.id;
}

async function attachPrimaryImage(database: TestDatabase, artworkId: string): Promise<void> {
  await database.db.query(
    `insert into artwork_images (artwork_id, original_path, display_path, alt_text, position)
     values ($1, $2, $3, 'ציור של קו חוף בשקיעה', 0)`,
    [artworkId, `${artworkId}/original.jpg`, `${artworkId}/display.jpg`],
  );
}

// ---------------------------------------------------------------------------
// The port `orders` will implement
// ---------------------------------------------------------------------------

async function createOrderHolds(database: TestDatabase): Promise<void> {
  await defineScratchTable(
    database,
    "test_order_holds",
    `create table test_order_holds (
      id         uuid primary key default gen_random_uuid(),
      artwork_id uuid not null references artworks (id),
      units      integer not null check (units > 0),
      state      text not null check (state in ('held', 'confirmed', 'released'))
    )`,
  );
}

const orderHolds: InventoryDemandSource = {
  async demandFor(sql: Sql, artworkId: string): Promise<InventoryDemand> {
    const row = await sql.one<{ reserved: string; sold: string }>(
      `select coalesce(sum(units) filter (where state = 'held'), 0)::text      as reserved,
              coalesce(sum(units) filter (where state = 'confirmed'), 0)::text as sold
         from test_order_holds where artwork_id = $1`,
      [artworkId],
    );
    return { reservedUnits: Number(row.reserved), soldUnits: Number(row.sold) };
  },

  async demandForMany(sql: Sql, artworkIds: readonly string[]) {
    const demand = new Map<string, InventoryDemand>(
      artworkIds.map((id) => [id, { reservedUnits: 0, soldUnits: 0 }] as const),
    );
    if (artworkIds.length === 0) return demand;

    const { rows } = await sql.query<{ artwork_id: string; reserved: string; sold: string }>(
      `select artwork_id,
              coalesce(sum(units) filter (where state = 'held'), 0)::text      as reserved,
              coalesce(sum(units) filter (where state = 'confirmed'), 0)::text as sold
         from test_order_holds
        where artwork_id = any($1::uuid[])
        group by artwork_id`,
      [artworkIds],
    );
    for (const row of rows) {
      demand.set(row.artwork_id, {
        reservedUnits: Number(row.reserved),
        soldUnits: Number(row.sold),
      });
    }
    return demand;
  },
};

const withOrders = (database: TestDatabase): ArtworksDeps => ({
  ...depsWithoutOrdersOrMatchmaker(database.db),
  demand: orderHolds,
});

const idsOf = (page: { entries: readonly { artwork: { id: string } }[] }) =>
  page.entries.map((entry) => entry.artwork.id);

const filtered = (filters: Partial<CatalogQuery["filters"]>): CatalogQuery => ({
  ...DEFAULT_QUERY,
  filters: { ...NO_FILTERS, ...filters },
});

// ---------------------------------------------------------------------------

describe("an anonymous visitor browses the catalog", () => {
  const database = useTestDatabase();

  it("sees published artworks with image, title, artist name and price, without an account", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);
    await attachPrimaryImage(database, artworkId);

    // No session, no claims, no user id anywhere in the call.
    const page = await browseCatalog(deps);

    expect(page.entries).toHaveLength(1);
    const [entry] = page.entries;
    expect(entry!.artwork.title).toBe("קו החוף, שקיעה");
    expect(entry!.artwork.priceFormatted).toBe("₪1,250.00");
    expect(entry!.artist.displayName).toBe("יעל שוורץ");
    expect(entry!.artwork.images[0]!.displayPath).toBe(`${artworkId}/display.jpg`);
  });

  it("gets the same published rows straight off the data API with nothing but the anon key", async () => {
    // The surface that actually matters: RLS and grants are the only things in
    // the way there, and this asserts the policy agrees with the module's query
    // about which artworks are public.
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const published = await publish(deps, database, artistId);
    await createDraft(deps, artistId, completeFor({}));

    const page = await browseCatalog(deps);

    const anonRows = await asAnon(database.dataApi, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("select id from artworks");
      return rows;
    });

    expect(idsOf(page)).toEqual([published]);
    expect(anonRows.map((row) => row.id)).toEqual([published]);
  });

  it("never shows a draft", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    await createDraft(deps, artistId, completeFor({}));

    const page = await browseCatalog(deps);

    expect(page.entries).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe("artworks that must not appear", () => {
  const database = useTestDatabase();

  it("drops a sold artwork from results", async () => {
    await createOrderHolds(database);
    const deps = withOrders(database);
    const artistId = await seedArtist(database);
    const soldId = await publish(deps, database, artistId);
    const stillForSaleId = await publish(deps, database, artistId, { title: "יצירה שנייה" });

    expect(idsOf(await browseCatalog(deps))).toHaveLength(2);

    // The sale, through the path `orders` will use: a confirmed hold consumes
    // the only unit, and reconciliation moves the artwork to `sold`.
    await database.db.query(
      "insert into test_order_holds (artwork_id, units, state) values ($1, 1, 'confirmed')",
      [soldId],
    );
    const { artwork } = await reconcileAvailability(deps, soldId);
    expect(artwork.status).toBe("sold");

    const page = await browseCatalog(deps);

    expect(idsOf(page)).toEqual([stillForSaleId]);
    expect(page.total).toBe(1);
  });

  it("drops an unlisted artwork from results", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const unlistedId = await publish(deps, database, artistId);
    const visibleId = await publish(deps, database, artistId, { title: "יצירה שנייה" });

    await unlistArtwork(deps, artistId, unlistedId);

    expect(idsOf(await browseCatalog(deps))).toEqual([visibleId]);
  });

  it("drops a removed artwork from results", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const removedId = await publish(deps, database, artistId);
    const visibleId = await publish(deps, database, artistId, { title: "יצירה שנייה" });
    const adminId = await seedAdmin(database);

    await removeArtwork(deps, adminId, removedId);

    expect(idsOf(await browseCatalog(deps))).toEqual([visibleId]);
  });

  it("withdraws a suspended artist's published artworks without touching their rows", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const suspendedArtist = await seedArtist(database, "אמנית מושעית");
    const activeArtist = await seedArtist(database, "אמנית פעילה");
    const hiddenId = await publish(deps, database, suspendedArtist);
    const visibleId = await publish(deps, database, activeArtist);

    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      suspendedArtist,
    ]);

    expect(idsOf(await browseCatalog(deps))).toEqual([visibleId]);

    // Derived, not bulk-updated: the artwork is still `published`, so lifting
    // the suspension restores exactly the previous state (SECURITY.md S1-13).
    const row = await database.db.one<{ status: string }>(
      "select status from artworks where id = $1",
      [hiddenId],
    );
    expect(row.status).toBe("published");
  });
});

describe("filtering, combined across axes", () => {
  const database = useTestDatabase();

  /** The spec's own scenario: ceramics, calm, ₪200–₪600. */
  async function seedCombinationFixture(deps: ArtworksDeps) {
    const artistId = await seedArtist(database);

    const match = await publish(deps, database, artistId, {
      title: "אגרטל חימר, ידני",
      medium: "ceramics_objects",
      moods: ["calm"],
      priceAgorot: 48_000,
    });
    const wrongMedium = await publish(deps, database, artistId, {
      title: "מדיום לא מתאים",
      medium: "jewelry",
      moods: ["calm"],
      priceAgorot: 48_000,
    });
    const wrongMood = await publish(deps, database, artistId, {
      title: "וייב לא מתאים",
      medium: "ceramics_objects",
      moods: ["bold"],
      priceAgorot: 48_000,
    });
    const wrongPrice = await publish(deps, database, artistId, {
      title: "מחיר לא מתאים",
      medium: "ceramics_objects",
      moods: ["calm"],
      priceAgorot: 90_000,
    });

    return { match, wrongMedium, wrongMood, wrongPrice };
  }

  it("returns only artworks satisfying all three conditions", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { match } = await seedCombinationFixture(deps);

    const page = await browseCatalog(
      deps,
      filtered({
        media: ["ceramics_objects"],
        moods: ["calm"],
        minPriceAgorot: nonNegativeAgorot(20_000),
        maxPriceAgorot: nonNegativeAgorot(60_000),
      }),
    );

    expect(idsOf(page)).toEqual([match]);
    expect(page.total).toBe(1);
  });

  it("fails any one condition and the artwork is out — each axis on its own", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { match, wrongMedium, wrongMood, wrongPrice } = await seedCombinationFixture(deps);

    const byMedium = await browseCatalog(deps, filtered({ media: ["ceramics_objects"] }));
    expect(idsOf(byMedium)).not.toContain(wrongMedium);
    expect(idsOf(byMedium)).toContain(match);

    const byMood = await browseCatalog(deps, filtered({ moods: ["calm"] }));
    expect(idsOf(byMood)).not.toContain(wrongMood);

    const byPrice = await browseCatalog(
      deps,
      filtered({ minPriceAgorot: nonNegativeAgorot(20_000), maxPriceAgorot: nonNegativeAgorot(60_000) }),
    );
    expect(idsOf(byPrice)).not.toContain(wrongPrice);
  });

  it("treats two values on one axis as OR, so a second tick widens rather than narrows", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { match, wrongMedium } = await seedCombinationFixture(deps);

    const page = await browseCatalog(deps, filtered({ media: ["ceramics_objects", "jewelry"] }));

    expect(idsOf(page)).toContain(match);
    expect(idsOf(page)).toContain(wrongMedium);
  });

  it("filters on style and target space, which are array columns", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);

    const wanted = await publish(deps, database, artistId, {
      styles: ["abstract", "pop_art"],
      targetSpaces: ["living_room", "kitchen"],
    });
    await publish(deps, database, artistId, {
      title: "אחרת",
      styles: ["minimalist"],
      targetSpaces: ["bedroom"],
    });

    expect(idsOf(await browseCatalog(deps, filtered({ styles: ["pop_art"] })))).toEqual([wanted]);
    expect(idsOf(await browseCatalog(deps, filtered({ targetSpaces: ["kitchen"] })))).toEqual([
      wanted,
    ]);
  });

  it("includes an artwork priced exactly on a range boundary", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const atFloor = await publish(deps, database, artistId, { priceAgorot: 20_000 });
    const atCeiling = await publish(deps, database, artistId, {
      title: "בתקרה",
      priceAgorot: 60_000,
    });

    const page = await browseCatalog(
      deps,
      filtered({ minPriceAgorot: nonNegativeAgorot(20_000), maxPriceAgorot: nonNegativeAgorot(60_000) }),
    );

    expect(idsOf(page).sort()).toEqual([atFloor, atCeiling].sort());
  });
});

describe("a filter combination that matches nothing", () => {
  const database = useTestDatabase();

  it("says nothing matched rather than raising", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    await publish(deps, database, artistId, { medium: "ceramics_objects", moods: ["calm"] });

    // A combination no artwork satisfies. This must resolve, not throw.
    const page = await browseCatalog(deps, filtered({ media: ["jewelry"], moods: ["edgy"] }));

    expect(page.entries).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.pageCount).toBe(0);
  });

  it("distinguishes an over-narrow filter from an empty catalog", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    await publish(deps, database, artistId, { medium: "ceramics_objects" });

    const page = await browseCatalog(deps, filtered({ media: ["jewelry"] }));

    // The two empty states say opposite things, and telling this visitor that
    // PACHKA has no artists would be a lie about a catalog they can see is full.
    expect(page.total).toBe(0);
    expect(page.catalogIsEmpty).toBe(false);
  });

  it("reports an empty catalog when nothing at all is published", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);

    const page = await browseCatalog(deps);

    expect(page.entries).toEqual([]);
    expect(page.catalogIsEmpty).toBe(true);
  });

  it("still reports an empty catalog when a filter is applied to one", async () => {
    // A visitor who arrives on a launch-day PACHKA by way of a shared filtered
    // link must be invited to join, not told to clear a filter that would
    // change nothing.
    const deps = depsWithoutOrdersOrMatchmaker(database.db);

    const page = await browseCatalog(deps, filtered({ moods: ["calm"] }));

    expect(page.catalogIsEmpty).toBe(true);
  });

  it("does not call a catalog empty when the only artworks are drafts and removals", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const adminId = await seedAdmin(database);
    await createDraft(deps, artistId, completeFor({}));
    const removedId = await publish(deps, database, artistId, { title: "הוסרה" });
    await removeArtwork(deps, adminId, removedId);

    const page = await browseCatalog(deps);

    // Nothing is publicly visible, so it IS empty — the invitation is the right
    // message even though rows exist.
    expect(page.catalogIsEmpty).toBe(true);
  });
});

describe("sorting", () => {
  const database = useTestDatabase();

  async function seedThreePrices(deps: ArtworksDeps) {
    const artistId = await seedArtist(database);
    const cheapOldest = await publish(deps, database, artistId, {
      title: "זולה וישנה",
      priceAgorot: 39_000,
      publishedAt: "2026-01-01T09:00:00Z",
    });
    const middleNewest = await publish(deps, database, artistId, {
      title: "אמצעית וחדשה",
      priceAgorot: 64_000,
      publishedAt: "2026-03-01T09:00:00Z",
    });
    const dearMiddle = await publish(deps, database, artistId, {
      title: "יקרה",
      priceAgorot: 138_000,
      publishedAt: "2026-02-01T09:00:00Z",
    });
    return { cheapOldest, middleNewest, dearMiddle };
  }

  it("puts the most recently published first by default", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { cheapOldest, middleNewest, dearMiddle } = await seedThreePrices(deps);

    const page = await browseCatalog(deps);

    expect(idsOf(page)).toEqual([middleNewest, dearMiddle, cheapOldest]);
  });

  it("sorts by price ascending", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { cheapOldest, middleNewest, dearMiddle } = await seedThreePrices(deps);

    const page = await browseCatalog(deps, { ...DEFAULT_QUERY, sort: "price_asc" });

    expect(idsOf(page)).toEqual([cheapOldest, middleNewest, dearMiddle]);
  });

  it("sorts by price descending", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { cheapOldest, middleNewest, dearMiddle } = await seedThreePrices(deps);

    const page = await browseCatalog(deps, { ...DEFAULT_QUERY, sort: "price_desc" });

    expect(idsOf(page)).toEqual([dearMiddle, middleNewest, cheapOldest]);
  });

  it("sorts and filters together", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const { cheapOldest, middleNewest } = await seedThreePrices(deps);

    const page = await browseCatalog(deps, {
      ...filtered({ maxPriceAgorot: nonNegativeAgorot(70_000) }),
      sort: "price_asc",
    });

    expect(idsOf(page)).toEqual([cheapOldest, middleNewest]);
  });
});

describe("pagination", () => {
  const database = useTestDatabase();

  it("splits a catalog into pages that between them contain every artwork exactly once", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);

    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      expected.push(
        await publish(deps, database, artistId, {
          title: `יצירה ${index}`,
          // Identical prices AND identical timestamps: the case where an
          // unstable sort silently drops or repeats a row between pages.
          priceAgorot: 50_000,
          publishedAt: "2026-04-01T09:00:00Z",
        }),
      );
    }

    const first = await browseCatalog(deps, DEFAULT_QUERY, { pageSize: 2 });
    const second = await browseCatalog(deps, { ...DEFAULT_QUERY, page: 2 }, { pageSize: 2 });
    const third = await browseCatalog(deps, { ...DEFAULT_QUERY, page: 3 }, { pageSize: 2 });

    expect(first.total).toBe(5);
    expect(first.pageCount).toBe(3);
    expect(idsOf(first)).toHaveLength(2);
    expect(idsOf(third)).toHaveLength(1);

    const seen = [...idsOf(first), ...idsOf(second), ...idsOf(third)];
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...expected].sort());
  });

  it("counts every match, not just the ones on this page", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    for (let index = 0; index < 3; index += 1) {
      await publish(deps, database, artistId, { title: `יצירה ${index}` });
    }

    const page = await browseCatalog(deps, DEFAULT_QUERY, { pageSize: 1 });

    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it("still knows the real total when a visitor overshoots the last page", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    await publish(deps, database, artistId);

    const page = await browseCatalog(deps, { ...DEFAULT_QUERY, page: 9 });

    // The page carries its total in a window function, which arrives attached
    // to a row -- so an over-range page has no rows and no total with it. If
    // that were allowed to read as zero, the result count would blank and the
    // "previous page" link would disappear, leaving no way back.
    expect(page.entries).toEqual([]);
    expect(page.total).toBe(1);
    expect(page.pageCount).toBe(1);

    // And it must not tell the visitor that PACHKA has no artists.
    expect(page.catalogIsEmpty).toBe(false);
  });

  it("keeps the total honest past the last page of a FILTERED view too", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    await publish(deps, database, artistId, { moods: ["calm"] });
    await publish(deps, database, artistId, { title: "אחרת", moods: ["bold"] });

    const page = await browseCatalog(deps, { ...filtered({ moods: ["calm"] }), page: 4 });

    expect(page.total).toBe(1);
    expect(page.catalogIsEmpty).toBe(false);
  });
});

describe("a filtered view is shareable — it reproduces itself in a fresh session", () => {
  const database = useTestDatabase();

  it("gives a second session the same artworks from the URL alone", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);

    const wanted = await publish(deps, database, artistId, {
      title: "אגרטל חימר, ידני",
      medium: "ceramics_objects",
      moods: ["calm"],
      styles: ["boho_coastal"],
      priceAgorot: 48_000,
      publishedAt: "2026-05-01T09:00:00Z",
    });
    await publish(deps, database, artistId, { title: "אחרת", medium: "jewelry", moods: ["edgy"] });

    // Session one filters and copies the address bar.
    const chosen: CatalogQuery = {
      filters: {
        ...NO_FILTERS,
        media: ["ceramics_objects"],
        moods: ["calm"],
        styles: ["boho_coastal"],
        minPriceAgorot: nonNegativeAgorot(20_000),
        maxPriceAgorot: nonNegativeAgorot(60_000),
      },
      sort: "price_desc",
      page: 1,
    };
    const firstView = await browseCatalog(deps, chosen);
    const sharedLink = catalogHref(chosen);

    // Session two has nothing but the string: fresh deps, no cookies, no state.
    const freshDeps = depsWithoutOrdersOrMatchmaker(database.db);
    const { query: reconstructed, ignored } = parseCatalogQuery(
      new URLSearchParams(sharedLink.slice(sharedLink.indexOf("?") + 1)),
    );
    const secondView = await browseCatalog(freshDeps, reconstructed);

    expect(ignored).toEqual([]);
    expect(reconstructed).toEqual(chosen);
    expect(idsOf(secondView)).toEqual(idsOf(firstView));
    expect(idsOf(secondView)).toEqual([wanted]);
    expect(secondView.query.sort).toBe("price_desc");
  });

  it("carries the page number through the link too", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    for (let index = 0; index < 3; index += 1) {
      await publish(deps, database, artistId, {
        title: `יצירה ${index}`,
        priceAgorot: 10_000 * (index + 1),
      });
    }

    const onPageTwo: CatalogQuery = { ...DEFAULT_QUERY, sort: "price_asc", page: 2 };
    const link = catalogHref(onPageTwo);
    const { query } = parseCatalogQuery(new URLSearchParams(link.slice(link.indexOf("?") + 1)));

    const firstView = await browseCatalog(deps, onPageTwo, { pageSize: 1 });
    const secondView = await browseCatalog(deps, query, { pageSize: 1 });

    expect(query.page).toBe(2);
    expect(idsOf(secondView)).toEqual(idsOf(firstView));
    expect(idsOf(secondView)).toHaveLength(1);
  });
});

describe("the artwork detail page", () => {
  const database = useTestDatabase();

  it("carries the whole specification set a buyer needs to decide", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId, { yearCreated: 2026 });
    await attachPrimaryImage(database, artworkId);

    const detail = await findCatalogArtwork(deps, artworkId);

    expect(detail.artwork.dimensionsFormatted).toBe("100 × 70 ס״מ");
    expect(detail.artwork.weightGrams).toBe(1850);
    expect(detail.artwork.materials).toBe("אקריליק על בד פשתן");
    expect(detail.artwork.leadTimeDays).toBe(5);
    expect(detail.artwork.yearCreated).toBe(2026);
    expect(detail.artwork.medium?.value).toBe("textile_clothing");
    expect(detail.artwork.images).toHaveLength(1);
    expect(detail.artwork.purchasable).toBe(true);
  });

  it("names the artist and says their profile can be linked to", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);

    const detail = await findCatalogArtwork(deps, artworkId);

    expect(detail.artist.displayName).toBe("יעל שוורץ");
    expect(detail.artist.city).toBe("תל אביב");
    expect(detail.artistProfileIsPublic).toBe(true);
  });

  it("carries no artist contact detail, because the query never selects one", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    await database.db.query(
      `insert into artist_contact_details (user_id, email, phone)
       values ($1, 'yael@example.com', '0501234567')`,
      [artistId],
    );
    const artworkId = await publish(deps, database, artistId);

    const detail = await findCatalogArtwork(deps, artworkId);

    expect(JSON.stringify(detail)).not.toContain("yael@example.com");
    expect(JSON.stringify(detail)).not.toContain("0501234567");
  });

  it("resolves a sold artwork read-only, with nothing purchasable about it", async () => {
    await createOrderHolds(database);
    const deps = withOrders(database);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);

    await database.db.query(
      "insert into test_order_holds (artwork_id, units, state) values ($1, 1, 'confirmed')",
      [artworkId],
    );
    await reconcileAvailability(deps, artworkId);

    const detail = await findCatalogArtwork(deps, artworkId);

    // A buyer who bookmarked a piece that has since sold deserves the page, not
    // a 404 — but nothing on it may be a purchase action.
    expect(detail.artwork.status).toBe("sold");
    expect(detail.artwork.purchasable).toBe(false);
    expect(detail.artwork.soldOut).toBe(true);
    expect(detail.artwork.title).toBe("קו החוף, שקיעה");
  });

  it("resolves an unlisted artwork read-only", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);
    await unlistArtwork(deps, artistId, artworkId);

    const detail = await findCatalogArtwork(deps, artworkId);

    expect(detail.artwork.status).toBe("unlisted");
    expect(detail.artwork.purchasable).toBe(false);
  });

  it("returns not-found for an artwork an admin removed", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);
    const adminId = await seedAdmin(database);
    await removeArtwork(deps, adminId, artworkId);

    await expect(findCatalogArtwork(deps, artworkId)).rejects.toMatchObject({
      kind: "not_found",
      code: "artworks.not_found",
    });
  });

  it("returns not-found for a draft, so an id is not a probe for what exists", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const draft = await createDraft(deps, artistId, completeFor({}));

    await expect(findCatalogArtwork(deps, draft.id)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns not-found for a suspended artist's artwork", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);
    await database.db.query("update account_status set suspended_at = now() where user_id = $1", [
      artistId,
    ]);

    await expect(findCatalogArtwork(deps, artworkId)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("returns not-found for a malformed id rather than a database error", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);

    // An error page that differs from the not-found page tells a prober they
    // got the shape right (SECURITY.md S3-29).
    await expect(findCatalogArtwork(deps, "not-a-uuid")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("returns not-found for a well-formed id that belongs to nothing", async () => {
    const deps = depsWithoutOrdersOrMatchmaker(database.db);

    await expect(findCatalogArtwork(deps, randomUUID())).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("says the artist profile is not linkable when their only piece has sold", async () => {
    await createOrderHolds(database);
    const deps = withOrders(database);
    const artistId = await seedArtist(database);
    const artworkId = await publish(deps, database, artistId);

    await database.db.query(
      "insert into test_order_holds (artwork_id, units, state) values ($1, 1, 'confirmed')",
      [artworkId],
    );
    await reconcileAvailability(deps, artworkId);

    const detail = await findCatalogArtwork(deps, artworkId);

    // `accounts` publishes a profile only for an artist with something
    // PUBLISHED, so the name must render without a link to a page that 404s.
    expect(detail.artistProfileIsPublic).toBe(false);
    expect(detail.artist.displayName).toBe("יעל שוורץ");
  });
});
