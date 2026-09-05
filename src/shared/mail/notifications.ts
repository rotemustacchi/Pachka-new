/**
 * Descriptors become words here, and only here.
 *
 * All six notification-producing modules — `orders`, `payouts`, `shipping`,
 * `certificates`, `matchmaker`, `moderation` — return
 * `{ audience, template, recipientId?, data }` and send nothing. This file is
 * the layer that resolves an address, writes the sentence, and hands it to a
 * transport. It exists so those modules keep the property they were built for —
 * their tests assert what a message SAYS, from a pure function, with nothing
 * faked — while the words still reach somebody.
 *
 * `matchmaker` and `moderation` used to compose and send for themselves. Their
 * copy was not rewritten when it moved here; it was carried over, which is why
 * two of the templates below are in English and the rest are in Hebrew. Copy is
 * written and reviewed, and reviewing it again is not a refactor's business.
 *
 * THREE THINGS A DESCRIPTOR DOES NOT CARRY
 * ----------------------------------------
 *   1. An address. `recipientId` is an account id — or, for the anonymous
 *      notify-me list, a subscription id — on purpose: a module forbids a
 *      template from holding personal data, so resolution happens here, through
 *      `AddressBook`, against tables that check who may be told what. An
 *      `admin` descriptor carries no `recipientId` at all — it is an operator
 *      queue, and its address comes from configuration.
 *   2. A URL. `certificates` is explicit: "a template that received a finished
 *      URL would be a template that could be pointed somewhere else by whatever
 *      built it." So identifiers travel and `siteUrl` is supplied here. A
 *      notify-me confirmation token travels the same way, and the confirmation
 *      link is built at the bottom of this file rather than in `matchmaker`.
 *   3. Words. The Hebrew — and the English — lives below.
 *
 * WHY THIS IS A LOOKUP TABLE AND NOT A TEMPLATE ENGINE
 * ---------------------------------------------------
 * No partials, no loops, no expression language, no files to load. A subject, a
 * lead, a labelled list of the values the module chose to include, an optional
 * link and an optional closing line — because the module already decided what
 * may appear, and the only remaining job is to say it. Five of those five parts
 * may be a plain string; a subject, a lead and a closing may instead be a
 * function of `data`, because "New PACHKA report: artwork <id>" names the thing
 * it is about and a constant cannot. A function here reads `data` and nothing
 * else: no database, no clock, no network.
 *
 * An unrecognised template still produces a real message, naming itself, rather
 * than an empty one or a crash: a notification PACHKA forgot to word is a worse
 * failure when it is silent.
 */
import { formatAgorot, isAgorot } from "@/shared/money";
import { hebrewHtmlBody, textBody } from "./body";
import { deliverQuietly } from "./transport";
import type { AddressBook, NotificationRequest } from "./contract";
import type { DeliveryOutcome, MailMessage, Mailer } from "./types";

export type { AddressBook, AddressLookup, NotificationAudience, NotificationRequest } from "./contract";

export interface NotificationContext {
  readonly addresses: AddressBook;
  /** Absolute base for any link. `NEXT_PUBLIC_SITE_URL` at the wiring site. */
  readonly siteUrl: string;
}

/** A piece of wording: fixed, or derived from the data the module supplied. */
type Wording = string | ((data: Readonly<Record<string, unknown>>) => string);

function say(wording: Wording | undefined, data: Readonly<Record<string, unknown>>): string | null {
  if (wording === undefined) return null;
  return typeof wording === "function" ? wording(data) : wording;
}

