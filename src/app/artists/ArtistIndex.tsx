/**
 * /artists — every artist with published work.
 *
 * WHY THIS IS DERIVED FROM THE CATALOG RATHER THAN QUERIED
 * -------------------------------------------------------
 * ARCHITECTURE.md: a route parses input, calls a module API, and renders. A
 * `select ... from artist_profiles` here would be a route reading another
 * module's table directly, which is the boundary violation the contract names.
 *
 * `accounts` has no "list the public artists" function — `findPublicArtist` is
 * per-artist — so this index is composed from `catalog.browseCatalog`, which
 * already returns a `PublicArtist` beside every entry, already shaped by
 * `toPublicArtist()`, the only serializer permitted to shape artist data for a
 * buyer. That gives exactly the right membership for free: `browseCatalog`
 * returns published artworks whose artist is not suspended, so an artist
 * appears here precisely when they have something to show, which is also the
 * condition on which `/artists/<id>` resolves rather than 404s. Two independent
 * definitions of "has published work" could disagree, and a header link into a
 * 404 is the most visible defect the app can have.
 *
 * Adding `accounts.listPublicArtists` would be better and is reported upstream.
 *
 * THE PAGING IS BOUNDED AND THAT IS DELIBERATE
 * --------------------------------------------
 * It walks pages until `pageCount` is reached, capped, rather than asking for
 * an unbounded result set. PACHKA launches with no artists and grows slowly;
 * when the catalog outgrows the cap this page starts under-reporting, which is
 * the failure that shows up as a missing artist rather than as a timed-out
 * request — and it is the point at which the module function above is worth
 * writing.
 */
import {
  DEFAULT_SORT,
  MAX_PAGE_SIZE,
  NO_FILTERS,
  browseCatalog,
  type CatalogDeps,
} from "@/modules/catalog";
import type { PublicArtist } from "@/modules/accounts";
import { Card, SectionHeading } from "@/shared/ui";

/** Enough for a few thousand published artworks before it under-reports. */
const MAX_PAGES = 50;

export async function listPublishedArtists(deps: CatalogDeps): Promise<readonly PublicArtist[]> {
  const byId = new Map<string, PublicArtist>();
  let pageCount = 1;

  for (let page = 1; page <= Math.min(pageCount, MAX_PAGES); page += 1) {
    const result = await browseCatalog(
      deps,
      { filters: NO_FILTERS, sort: DEFAULT_SORT, page },
      { pageSize: MAX_PAGE_SIZE },
    );
    pageCount = result.pageCount;
    for (const entry of result.entries) byId.set(entry.artist.id, entry.artist);
  }

  // Sorted by name in Hebrew collation, so the order is the one a Hebrew
  // reader expects rather than the catalog's "newest artwork first".
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "he"));
}

export function ArtistIndex({ artists }: { readonly artists: readonly PublicArtist[] }) {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-8 px-6 py-12 sm:px-12">
      <SectionHeading as="h1">אמנים</SectionHeading>

      {artists.length === 0 ? (
        // The same honest answer the empty catalog gives, for the same reason:
        // PACHKA launches with no artists, so this is what the first visitors
        // actually see, and it invites one in rather than looking broken.
        <section className="flex flex-col items-center border border-rule bg-card px-6 py-16 text-center">
          <h2 className="mb-3 text-[26px] font-black text-ink">עוד אין כאן אמנים</h2>
          <p className="mb-8 max-w-[46ch] text-[15px] font-light leading-[1.7] text-ink-soft">
            PACHKA רק נפתחת. אם את או אתה יוצרים בארץ — זה הרגע להיות הראשונים.
          </p>
          <a
            href="/become-an-artist"
            className="inline-flex items-center justify-center rounded-button bg-ink px-10 py-4 text-base font-bold text-paper hover:bg-ink-soft"
          >
            הצטרפות כאמן
          </a>
        </section>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-5 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {artists.map((artist) => (
            <li key={artist.id}>
              <a href={`/artists/${artist.id}`} className="block">
                <Card className="flex flex-col gap-1 p-5">
                  <span className="text-base font-bold text-ink">{artist.displayName}</span>
                  {artist.city !== null ? (
                    <span className="text-[13px] text-ink-muted">{artist.city}</span>
                  ) : null}
                </Card>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
