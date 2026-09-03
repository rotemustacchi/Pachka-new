/**
 * The artist's dashboard (task 3.10's tail).
 *
 * Everything on this page is computed by `artworks.artistDashboard`: the
 * derived availability, the status label, the permitted transitions, and what
 * each draft is still waiting for. This file chooses an order for columns and
 * nothing else -- in particular it does not decide which buttons an artwork
 * gets (`availableActions` does) and does not recompute a single number.
 *
 * Why every state is listed, including the ones no buyer can see:
 * artwork-listings says an unlisted artwork "remains visible in the artist's
 * dashboard", and a removed one appears too, because an artist whose work was
 * taken down needs to see that it was rather than find an empty space.
 *
 * Prices and counts carry `.numeric`, which sets `direction: ltr` inside the
 * RTL document. A Hebrew page renders "1,250₪" backwards without it.
 */
import Link from "next/link";
import { Badge, Card, SectionHeading } from "@/shared/ui";
import type { ArtistDashboard, DashboardListing } from "@/modules/artworks";
import { ListingActions } from "./ListingActions";
import { NewArtworkButton } from "./NewArtworkButton";

export interface StudioDashboardProps {
  readonly dashboard: ArtistDashboard;
}

export function StudioDashboard({ dashboard }: StudioDashboardProps) {
  const { listings, summary } = dashboard;

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-6 py-12 sm:px-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caps text-caps mb-3 text-ink-muted">The Artist&apos;s Studio</p>
          <SectionHeading as="h1">היצירות שלי</SectionHeading>
        </div>
        <NewArtworkButton />
      </div>

      <dl className="grid gap-4 sm:grid-cols-3">
        <Summary label="יצירות" value={summary.total} />
        <Summary label="מפורסמות" value={summary.byStatus.published} />
        <Summary label="חשיפות בהתאמות" value={summary.totalMatchImpressions} />
      </dl>

      {listings.length === 0 ? (
        <Card className="p-8">
          <p className="text-base text-ink-soft">
            עוד לא העליתם יצירה. התחילו מטיוטה — אפשר לשמור אותה חלקית ולחזור אליה.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {listings.map((listing) => (
            <ListingRow key={listing.id} listing={listing} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Summary({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <Card className="p-5">
      <dt className="caps text-caps mb-2 text-ink-muted">{label}</dt>
      <dd className="numeric text-[28px] font-black">{value}</dd>
    </Card>
  );
}

function ListingRow({ listing }: { readonly listing: DashboardListing }) {
  // The state machine's answer, not a second opinion about it.
  const canUnlist = listing.availableActions.includes("unlisted");
  const canReturnToDraft = listing.availableActions.includes("draft");

  return (
    <li>
      <Card className="flex flex-col gap-5 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/studio/artworks/${listing.id}`}
              className="border-b border-rule pb-[2px] text-lg font-bold"
            >
              {listing.title ?? "יצירה ללא שם"}
            </Link>
            <Badge variant="tag">{listing.statusLabel}</Badge>
            {listing.mediumLabel ? <Badge variant="tag">{listing.mediumLabel}</Badge> : null}
          </div>

          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[15px]">
            <Fact label="מחיר">
              {listing.priceFormatted === null ? (
                <span className="text-ink-muted">טרם נקבע</span>
              ) : (
                <span className="numeric font-bold">{listing.priceFormatted}</span>
              )}
            </Fact>
            <Fact label="מלאי">
              {/* Derived, never a stored counter: stock minus reserved minus sold. */}
              <span className="numeric">
                {listing.availableUnits} / {listing.stock}
              </span>
            </Fact>
            <Fact label="חשיפות בהתאמות">
              <span className="numeric">{listing.matchImpressions}</span>
            </Fact>
          </dl>

          {listing.oversoldBy > 0 ? (
            <p className="border-s-4 border-alert bg-card px-3 py-2 text-[13px] text-alert">
              {`נמכרו ${listing.oversoldBy} יחידות מעבר למלאי שהוגדר. פנו אלינו.`}
            </p>
          ) : null}

          {listing.missingForPublication.length > 0 ? (
            <div className="text-[13px] text-ink-soft">
              <p className="mb-1 font-bold">
                {listing.missingForPublication.length === 1
                  ? "נותר שדה חובה אחד לפני פרסום"
                  : `נותרו ${listing.missingForPublication.length} שדות חובה לפני פרסום`}
              </p>
              <ul className="flex flex-col gap-1">
                {listing.missingForPublication.map((requirement) => (
                  <li key={requirement.field}>{requirement.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <ListingActions
          artworkId={listing.id}
          canUnlist={canUnlist}
          canReturnToDraft={canReturnToDraft}
        />
      </Card>
    </li>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] text-ink-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