/** `data.x` as a trimmed string, or "" — every wording function's only reader. */
function str(data: Readonly<Record<string, unknown>>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** Subject lines. Every template PACHKA launches with. */
const SUBJECTS: Readonly<Record<string, Wording>> = {
  "orders.order_placed": "ההזמנה שלכם התקבלה — הוראות תשלום",
  "orders.operator_payment_pending": "הזמנה חדשה ממתינה לתשלום",
  "orders.payment_received": "התשלום התקבל",
  "orders.artist_dispatch_requested": "יש לשלוח עבודה שנמכרה",
  "orders.fulfilment_shipped": "החבילה שלכם נשלחה",
  "orders.order_delivered": "ההזמנה הגיעה",
  "orders.order_cancelled": "ההזמנה בוטלה",
  "payouts.payout_details_needed": "נדרשים פרטי חשבון לתשלום",
  "payouts.payout_settled": "התשלום הועבר",
  "payouts.payout_corrected": "עדכון בחישוב התשלום",
  "payouts.operator_payout_eligible": "תשלום לאמן ממתין להעברה",
  "certificates.issued": "תעודת המקוריות שלכם מוכנה",
  "matchmaker.notify_confirmation": "אישור הרשמה לעדכונים מפצ׳קה",
  // Carried verbatim from `moderation/reports.ts`. The operator's alert names
  // its subject in the subject line so a queue of them is triageable unopened.
  "moderation.report_filed": (data) =>
    `New PACHKA report: ${str(data, "subjectType")} ${str(data, "subjectId")}`,
  // Carried verbatim from `moderation/takedown.ts`.
  "moderation.artwork_taken_down": "Your PACHKA listing has been removed",
};

/** The opening sentence. Silence here is fine; an unlabelled list is not. */
const LEADS: Readonly<Record<string, Wording>> = {
  "orders.order_placed":
    "קיבלנו את ההזמנה שלכם. ההעברה מתבצעת ידנית — הפרטים למטה, והעבודות שמורות עבורכם עד לקבלת התשלום.",
  "orders.operator_payment_pending":
    "הזמנה חדשה נוצרה במצב ממתין לתשלום. יש לעקוב אחר ההעברה הבנקאית ולאשר אותה במערכת.",
  "orders.payment_received": "התשלום שלכם התקבל. האמנים התבקשו לארוז ולשלוח.",
  "orders.artist_dispatch_requested":
    "נמכרה עבודה שלכם והתשלום התקבל. יש לארוז ולשלוח; כתובת המשלוח נמצאת בעמוד ההזמנה בסטודיו.",
  "orders.fulfilment_shipped": "אחת החבילות בהזמנה שלכם יצאה לדרך.",
  "orders.order_delivered": "ההזמנה סומנה כהגיעה.",
  "orders.order_cancelled": "ההזמנה בוטלה והעבודות חזרו לקטלוג.",
  "payouts.payout_details_needed":
    "יש לכם תשלום ממתין ואין אצלנו פרטי חשבון. אפשר להוסיף אותם בסטודיו.",
  "payouts.payout_settled": "העברנו לכם תשלום. הפרטים לצורך התאמה מול דף החשבון שלכם:",
  "payouts.payout_corrected": "נעשה תיקון בחישוב תשלום קודם.",
  "payouts.operator_payout_eligible":
    "תשלום לאמן הפך זכאי להעברה. המערכת אינה מעבירה כסף — ההעברה ידנית.",
  "certificates.issued": "תעודת המקוריות של העבודה שרכשתם מוכנה לצפייה.",
  "matchmaker.notify_confirmation":
    "קיבלנו בקשה לעדכן אתכם כשיגיעו עבודות שמתאימות לתשובות שלכם.",
  // `moderation/reports.ts`'s `notificationBody`, verbatim. The reason is the
  // reporter's own label rather than the enum, which is what the module sent.
  "moderation.report_filed": (data) => {
    const details = str(data, "details");
    return [
      `A new report has been filed against ${str(data, "subjectType")} ${str(data, "subjectId")}.`,
      ``,
      `Reason: ${str(data, "reasonLabel")}`,
      ...(details === "" ? [] : [`Details: ${details}`]),
    ].join("\n");
  },
  // `moderation/takedown.ts`'s body, verbatim, including the untitled case.
  "moderation.artwork_taken_down": (data) => {
    const title = str(data, "artworkTitle");
    return [
      `Your listing${title === "" ? "" : ` "${title}"`} has been removed from PACHKA.`,
      ``,
      `Reason: ${str(data, "reasonLabel")}`,
    ].join("\n");
  },
};

/**
 * What the link is called, when a bare URL on its own line is not enough.
 *
 * Both entries are carried copy: the confirmation link read "לאישור: <url>" and
 * the operator's alert read "Queue item: <url>".
 */
const LINK_LABELS: Readonly<Record<string, string>> = {
  "matchmaker.notify_confirmation": "לאישור",
  "moderation.report_filed": "Queue item",
};

/** A last line after the link, before the sign-off. Carried copy, both of them. */
const CLOSINGS: Readonly<Record<string, Wording>> = {
  "matchmaker.notify_confirmation":
    "אם זה לא אתם, אפשר להתעלם מההודעה ולא יישלח אליכם דבר נוסף.",
  "moderation.artwork_taken_down":
    "A removed listing cannot be republished. If you believe this was a\n" +
    "mistake, reply to this message and the team will look at it again.",
};

/** Hebrew for the data keys the modules above actually emit. */
const LABELS: Readonly<Record<string, string>> = {
  orderId: "מספר הזמנה",
  fulfilmentId: "מספר משלוח",
  ledgerEntryId: "מספר רשומה",
  originalEntryId: "רשומה מקורית",
  adjustmentEntryId: "רשומת תיקון",
  artistId: "מזהה אמן",
  parcelCount: "מספר חבילות",
  subtotalAgorot: "סכום ביניים",
  shippingAgorot: "משלוח",
  totalAgorot: "סה״כ",
  itemsSubtotalAgorot: "סכום העבודות",
  netAgorot: "לתשלום",
  netDeltaAgorot: "הפרש",
  shippingTierCode: "מדרג משלוח",
  carrierName: "חברת שילוח",
  trackingReference: "מספר מעקב",
  settledOn: "תאריך העברה",
  bankReference: "אסמכתה",
  eligibleAt: "זכאי מתאריך",
  reason: "סיבה",
  instructions: "הוראות תשלום",
  identifiers: "מספרי תעודה",
  hasPayoutDetails: "פרטי חשבון קיימים",
};

/**
 * Keys the module put in `data` for this layer to resolve, not to print.
 *
 * `netFormatted` duplicates `netAgorot`; the formatted form wins below. The
 * per-template entries are keys a wording function above already spoke — the
 * artwork's title is in the first sentence, so a second line saying
 * `artworkTitle: Quiet Harbour` would be the same fact twice — plus, for
 * notify-me, a confirmation token, which is a credential and appears only
 * inside the link it authorises.
 */
const DERIVED = new Set(["netFormatted", "netDeltaFormatted"]);

const COMPOSED: Readonly<Record<string, readonly string[]>> = {
  "matchmaker.notify_confirmation": ["confirmationToken"],
  "moderation.report_filed": ["subjectType", "subjectId", "reason", "reasonLabel", "details"],
  "moderation.artwork_taken_down": ["artworkId", "artworkTitle", "reason", "reasonLabel"],
};

function isSpokenAlready(template: string, key: string): boolean {
  return DERIVED.has(key) || (COMPOSED[template]?.includes(key) ?? false);
}

function renderValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "כן" : "לא";
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== undefined);
    return items.length === 0 ? null : items.map(String).join(", ");
  }
  if (key.endsWith("Agorot")) {
    // `Agorot` is branded, and `isAgorot` is the only honest way across the
    // boundary: `data` is `Record<string, unknown>`, so a value that claims to
    // be money has to prove it before it is formatted as money.
    const numeric = typeof value === "bigint" ? Number(value) : value;
    if (isAgorot(numeric)) return formatAgorot(numeric);
  }
  return String(value);
}

