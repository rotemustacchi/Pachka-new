/**
 * The public artist profile, as a buyer sees it — design/Artist.dc.html.
 *
 * Pure and synchronous on purpose. The page component does the fetching and
 * hands this the already-narrow objects, which makes the whole view testable
 * without a database and keeps the shaping at the query where SECURITY.md S1-8
 * requires it.
 *
 * There is no `"use client"` anywhere in this file or below it. That is a
 * security property, not a preference: React serialises the ENTIRE prop object
 * of a Client Component into the RSC flight payload embedded in the HTML,
 * whatever the JSX renders. A Server Component renders to markup and nothing
 * else. The props here are already free of contact details -- `PublicArtist`
 * cannot carry them -- and this keeps the second line of defence from ever
 * being needed.
 */
import { Card } from "@/shared/ui";
import type { PublicArtist, Review, ReviewSummary } from "@/modules/accounts";

export interface ArtistProfileViewProps {
  readonly artist: PublicArtist;
  readonly reviews: readonly Review[];
  readonly summary: ReviewSummary;
  /**
   * The artist's published artworks. Owned by the catalog module, which renders
   * its own cards -- this page gives it the slot and the section chrome.
   */
  readonly artworks?: React.ReactNode;
}

const hebrewMonth = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" });

/**
 * Five stars, filled to the rating.
 *
 * Rendered as text rather than five SVGs because it is text: a screen reader
 * announcing "4 out of 5" is the whole point, and the visual stars are the
 * decoration on top of that.
 */
export function StarRating({ rating }: { readonly rating: number }) {
  const filled = Math.round(rating);

  return (
    <span className="inline-flex items-center" role="img" aria-label={`${rating} מתוך 5`}>
      <span aria-hidden="true" className="text-[13px] tracking-[2px] text-ink">
        {"★".repeat(filled)}
        <span className="text-rule">{"★".repeat(5 - filled)}</span>
      </span>
    </span>
  );
}

/** The avatar circle, or the outline placeholder the design uses when there is none. */
function Avatar({ artist }: { readonly artist: PublicArtist }) {
  return (
    <div className="flex size-[180px] shrink-0 items-center justify-center rounded-full border border-rule bg-paper-deep">
      {artist.avatarPath ? (
        // eslint-disable-next-line @next/next/no-img-element -- the storage path
        // is resolved to a signed URL by the uploads module; next/image would
        // need that host allow-listed, which is that module's call to make.
        <img
          src={artist.avatarPath}
          alt=""
          className="size-[180px] rounded-full object-cover"
        />
      ) : (
        <svg viewBox="0 0 80 80" className="size-[70px]" aria-hidden="true">
          <circle cx="40" cy="30" r="15" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-muted opacity-60" />
          <path
            d="M14 70 C 16 52, 26 46, 40 46 C 54 46, 64 52, 66 70"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-ink-muted opacity-60"
          />
        </svg>
      )}
    </div>
  );
}

function ReviewCard({ review }: { readonly review: Review }) {
  return (
    <Card className="p-[22px]">
      <div className="mb-[11px] flex items-center gap-2">
        <StarRating rating={review.rating} />
        <span className="text-[14px] font-bold text-ink">{review.buyerDisplayName}</span>
        <span className="text-[13px] text-ink-muted">
          · {hebrewMonth.format(new Date(review.createdAt))}
        </span>
      </div>
      {review.body ? (
        <p className="m-0 text-[15px] font-light leading-[1.65] text-ink-soft">{review.body}</p>
      ) : null}
    </Card>
  );
}

export function ArtistProfileView({ artist, reviews, summary, artworks }: ArtistProfileViewProps) {
  const memberSinceYear = new Date(artist.memberSince).getFullYear();

  return (
    <article>
      <section className="grid grid-cols-[180px_1fr] items-start gap-9 px-12 pt-13 pb-10">
        <Avatar artist={artist} />

        <div>
          <h1 className="mb-2 text-[42px] font-black tracking-[-.02em] text-ink">
            {artist.displayName}
          </h1>

          <div className="mb-[22px] flex flex-wrap items-center gap-4 text-[15px] text-ink-muted">
            {artist.city ? <span>{artist.city}</span> : null}
            {artist.city ? <span aria-hidden="true">·</span> : null}
            <span>חברת פאצ׳קה מאז {memberSinceYear}</span>
            {summary.average !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-[5px] font-medium text-ink">
                  <StarRating rating={summary.average} />
                  {summary.average} · {summary.count} ביקורות
                </span>
              </>
            ) : null}
          </div>

          {artist.biography ? (
            <p className="m-0 max-w-[760px] text-[17px] font-light leading-[1.75] text-ink-soft">
              {artist.biography}
            </p>
          ) : null}
        </div>
      </section>

      <section className="px-12 pb-[46px]">
        <div className="mb-[22px] flex items-baseline justify-between border-t border-rule pt-[26px]">
          <h2 className="m-0 text-2xl font-black text-ink">יצירות</h2>
        </div>
        {artworks}
      </section>

      <section className="px-12 pb-15">
        <h2 className="m-0 mb-[22px] border-t border-rule pt-[26px] text-2xl font-black text-ink">
          ביקורות
        </h2>

        {reviews.length === 0 ? (
          // Said plainly rather than shown as zero stars: "no reviews yet" and
          // "rated zero" are very different things to an artist starting out.
          <p className="m-0 text-[15px] font-light text-ink-muted">
            עדיין אין ביקורות על האמן הזה.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
