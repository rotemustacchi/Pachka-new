/**
 * /sitemap.xml
 *
 * THE MEMBERSHIP QUESTION IS ANSWERED BY THE CATALOG, NOT BY A QUERY HERE
 * ----------------------------------------------------------------------
 * A sitemap must list exactly the artworks a visitor can actually open. A
 * `select ... from artworks where status = 'published'` written here would be a
 * route reading another module's table — the boundary violation ARCHITECTURE.md
 * names — and, worse, a second definition of "published" that can drift from
 * the one the catalog applies. `browseCatalog` already excludes suspended
 * artists and unpublished work, so an artwork appears here precisely when
 * `/artworks/<id>` renders rather than 404s, and an artist appears here
 * precisely when `/artists/<id>` does. `ArtistIndex.tsx` composes its page the
 * same way and for the same reason.
 *
 * WHY IT IS DYNAMIC
 * -----------------
 * Two reasons, and the second is the load-bearing one. A sitemap generated at
 * build time freezes the catalog as it was when the container was built. And
 * `npm run verify` runs `next build`, while CI's `checks` job has no database
 * at all — a sitemap that prerendered would make the build depend on a running
 * Postgres.
 *
 * WHY A DATABASE FAILURE IS NOT SWALLOWED
 * ---------------------------------------
 * The tempting `catch` here returns the eight static routes and nothing else.
 * That is the silent-degradation failure this codebase rejects everywhere else
 * — the unwired demand source raises rather than reporting zero, a screening
 * failure blocks rather than warns. A sitemap that quietly drops every artwork
 * looks fine in a browser and is discovered months later as a ranking problem
 * with no error attached to it. A 500 is loud, and a crawler treats it as
 * "retry later" rather than as "these pages are gone".
 */
import type { MetadataRoute } from "next";
import {
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  NO_FILTERS,
  browseCatalog,
  type CatalogDeps,
  type CatalogEntry,
} from "@/modules/catalog";
import { catalogDeps } from "@/app/_lib/deps";
import { publicEnv } from "@/shared/config/env";

export const dynamic = "force-dynamic";

/**
 * Public pages that exist whether or not anything is published.
 *
 * The three legal pages are here deliberately. They are low-priority, but a
 * terms page that no crawler has ever seen is a terms page nobody can produce
 * later as the version that was published on a given date.
 */
export const STATIC_PATHS = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/catalog", priority: 0.9, changeFrequency: "daily" },
  { path: "/match", priority: 0.8, changeFrequency: "monthly" },
  { path: "/artists", priority: 0.7, changeFrequency: "weekly" },
  { path: "/become-an-artist", priority: 0.6, changeFrequency: "monthly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
  { path: "/returns", priority: 0.3, changeFrequency: "yearly" },
] as const satisfies readonly {
  readonly path: string;
  readonly priority: number;
  readonly changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;
}[];

/**
 * The same bound `ArtistIndex` uses, for the same reason: PACHKA launches with
 * no artists and grows slowly, and an unbounded walk is a timed-out request
 * rather than a slow one. When the catalog outgrows this, the sitemap starts
 * under-reporting — which is the failure that shows up as a missing page rather
 * than as an outage, and is the point at which a paged sitemap index is worth
 * writing.
 */
const MAX_PAGES = 50;

async function publishedEntries(deps: CatalogDeps): Promise<readonly CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  let pageCount = 1;

  for (let page = 1; page <= Math.min(pageCount, MAX_PAGES); page += 1) {
    const result = await browseCatalog(
      deps,
      { filters: NO_FILTERS, sort: DEFAULT_SORT, page },
      { pageSize: MAX_PAGE_SIZE },
    );
    pageCount = result.pageCount;
    entries.push(...result.entries);
  }

  return entries;
}

/**
 * The sitemap, given a catalog to read and an origin to write.
 *
 * Exported and parameterised so a test can drive the REAL function against a
 * real database with real published artworks, rather than against a copy of it.
 * A test that rebuilt this mapping itself would pass just as happily if the
 * route stopped listing artworks at all.
 */
export async function sitemapEntries(
  deps: CatalogDeps,
  siteUrl: string,
): Promise<MetadataRoute.Sitemap> {
  const url = (path: string) => new URL(path, siteUrl).toString();
  const entries = await publishedEntries(deps);

  // One entry per artwork, and one per artist who has any — deduplicated,
  // because an artist with nine published works is still one page.
  const artistLastModified = new Map<string, string | undefined>();
  const artworks: MetadataRoute.Sitemap = [];

  for (const entry of entries) {
    const publishedAt = entry.artwork.publishedAt ?? undefined;
    artworks.push({
      url: url(`/artworks/${entry.artwork.id}`),
      lastModified: publishedAt,
      changeFrequency: "weekly",
      priority: 0.8,
    });

    // The catalog's default sort is newest first, so the FIRST time an artist
    // is seen is their most recent publication. `has` rather than `get`: an
    // artwork with no `publishedAt` stores `undefined`, and `get` cannot tell
    // that apart from an artist not yet seen.
    if (!artistLastModified.has(entry.artist.id)) {
      artistLastModified.set(entry.artist.id, publishedAt);
    }
  }

  const artists: MetadataRoute.Sitemap = [...artistLastModified].map(([id, lastModified]) => ({
    url: url(`/artists/${id}`),
    lastModified,
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  return [
    ...STATIC_PATHS.map((entry) => ({
      url: url(entry.path),
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
    })),
    ...artworks,
    ...artists,
  ];
}

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return sitemapEntries(catalogDeps(), publicEnv().NEXT_PUBLIC_SITE_URL);
}
