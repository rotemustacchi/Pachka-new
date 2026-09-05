/**
 * /catalog — the public browse surface.
 *
 * catalog-browse makes browse a first-class surface alongside the matchmaker,
 * deliberately overriding the PRD's "no infinite feed": the curation happens at
 * admission, where an artwork is quality-gated before it can be published,
 * rather than by hiding the catalog from people.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. This one
 * does exactly three things — turn `searchParams` into a `CatalogQuery`, ask
 * `browseCatalog` for a page, and render `CatalogView` — and it is short
 * because every decision it might have made belongs to the module. Which
 * artworks are visible, which of the two empty states applies, how a filter
 * round-trips through a URL, and what an unrecognised filter value does are all
 * `catalog`'s, and none of them is repeated here.
 *
 * THE FILTER STATE IS THE URL
 * ---------------------------
 * Not synchronised to it: it lives there. `parseCatalogQuery` reads the whole
 * view out of `searchParams` and `catalogHref` writes it back, so a filtered
 * catalog is shareable, reloadable and back-button-safe, and there is no way
 * for the address bar and the grid to disagree. That is also why nothing below
 * is a Client Component and no filter is held in state.
 *
 * `ignored` is threaded through rather than dropped. A filter value this
 * deployment cannot apply WIDENS the results, so a visitor who followed a link
 * is looking at more than that link promised, and the view says so.
 *
 * `force-dynamic` because the answer depends on what is published and what is
 * reserved at this instant. A cached catalog page is a page that can show a
 * sold painting as available.
 */
import { browseCatalog, parseCatalogQuery, CatalogView, type CatalogSearchParams } from "@/modules/catalog";
import { catalogDeps } from "@/app/_lib/deps";
import { renderCardImage } from "@/app/_lib/images";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly searchParams: Promise<CatalogSearchParams>;
}

export default async function CatalogPage({ searchParams }: PageProps) {
  const { query, ignored } = parseCatalogQuery(await searchParams);
  const page = await browseCatalog(catalogDeps(), query);

  return (
    <CatalogView
      page={page}
      ignored={ignored}
      renderImage={renderCardImage}
      // `artworkHref` and `basePath` are left at their defaults —
      // `/artworks/<id>` and `/catalog`, which are the routes that exist.
      // Passing them would be restating the module's own answer.
    />
  );
}
