/**
 * The notify-me capture.
 *
 * Two things about this form are security decisions rather than copy decisions.
 *
 * THE CONFIRMATION TEXT IS WRITTEN BEFORE THE ANSWER IS KNOWN
 * ----------------------------------------------------------
 * art-matchmaker: "the response is identical both times and does not disclose
 * that the address was already stored." So the acknowledgement is a constant —
 * `NOTIFY_ACKNOWLEDGEMENT` — and it is phrased conditionally ("if the address
 * is valid, we will let you know") because a message that asserted success
 * would be a lie in the cases where nothing was sent, and a message that
 * distinguished those cases would be the membership oracle.
 *
 * IT ASKS FOR AN ADDRESS AND NOTHING ELSE
 * ---------------------------------------
 * The answers are already stored against the questionnaire; the form carries
 * only its id. SECURITY.md S3-30 is about PII accumulating without a path out,
 * and the cheapest way not to accumulate a field is not to have a box for it.
 */
import { NOTIFY_ACKNOWLEDGEMENT } from "../notify";

export interface NotifyMeFormProps {
  /** Where the address goes. A Server Action or route, supplied by `src/app`. */
  readonly action: string;
  /** The questionnaire these answers belong to, from `MatchOutcome.queryId`. */
  readonly queryId: string;
  /**
   * Whether the capture has just been acknowledged. One boolean, and it is set
   * for every accepted submission — never "was this new", which is the thing
   * the response must not reveal.
   */
  readonly acknowledged?: boolean;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
}

export function NotifyMeForm({ action, queryId, acknowledged, fieldErrors }: NotifyMeFormProps) {
  if (acknowledged === true) {
    return (
      <p role="status" className="text-[15px] font-light leading-[1.7] text-ink-soft">
        {NOTIFY_ACKNOWLEDGEMENT}
      </p>
    );
  }

  const errors = fieldErrors?.email;

  return (
    <form action={action} method="post" className="flex flex-col gap-3">
      <input type="hidden" name="queryId" value={queryId} />
      <label htmlFor="notify-email" className="text-[15px] font-bold text-ink">
        רוצים שנעדכן כשיגיע משהו מתאים?
      </label>
      <div className="flex flex-wrap gap-3">
        <input
          id="notify-email"
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="min-w-[16rem] flex-1 border border-rule bg-card px-4 py-3 text-ink"
        />
        <button
          type="submit"
          className="inline-flex items-center justify-center rounded-button bg-ink px-8 py-3 text-[15px] font-bold text-paper hover:bg-ink-soft"
        >
          עדכנו אותי
        </button>
      </div>
      {errors !== undefined && errors.length > 0 && (
        <p role="alert" className="text-[13px] font-bold text-ink">
          {errors.join(" ")}
        </p>
      )}
      <p className="text-[13px] font-light text-ink-soft">
        נשלח אימייל אחד לאישור, ורק אחריו נעדכן אתכם. אפשר לבטל בכל רגע.
      </p>
    </form>
  );
}