/** The link, when there is an obvious one. Built here, never in a module. */
function linkFor(request: NotificationRequest, siteUrl: string): string | null {
  const base = siteUrl.replace(/\/+$/, "");
  const { data } = request;

  if (request.template === "matchmaker.notify_confirmation") {
    const confirmationToken = str(data, "confirmationToken");
    return confirmationToken === "" ? null : `${base}/match/notify/confirm/${confirmationToken}`;
  }
  if (request.template === "moderation.report_filed") {
    const subjectType = str(data, "subjectType");
    const subjectId = str(data, "subjectId");
    if (subjectType !== "" && subjectId !== "") {
      return `${base}/admin/queue/${subjectType}/${subjectId}`;
    }
  }
  if (request.template === "certificates.issued" && Array.isArray(data.identifiers)) {
    const first = data.identifiers[0];
    if (typeof first === "string" && first !== "") return `${base}/certificates/${first}`;
  }
  if (request.audience === "admin") return `${base}/admin`;
  if (typeof data.orderId === "string" && data.orderId !== "") {
    return `${base}/orders/${data.orderId}`;
  }
  return null;
}

/**
 * A descriptor as words. Pure: no address, no sending, no clock.
 *
 * Exported so the tests can assert what a message SAYS without a transport
 * anywhere near them — the property every emitting module protects in its own
 * suite, kept intact on this side of the boundary.
 */
