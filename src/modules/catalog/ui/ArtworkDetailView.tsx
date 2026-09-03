/**
 * The artwork detail page — design/Artwork.dc.html.
 *
 * THE SPECIFICATION SET IS LOAD-BEARING, NOT DECORATION
 * ----------------------------------------------------
 * The MVP has no buyer-to-artist messaging. A buyer who cannot find the
 * dimensions on this page cannot find them anywhere, and so cannot buy. That is
 * why catalog-browse requires "all images, the full specification set, the
 * taxonomy classification, the artist's display name linking to their profile,
 * availability, estimated shipping cost range, and the return policy summary"
 * in one requirement, and why the specification block here is
 * `artworks.ArtworkSpecifications` rather than rows typed into this JSX: that
 * component derives its rows from the artwork, so a field cannot be dropped by
 * an edit to a template, and the artist's own preview and the buyer's page
 * cannot disagree about what a piece is.
 *
 * THREE THINGS THIS COMPONENT DOES NOT OWN
 * ----------------------------------------
 * `catalog` may call `artworks` and `accounts`, and nothing else
 * (ARCHITECTURE.md's allowed-dependency table). Return terms belong to
 * `shipping`, the shipping estimate is computed from `shipping`'s rate table,
 * and the add-to-cart action belongs to `orders`. Importing any of them here
 * would invert an edge in that table.
 *
 * So all three arrive as props: the terms and the estimate as data shaped like
 * what those modules already return, and the purchase control as a slot. The
 * route in `src/app` composes them, which is exactly the "routes parse input,
 * call a module API, and render" division the contract describes. The
 * structural types below are declared here rather than imported for the same
 * reason `shared/config` declares its own `PostalAddressValue`.
 *
 * NO PURCHASE ACTION WHEN IT IS NOT PURCHASABLE
 * ---------------------------------------------
 * catalog-browse: a sold or unlisted artwork "renders in a read-only state
 * marked unavailable, with no purchase action". `purchaseAction` is rendered
 * only when `artwork.purchasable` is true, so the slot cannot be filled by a
 * route that forgot to check — the check is here, once, and a caller cannot opt
 * out of it. `purchasable` is `artworks`' own derivation (published AND units
 * available), not a status comparison repeated on this side.
 */
import type { ReactNode } from "react";
import {
  AiAssistedLabel,
  ArtworkSpecifications,
  inventoryLabel,
  isMedium,
  isMood,
  isStyle,
  isTargetSpace,
  leadTimeLabel,
  type PublicArtwork,
  type TaxonomyTag,
} from "@/modules/artworks";
import type { PublicArtist } from "@/modules/accounts";
import { formatAgorotCompact, type Agorot } from "@/shared/money";
import { Badge } from "@/shared/ui";
import { CATALOG_PATH, DEFAULT_SORT, NO_FILTERS, catalogHref, type CatalogFilters } from "../filters";

/**
 * The return terms, as `shipping.returnTerms()` returns them.
 *
 * Structurally a subset of `shipping.ReturnTerms`, so that value is assignable
 * to this without a cast or an adapter. Narrowed to what this page renders:
 * catalog does not need to know who bears transit risk as a field, only to show
 * the statement that says so.
 */
export interface CatalogReturnTerms {
  readonly windowDays: number;
  readonly statements: readonly { readonly code: string; readonly text: string }[];
}

/**
 * The estimated shipping range, in agorot.
 *
 * catalog-browse requires an "estimated shipping cost range" before purchase,
 * and the design states it as "משלוח מוערך ₪45–₪80". A range and not a figure
 * because the exact cost depends on the delivery address, which nobody has
 * entered yet — quoting one number here and a different one at checkout is
 * worse than quoting a band.
 */
export interface CatalogShippingRange {
  readonly minAgorot: Agorot;
  readonly maxAgorot: Agorot;
}

export interface ArtworkDetailViewProps {
  readonly artwork: PublicArtwork;
  readonly artist: PublicArtist;
  /** False when the artist has nothing published, so `/artists/<id>` would 404. */
  readonly artistProfileIsPublic: boolean;
  readonly returnTerms?: CatalogReturnTerms;
  readonly shippingRange?: CatalogShippingRange;
  /** Rendered only when the artwork is purchasable. Owned by `orders`. */
  readonly purchaseAction?: ReactNode;
  /** Owned by `moderation`. Omitted when the route has not wired reporting. */
  readonly reportHref?: string;
  readonly renderImage: (image: { src: string; alt: string; primary: boolean }) => ReactNode;
  readonly artistHref?: (artist: PublicArtist) => string;
  readonly basePath?: string;
}

const defaultArtistHref = (artist: PublicArtist): string => `/artists/${artist.id}`;

