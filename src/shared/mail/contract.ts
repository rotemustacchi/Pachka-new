/**
 * The notification contract: what a domain module says, and to whom.
 *
 * This file is CONTRACT, not transport. It imports nothing, at all, and that is
 * the property that lets every module use it: a module that depends on this
 * depends on four field names, not on `fetch`, not on `MAIL_FROM`, and not on
 * whether mail is wired at this deployment.
 *
 * WHY THERE IS ONE OF THESE AND NOT SIX
 * ------------------------------------
 * Six modules produce notifications. Four of them — `orders`, `payouts`,
 * `shipping`, `certificates` — each declared their own structurally identical
 * `NotificationRequest`, each with a header explaining that it was identical to
 * the others "on purpose". The other two — `matchmaker`, `moderation` — went the
 * other way and declared a `Mailer` port, composed their own words and sent for
 * themselves.
 *
 * Four near-identical types is a type that wants to be shared, and two modules
 * writing marketing copy is a layering mistake: a domain module's job is to say
 * WHAT HAPPENED. It is not to write Hebrew, resolve an address, or have an
 * opinion about an SMTP outage. So there is one descriptor here, all six use it,
 * and `notifications.ts` is the single place that turns one into words.
 *
 * WHAT A DESCRIPTOR DELIBERATELY CANNOT CARRY
 * -------------------------------------------
 *   • an address — `recipientId` is an account id (or a subscription id), and
 *     `AddressBook` resolves it at the composition root against tables that
 *     check who may be told what. SECURITY.md S2-21 item 5: no user-supplied
 *     value populates an address header, and there is no header here to
 *     populate.
 *   • a URL — a template handed a finished URL is a template that can be
 *     pointed somewhere else by whatever built it. Identifiers travel; the
 *     origin is supplied once, at the root.
 *   • words — see `notifications.ts`.
 */

/**
 * Who a message is for.
 *
 * `admin` is an operator queue rather than a person, which is why an `admin`
 * descriptor carries no `recipientId`: its address comes from configuration.
 * `subscriber` is the anonymous notify-me list — an address that belongs to
 * nobody with an account, resolved from `notify_requests` by row id so that an
 * address which has since unsubscribed simply resolves to nothing.
 */
export type NotificationAudience = "buyer" | "artist" | "admin" | "subscriber";

/**
 * Something that needs telling, handed back rather than sent.
 *
 * Generic in the audience so a module can narrow to the audiences it actually
 * addresses — `payouts` talks to artists and operators and never to a buyer —
 * without a second declaration of the same four fields. A narrowed request is
 * assignable to the general one, so `dispatchNotifications` takes them all.
 */
export interface NotificationRequest<A extends NotificationAudience = NotificationAudience> {
  readonly audience: A;
  /** Stable template identifier. Callers switch on this, never on prose. */
  readonly template: string;
  /** The account or subscription to notify. Absent for `admin`. */
  readonly recipientId?: string;
  /**
   * Everything the wording is allowed to use. A module decides what may appear
   * in a message by deciding what goes in here; the template table below cannot
   * reach for anything else.
   */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * What an address lookup produced, and why not when it produced nothing.
 *
 * `reason` exists because "there is no address" has several causes and they are
 * not equally benign: an artist who never filled in a contact row is ordinary,
 * an unset `moderation.operator_email` is an operational failure that ships
 * with an empty default and a "Must be set before launch" note. Both end up in
 * a stored `notification_error` an operator can query, so the resolver that
 * knows the difference is the one that gets to say it.
 */
export interface AddressLookup {
  readonly address: string | null;
  /** Address-free explanation, recorded verbatim as the delivery error. */
  readonly reason?: string;
}

/**
 * Where an address comes from.
 *
 * A port, so resolution stays at the composition root where the database and
 * the auth gateway both live. `audience` is a plain string rather than the
 * union above: a resolver must give a sane answer for an audience it has never
 * heard of, and typing it out of existence would only move that failure to a
 * cast.
 */
export interface AddressBook {
  addressFor(audience: string, recipientId?: string): Promise<AddressLookup>;
}
