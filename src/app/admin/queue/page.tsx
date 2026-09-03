/**
 * /admin/queue — open reports and pipeline-flagged uploads (task 11.5).
 *
 * The queue itself is `moderation.listQueue`: repeated reports on one subject
 * are already grouped into a single item with a count, and flagged uploads are
 * already merged in. This route authorises, calls it, and renders the list.
 *
 * A visitor who is not an admin — including one who is not signed in at all —
 * gets Next's not-found, because that is the answer `requireAdmin` gives and
 * `adminOrNotFound` carries it through unchanged. There is no sign-in redirect
 * here on purpose; see src/app/admin/access.ts.
 *
 * The design set has no admin layout, so this is plain and functional: the
 * shared primitives, a list, and one link per item.
 */
import Link from "next/link";
import { getDatabase } from "@/shared/db";
import { Badge, Card, SectionHeading } from "@/shared/ui";
import { listQueue, type QueueItem } from "@/modules/moderation";
import { currentUserId } from "../../_lib/viewer";
import { adminOrNotFound } from "../access";
import { moderationDepsForPage } from "../deps";

export const dynamic = "force-dynamic";

export const metadata = { title: "תור המנהלים — פאצ׳קה" };

export default async function AdminQueuePage() {
  const userId = await currentUserId();
  await adminOrNotFound(getDatabase(), userId);

  const items = await listQueue(await moderationDepsForPage(), userId);

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-8 px-6 py-12 sm:px-12">
      <SectionHeading as="h1">תור המנהלים</SectionHeading>

      {items.length === 0 ? (
        <Card className="p-8">
          <p className="m-0 text-base text-ink-soft">אין פריטים פתוחים.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <QueueRow key={`${item.kind}:${item.subjectType}:${item.subjectId}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** ISO-8601, not a locale format: an admin queue is a log, and a log is read in
 * one unambiguous format whatever machine renders it. */
function stamp(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ");
}

const SUBJECT_LABELS = { artwork: "יצירה", artist: "אמן" } as const;

function QueueRow({ item }: { readonly item: QueueItem }) {
  return (
    <li>
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="tag">{SUBJECT_LABELS[item.subjectType]}</Badge>
          {item.kind === "flagged_upload" ? <Badge variant="tag">סומן בהעלאה</Badge> : null}
          <Link
            href={`/admin/queue/${item.subjectType}/${item.subjectId}`}
            className="numeric border-b border-rule pb-[2px] text-[15px] font-bold"
          >
            {item.subjectId}
          </Link>
          <span className="numeric text-[13px] text-ink-muted">{stamp(item.latestAt)}</span>
        </div>

        {item.reportCount > 0 ? (
          <p className="m-0 text-[14px] text-ink-soft">
            <span className="numeric font-bold">{item.reportCount}</span>
            {" דיווחים · "}
            {item.reasons.map((reason) => `${reason.label} (${reason.count})`).join(" · ")}
          </p>
        ) : null}

        {item.flagNote ? (
          <p className="m-0 text-[14px] text-ink-soft">{item.flagNote}</p>
        ) : null}
      </Card>
    </li>
  );
}
