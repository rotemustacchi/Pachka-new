/**
 * The other half of the divergence: modules that return descriptors instead of
 * sending.
 *
 * `orders`, `payouts`, `shipping` and `certificates` declare no mailer at all.
 * Each returns `{ audience, template, recipientId?, data }` and says, in its own
 * header, that "the composition root dispatches them through one mail layer".
 * This file is that layer. It exists so those modules can keep the property they
 * were built for — their tests assert what a message SAYS, from a pure function,
 * with nothing faked — while the words still reach somebody.
 *
 * THREE THINGS A DESCRIPTOR DOES NOT CARRY
 * ----------------------------------------
 *   1. An address. `recipientId` is an account id, on purpose: `orders`
 *      forbids a template from holding personal data, so resolution happens
 *      here, through `AddressBook`, against tables that check who may be told
 *      what. An `admin` descriptor carries no `recipientId` at all — it is an
 *      operator queue, and its address comes from configuration.
 *   2. A URL. `certificates` is explicit: "a template that received a finished
 *      URL would be a template that could be pointed somewhere else by whatever
 *      built it." So identifiers travel and `siteUrl` is supplied here.
 *   3. Words. The Hebrew lives below.
 *
 * WHY THIS IS A LOOKUP TABLE AND NOT A TEMPLATE ENGINE
 * ---------------------------------------------------
 * No partials, no loops, no expression language, no files to load. A subject, a
 * lead sentence, and a labelled list of the values the module chose to include —
 * because the module already decided what may appear, and the only remaining
 * job is to say it in Hebrew. An unrecognised template still produces a real
 * message, naming itself, rather than an empty one or a crash: a notification
 * PACHKA forgot to word is a worse failure when it is silent.
 */
import { formatAgorot, isAgorot } from "@/shared/money";
import { hebrewHtmlBody, textBody } from "./body";
import { deliverQuietly } from "./transport";
import type { DeliveryOutcome, MailMessage, Mailer } from "./types";

/**
 * A descriptor, structurally. Declared rather than imported from any module:
 * `shared` may not depend on `src/modules`, and all five modules that emit
 * these declare the same four fields for exactly that reason.
 */
export interface NotificationRequest {
  readonly audience: string;
  readonly template: string;
  readonly recipientId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Where an address comes from.
 *
 * A port, so that resolution stays at the composition root where the database
 * and the auth gateway both live. Returning `null` is normal — an artist with
 * no contact row, an operator address nobody has configured yet — and is
 * reported as an undelivered message rather than raised.
 */
export interface AddressBook {
  addressFor(audience: string, recipientId?: string): Promise<string | null>;
}

export interface NotificationContext {
  readonly addresses: AddressBook;
  /** Absolute base for any link. `NEXT_PUBLIC_SITE_URL` at the wiring site. */
  readonly siteUrl: string;
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** Subject lines. Every template PACHKA launches with. */
const SUBJECTS: Readonly<Record<string, string>> = {
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
};

/** The opening sentence. Silence here is fine; an unlabelled list is not. */
const LEADS: Readonly<Record<string, string>> = {
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
 * Keys the module put in `data` for the mail layer to resolve, not to print.
 * `netFormatted` duplicates `netAgorot`; the formatted form wins below.
 */
const DERIVED = new Set(["netFormatted", "netDeltaFormatted"]);

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
 * anywhere near them — the property `orders` and `payouts` protect in their own
 * suites, kept intact on this side of the boundary.
 */
export function composeNotification(
  request: NotificationRequest,
  siteUrl: string,
): { subject: string; body: string; html: string } {
  const subject = SUBJECTS[request.template] ?? "הודעה מפצ׳קה";
  const lead = LEADS[request.template];

  const details = Object.entries(request.data)
    .filter(([key]) => !DERIVED.has(key))
    .map(([key, value]) => {
      const rendered = renderValue(key, value);
      return rendered === null ? null : `${LABELS[key] ?? key}: ${rendered}`;
    })
    .filter((line): line is string => line !== null);

  const link = linkFor(request, siteUrl);

  const body = textBody([
    lead ?? `הודעה מפצ׳קה (${request.template}).`,
    "",
    ...details,
    ...(link === null ? [] : ["", link]),
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
 * this runs, and an exception here would be an exception about nothing.
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
    try {
      to = await context.addresses.addressFor(request.audience, request.recipientId);
    } catch (cause) {
      outcomes.push({
        ...base,
        sent: false,
        error: cause instanceof Error ? cause.message.slice(0, 500) : "Address lookup failed",
      });
      continue;
    }

    if (to === null || to.trim() === "") {
      outcomes.push({ ...base, sent: false, error: "No address on file for this recipient" });
      continue;
    }

    const { subject, body, html } = composeNotification(request, context.siteUrl);
    const message: MailMessage = { to, subject, body, html };
    outcomes.push({ ...base, ...(await deliverQuietly(mailer, message)) });
  }

  return outcomes;
}
