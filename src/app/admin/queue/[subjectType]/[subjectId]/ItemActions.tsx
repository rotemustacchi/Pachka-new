"use client";

/**
 * The three admin decisions, as three separate forms.
 *
 * Separate on purpose. Resolving the reports records what the admin decided
 * about the REPORTS; a takedown or a suspension acts on the SUBJECT. Merging
 * them into one button would make "dismissed" and "left alone" the same
 * decision in the audit trail, and the next admin looking at the same subject
 * would not be able to tell which happened.
 *
 * `removed` is terminal for every role, admins included (ARCHITECTURE.md), so
 * there is deliberately no "restore artwork" form here. An admin who wants a
 * removed artwork back asks the artist to relist it as a new record.
 */
import { Input, Select } from "@/shared/ui";
import { TextArea } from "../../../../_lib/TextArea";
import { AdminForm } from "../../../AdminForm";
import {
  reinstateAccountAction,
  resolveQueueItemAction,
  suspendAccountAction,
  takeDownArtworkAction,
} from "../../../actions";

export interface ItemActionsProps {
  readonly subjectType: "artwork" | "artist";
  readonly subjectId: string;
  readonly hasOpenReports: boolean;
  readonly suspended: boolean;
}

export function ItemActions({
  subjectType,
  subjectId,
  hasOpenReports,
  suspended,
}: ItemActionsProps) {
  return (
    <div className="flex flex-col gap-5">
      {hasOpenReports ? (
        <AdminForm
          action={resolveQueueItemAction}
          title="סגירת הדיווחים"
          description="הפעולה סוגרת את כל הדיווחים הפתוחים על הנושא הזה בבת אחת."
          submitLabel="סגירת הפריט"
        >
          {(state) => (
            <>
              <input type="hidden" name="subjectType" value={subjectType} />
              <input type="hidden" name="subjectId" value={subjectId} />
              <Select
                label="החלטה"
                name="outcome"
                defaultValue="dismissed"
                options={[
                  { value: "dismissed", label: "נדחה" },
                  { value: "actioned", label: "טופל" },
                ]}
                error={state.fields?.outcome?.[0]}
              />
              <TextArea
                label="הערת מנהל"
                name="note"
                rows={3}
                required
                hint="חובה. הדיווח הבא על אותו נושא ייקרא לצד ההערה הזו."
                error={state.fields?.note?.[0]}
              />
            </>
          )}
        </AdminForm>
      ) : null}

      {subjectType === "artwork" ? (
        <AdminForm
          action={takeDownArtworkAction}
          title="הסרת היצירה"
          description="פעולה חד-כיוונית. היצירה יורדת מכל המשטחים הציבוריים, והזמנות שכבר בוצעו אינן מושפעות."
          submitLabel="הסרה"
        >
          {(state) => (
            <>
              <input type="hidden" name="artworkId" value={subjectId} />
              <Input
                label="סיבה"
                name="reason"
                required
                error={state.fields?.reason?.[0]}
              />
              <TextArea label="הערה פנימית" name="note" rows={2} />
            </>
          )}
        </AdminForm>
      ) : null}

      {subjectType === "artist" && !suspended ? (
        <AdminForm
          action={suspendAccountAction}
          title="השעיית החשבון"
          description="ההשעיה מנתקת חיבורים פעילים ומורידה את היצירות המפורסמות מהקטלוג."
          submitLabel="השעיה"
        >
          {(state) => (
            <>
              <input type="hidden" name="userId" value={subjectId} />
              <Input label="סיבה" name="reason" required error={state.fields?.reason?.[0]} />
              <TextArea label="הערה פנימית" name="note" rows={2} />
            </>
          )}
        </AdminForm>
      ) : null}

      {subjectType === "artist" && suspended ? (
        <AdminForm
          action={reinstateAccountAction}
          title="ביטול ההשעיה"
          description="היצירות שפורסמו לפני ההשעיה חוזרות לקטלוג, למעט יצירות שהוסרו פרטנית."
          submitLabel="ביטול השעיה"
        >
          {() => (
            <>
              <input type="hidden" name="userId" value={subjectId} />
              <TextArea label="הערה פנימית" name="note" rows={2} />
            </>
          )}
        </AdminForm>
      ) : null}
    </div>
  );
}
