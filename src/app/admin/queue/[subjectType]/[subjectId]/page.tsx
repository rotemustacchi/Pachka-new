/**
 * /admin/queue/[subjectType]/[subjectId] — one queue item, and what an admin
 * can do about it.
 *
 * This address is not invented here: the operator's report alert links to
 * `/admin/queue/<subjectType>/<subjectId>`, built by `linkFor` in
 * `shared/mail/notifications.ts` from the subject type and id the `moderation`
 * descriptor carries. The email and the page agree because one of them decides
 * the shape and the other matches it.
 *
 * Three separate, separately audited decisions live on this page and stay
 * separate: resolving the reports says what the admin decided about the
 * REPORTS; taking an artwork down or suspending an account acts on the SUBJECT.
 * An admin can dismiss without acting and act without pretending the reports
 * were justified, which is exactly what `resolveQueueItem`'s note is for.
 */
import { notFound } from "next/navigation";
import { getDatabase } from "@/shared/db";
import { isAppError } from "@/shared/errors";
import { Badge, Card } from "@/shared/ui";
import { ARTWORK_STATUS_LABELS, findOwnArtwork } from "@/modules/artworks";
import { isAccountSuspended, listQueue, type QueueItem } from "@/modules/moderation";
import { currentUserId } from "../../../../_lib/viewer";
import { artworksDeps } from "../../../../studio/deps";
import { adminOrNotFound } from "../../../access";
import { moderationDepsForPage } from "../../../deps";
import { ItemActions } from "./ItemActions";

export const dynamic = "force-dynamic";

export const metadata = { title: "פריט בתור המנהלים — פאצ׳קה" };

interface PageProps {
  readonly params: Promise<{
    readonly subjectType: string;
    readonly subjectId: string;
  }>;
}

export default async function QueueItemPage({ params }: PageProps) {
  const { subjectType, subjectId } = await params;
  const userId = await currentUserId();
  const db = getDatabase();

  // Authorise BEFORE looking at the address. A malformed subject type answered
  // differently from an unauthorised one would tell a prober which half they
  // got wrong.
  await adminOrNotFound(db, userId);

  if (subjectType !== "artwork" && subjectType !== "artist") notFound();
  if (!/^[0-9a-f-]{36}$/i.test(subjectId)) notFound();

  const items = await listQueue(await moderationDepsForPage(), userId);
  const item = items.find(
    (candidate) => candidate.subjectType === subjectType && candidate.subjectId === subjectId,
  );

  const subject =
    subjectType === "artwork"
      ? await describeArtwork(userId as string, subjectId)
      : await describeArtist(db, subjectId);

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6 px-6 py-12 sm:px-12">
      <div>
        <p className="caps text-caps mb-3 text-ink-muted">Moderation</p>
        <h1 className="m-0 text-[30px] font-black tracking-[-.01em]">{subject.heading}</h1>
        <p className="numeric m-0 mt-2 text-[13px] text-ink-muted">{subjectId}</p>
      </div>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {subject.badges.map((badge) => (
            <Badge key={badge} variant="tag">
              {badge}
            </Badge>
          ))}
        </div>
        <Reports item={item} />
      </Card>

      <ItemActions
        subjectType={subjectType}
        subjectId={subjectId}
        hasOpenReports={item !== undefined}
        suspended={subject.suspended}
      />
    </div>
  );
}

function Reports({ item }: { readonly item: QueueItem | undefined }) {
  if (item === undefined) {
    return (
      <p className="m-0 text-[14px] text-ink-soft">
        אין דיווחים פתוחים על הנושא הזה. עדיין אפשר לפעול — פעולה אינה מותנית בדיווח.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[14px]">
        <span className="numeric font-bold">{item.reportCount}</span> דיווחים פתוחים
      </p>
      <ul className="flex flex-col gap-1 text-[14px] text-ink-soft">
        {item.reasons.map((reason) => (
          <li key={reason.reason}>
            {reason.label} — <span className="numeric">{reason.count}</span>
          </li>
        ))}
      </ul>
      {item.flagNote ? <p className="m-0 text-[14px] text-ink-soft">{item.flagNote}</p> : null}
    </div>
  );
}

interface SubjectSummary {
  readonly heading: string;
  readonly badges: readonly string[];
  readonly suspended: boolean;
}

/**
 * The artwork, as an admin sees it.
 *
 * `findOwnArtwork` with the `admin` actor: moderation acts on artworks it does
 * not own by definition, and the module already models that rather than needing
 * a second query here. An artwork that does not exist is a not-found, the same
 * answer an unauthorised caller got two lines earlier.
 */
async function describeArtwork(adminId: string, artworkId: string): Promise<SubjectSummary> {
  try {
    const { artwork } = await findOwnArtwork(artworksDeps(), adminId, artworkId, "admin");
    return {
      heading: artwork.title ?? "יצירה ללא שם",
      badges: [ARTWORK_STATUS_LABELS[artwork.status]],
      suspended: false,
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "not_found") notFound();
    throw error;
  }
}

async function describeArtist(
  db: ReturnType<typeof getDatabase>,
  userId: string,
): Promise<SubjectSummary> {
  const suspended = await isAccountSuspended(db, userId);
  return {
    heading: "חשבון אמן",
    badges: [suspended ? "מושעה" : "פעיל"],
    suspended,
  };
}