export function composeNotification(
  request: NotificationRequest,
  siteUrl: string,
): { subject: string; body: string; html: string } {
  const { data, template } = request;
  const subject = say(SUBJECTS[template], data) ?? "הודעה מפצ׳קה";
  const lead = say(LEADS[template], data);
  const closing = say(CLOSINGS[template], data);

  const details = Object.entries(data)
    .filter(([key]) => !isSpokenAlready(template, key))
    .map(([key, value]) => {
      const rendered = renderValue(key, value);
      return rendered === null ? null : `${LABELS[key] ?? key}: ${rendered}`;
    })
    .filter((line): line is string => line !== null);

  const link = linkFor(request, siteUrl);
  const linkLabel = LINK_LABELS[template];
  const linkLine = link === null ? null : linkLabel === undefined ? link : `${linkLabel}: ${link}`;

  const body = textBody([
    lead ?? `הודעה מפצ׳קה (${template}).`,
    "",
    ...details,
    ...(linkLine === null ? [] : ["", linkLine]),
    ...(closing === null ? [] : ["", closing]),
    "",
    "פצ׳קה — שוק לאמנות ישראלית.",
  ]);

  return { subject, body, html: hebrewHtmlBody(body) };
}

/** One descriptor's fate, so a caller can report or store it. */
export interface NotificationOutcome extends DeliveryOutcome {
  readonly template: string;
  readonly audience: string;
}

/**
 * Resolve, compose, deliver, and never throw.
 *
 * Called AFTER the triggering transaction has committed, which is what every
 * emitting module's header asks for. Failures are collected rather than raised:
 * a checkout that reserved a one-of-a-kind painting is finished by the time
 * this runs, and an exception here would be an exception about nothing. The
 * same reasoning is why `moderation` may record the outcome and carry on, and
 * why `matchmaker`'s notify-me capture cannot tell a mail outage from a success
 * — the endpoint that must not leak whether an address is already stored gets
 * that for free when it never learns the answer itself.
 */
export async function dispatchNotifications(
  mailer: Mailer,
  context: NotificationContext,
  requests: readonly NotificationRequest[],
): Promise<NotificationOutcome[]> {
  const outcomes: NotificationOutcome[] = [];

  for (const request of requests) {
    const base = { template: request.template, audience: request.audience };

    let to: string | null;
    let why: string | undefined;
    try {
      const lookup = await context.addresses.addressFor(request.audience, request.recipientId);
      to = lookup.address;
      why = lookup.reason;
    } catch (cause) {
      outcomes.push({
        ...base,
        sent: false,
        error: cause instanceof Error ? cause.message.slice(0, 500) : "Address lookup failed",
      });
      continue;
    }

    if (to === null || to.trim() === "") {
      outcomes.push({
        ...base,
        sent: false,
        error: why ?? "No address on file for this recipient",
      });
      continue;
    }

    const { subject, body, html } = composeNotification(request, context.siteUrl);
    const message: MailMessage = { to, subject, body, html };
    outcomes.push({ ...base, ...(await deliverQuietly(mailer, message)) });
  }

  return outcomes;
}