/** "משלוח מוערך ₪ 45 – ₪ 80 · נשלח תוך 5 ימי עסקים" (design/Artwork.dc.html). */
export function shippingLine(
  range: CatalogShippingRange | undefined,
  leadTimeDays: number | null,
): string | null {
  const parts: string[] = [];
  if (range !== undefined) {
    parts.push(
      `משלוח מוערך ${formatAgorotCompact(range.minAgorot)} – ${formatAgorotCompact(range.maxAgorot)}`,
    );
  }
  const lead = leadTimeLabel(leadTimeDays);
  if (lead !== null) parts.push(lead);

  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A link to the catalog filtered by exactly one value.
 *
 * Built from `NO_FILTERS` rather than from the current view, because a
 * classification tag on a detail page means "show me everything like this", not
 * "add this to whatever the last visitor filtered by".
 */
function filterHref(basePath: string, filters: Partial<CatalogFilters>): string {
  return catalogHref({ filters: { ...NO_FILTERS, ...filters }, sort: DEFAULT_SORT, page: 1 }, basePath);
}

/**
 * One classification tag, linked to the catalog filtered by it — when the value
 * is one this deployment still recognises.
 *
 * `PublicArtwork` carries taxonomy values as plain strings, so each is checked
 * against the closed set before it becomes a filter link. That is not
 * ceremony: a value retired between the day an artwork was classified and today
 * would otherwise produce a link to a filter that matches nothing, which reads
 * as a broken catalog rather than as a retired category. An unrecognised value
 * still renders as a tag — it is what the artist said about the work — it just
 * does not pretend to be navigation.
 */
interface LinkedTag {
  readonly key: string;
  readonly label: string;
  readonly href: string | null;
}

function taxonomyTags(artwork: PublicArtwork, basePath: string): readonly LinkedTag[] {
  const tags: LinkedTag[] = [];

  const push = (
    prefix: string,
    tag: TaxonomyTag,
    href: string | null,
  ) => tags.push({ key: `${prefix}:${tag.value}`, label: tag.label, href });

  const medium = artwork.medium;
  if (medium !== null) {
    push("medium", medium, isMedium(medium.value) ? filterHref(basePath, { media: [medium.value] }) : null);
  }
  for (const style of artwork.styles) {
    push("style", style, isStyle(style.value) ? filterHref(basePath, { styles: [style.value] }) : null);
  }
  for (const space of artwork.targetSpaces) {
    push(
      "space",
      space,
      isTargetSpace(space.value) ? filterHref(basePath, { targetSpaces: [space.value] }) : null,
    );
  }
  for (const mood of artwork.moods) {
    push("mood", mood, isMood(mood.value) ? filterHref(basePath, { moods: [mood.value] }) : null);
  }

  return tags;
}

/** The classification tags, as the design renders them under the description. */
function TaxonomyTags({
  artwork,
  basePath,
}: {
  readonly artwork: PublicArtwork;
  readonly basePath: string;
}) {
  return (
    // Each tag links to the catalog filtered by it. The classification is the
    // navigation, which is what makes a closed taxonomy worth having on a page
    // a buyer landed on from a search engine.
    <ul className="mb-6 flex list-none flex-wrap gap-[7px] p-0">
      {taxonomyTags(artwork, basePath).map((tag) => (
        <li key={tag.key}>
          {tag.href === null ? (
            <Badge variant="tag">{tag.label}</Badge>
          ) : (
            <a href={tag.href}>
              <Badge variant="tag">{tag.label}</Badge>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The unavailable notice a sold or unlisted artwork gets instead of a control.
 *
 * Says which state it is in, using `artworks`' own status label rather than a
 * second vocabulary, and says it as a status region so a screen reader reaching
 * the place the button would have been is told why there is not one.
 */
function UnavailableNotice({ artwork }: { readonly artwork: PublicArtwork }) {
  const reason =
    artwork.status === "sold" || artwork.soldOut
      ? "היצירה נמכרה ואינה זמינה לרכישה."
      : "היצירה אינה מוצגת למכירה כרגע.";

  return (
    <div
      role="status"
      className="mb-3 border border-rule bg-paper-deep px-5 py-4 text-center text-[15px] font-bold text-ink"
    >
      {reason}
    </div>
  );
}

export function ArtworkDetailView({
  artwork,
  artist,
  artistProfileIsPublic,
  returnTerms,
  shippingRange,
  purchaseAction,
  reportHref,
  renderImage,
  artistHref = defaultArtistHref,
  basePath = CATALOG_PATH,
}: ArtworkDetailViewProps) {
  const primary = artwork.images.find((image) => image.isPrimary) ?? artwork.images[0];
  const rest = artwork.images.filter((image) => image.id !== primary?.id);
  const shipping = shippingLine(shippingRange, artwork.leadTimeDays);
  const mediumCrumb = taxonomyTags(artwork, basePath).find((tag) => tag.key.startsWith("medium:")) ?? null;

  return (
    <article>
      <nav aria-label="נתיב ניווט" className="px-12 pb-3 pt-[26px] text-[13px] text-ink-muted">
        <a href={basePath} className="hover:text-ink">
          קטלוג
        </a>
        {mediumCrumb !== null ? (
          <>
            <span aria-hidden="true"> ← </span>
            {mediumCrumb.href === null ? (
              <span>{mediumCrumb.label}</span>
            ) : (
              <a href={mediumCrumb.href} className="hover:text-ink">
                {mediumCrumb.label}
              </a>
            )}
          </>
        ) : null}
        <span aria-hidden="true"> ← </span>
        <span>{artwork.title}</span>
      </nav>

      <div className="grid gap-12 px-12 pb-[60px] pt-[14px] lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <div className="relative border border-rule bg-paper-deep">
            <AiAssistedLabel aiAssisted={artwork.aiAssisted} />
            {primary
              ? renderImage({
                  src: primary.displayPath,
                  alt: primary.altText ?? artwork.title,
                  primary: true,
                })
              : null}
          </div>

          {rest.length > 0 ? (
            <ul className="mt-3 flex list-none gap-3 p-0">
              {rest.map((image) => (
                <li key={image.id} className="w-24 border border-rule">
                  {renderImage({
                    src: image.thumbnailPath ?? image.displayPath,
                    alt: image.altText ?? artwork.title,
                    primary: false,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div>
          <h1 className="mb-2 text-[36px] font-black tracking-[-0.015em] text-ink">
            {artwork.title}
          </h1>

          <div className="mb-[22px] flex items-center gap-[11px]">
            <span
              aria-hidden="true"
              className="size-[34px] shrink-0 rounded-full border border-rule bg-paper-deep"
            />
            {artistProfileIsPublic ? (
              <a
                href={artistHref(artist)}
                className="border-b border-rule text-base font-medium text-ink hover:text-ink-soft"
              >
                {artist.displayName}
              </a>
            ) : (
              // No link: `accounts` publishes a profile only for an artist with
              // something published, so an artist whose only piece has sold has
              // no page behind this name. A link to a 404 is worse than a name.
              <span className="text-base font-medium text-ink">{artist.displayName}</span>
            )}
            {artist.city !== null ? (
              <span className="text-sm text-ink-muted">· {artist.city}</span>
            ) : null}
          </div>

          <div className="mb-[6px] flex flex-wrap items-baseline gap-[14px]">
            <span className="text-[34px] font-black text-ink">
              {formatAgorotCompact(artwork.priceAgorot)}
            </span>
            <Badge variant="tag" className="border-ink">
              {inventoryLabel(artwork)}
            </Badge>
          </div>

          {shipping !== null ? (
            <p className="mb-[26px] text-[13px] text-ink-muted">{shipping}</p>
          ) : null}

          {artwork.purchasable ? (
            purchaseAction
          ) : (
            <UnavailableNotice artwork={artwork} />
          )}

          {returnTerms !== undefined ? (
            <p className="mb-[30px] mt-3 text-center text-[13px] text-ink-muted">
              {returnTerms.windowDays} יום להחזרה · תעודת מקוריות דיגיטלית
            </p>
          ) : null}

          <div className="mb-[22px] border-t border-rule pt-[22px]">
            <ArtworkSpecifications artwork={artwork} />
          </div>

          <section
            aria-labelledby="artwork-description-heading"
            className="mb-[22px] border-t border-rule pt-[22px]"
          >
            <h2 id="artwork-description-heading" className="mb-[11px] text-[15px] font-bold text-ink">
              על היצירה
            </h2>
            <p className="text-[15px] font-light leading-[1.7] text-ink-soft">
              {artwork.description}
            </p>
          </section>

          <TaxonomyTags artwork={artwork} basePath={basePath} />

          {returnTerms !== undefined ? (
            <section
              aria-labelledby="artwork-returns-heading"
              className="mb-6 border-t border-rule pt-[22px]"
            >
              <h2 id="artwork-returns-heading" className="mb-[11px] text-[15px] font-bold text-ink">
                החזרות וביטול עסקה
              </h2>
              {/* shipping-and-returns requires these BEFORE purchase, and the
                  wording is `shipping`'s so this page and the checkout summary
                  cannot drift apart or from the configured window. */}
              <ul className="flex list-none flex-col gap-2 p-0 text-[13px] font-light leading-[1.6] text-ink-soft">
                {returnTerms.statements.map((statement) => (
                  <li key={statement.code}>{statement.text}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {reportHref !== undefined ? (
            <a href={reportHref} className="inline-flex text-[13px] text-ink-muted hover:text-ink">
              דיווח על היצירה
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}
