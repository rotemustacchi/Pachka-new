/**
 * The composition root.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. Building
 * the dependency object a module is handed is part of "call a module API" — the
 * module cannot build it for itself, because the whole point of the ports is
 * that the arrows in the dependency table only point one way.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SECOND `studio/deps.ts`
 * ---------------------------------------------------------
 * `studio/deps.ts` and `admin/deps.ts` both call
 * `depsWithoutOrdersOrMatchmaker`, and both say in their own headers that the
 * name is conspicuous on purpose: it installs `noDemand`, which reports zero
 * reservations for everything, and `noImpressions`, which reports zero
 * exposure. Those were the honest answers while `orders` and `matchmaker` did
 * not exist.
 *
 * They do now. `orders` exports `sqlInventoryDemand` — the `InventoryDemandSource`
 * that `artworks` declared and has been running without — and `matchmaker`
 * exports `impressionSource()`. `artworks/deps.ts` is explicit about the stakes
 * of the first one: "Being wrong about demand sells a one-of-a-kind painting
 * twice." So the wiring is done here, once, and every surface reads the same
 * availability.
 *
 * `assertDemandSourceIsWired` is what turns a forgotten swap into a loud
 * failure on the reservation path rather than a silently over-available
 * artwork, and it is the reason this file is a single function rather than a
 * convention each route follows on its own.
 */
import { getDatabase, createSupabaseServiceRoleClient, type Database } from "@/shared/db";
import { getConfig, publicEnv } from "@/shared/config";
import {
  appMailer,
  dispatchNotifications,
  type AddressBook,
  type AddressLookup,
  type NotificationContext,
  type NotificationOutcome,
  type NotificationRequest,
} from "@/shared/mail";
import type { ArtworksDeps } from "@/modules/artworks";
import type { CatalogDeps } from "@/modules/catalog";
import { impressionSource } from "@/modules/matchmaker";
import { createManualPaymentProvider, sqlInventoryDemand, type OrdersDeps } from "@/modules/orders";
import type { CertificatesDeps } from "@/modules/certificates";
import { buyerNamesFromOrders } from "@/modules/certificates";

/**
 * `artworks` with both ports wired to the modules that own them.
 *
 * `db` is threaded rather than defaulted at every call site so a caller already
 * inside a transaction can hand the transaction down — the same reason
 * `orders.artworksDepsFor` takes one.
 */
export function artworksDeps(db: Database = getDatabase()): ArtworksDeps {
  return { db, demand: sqlInventoryDemand, impressions: impressionSource() };
}

/**
 * `catalog` needs exactly what `artworks` needs, and says so:
 * `CatalogDeps = ArtworksDeps`. Aliased rather than rebuilt, because a second
 * builder is a second thing to forget to wire `demand` into.
 */
export function catalogDeps(db: Database = getDatabase()): CatalogDeps {
  return artworksDeps(db);
}

/**
 * `orders`, with the one external boundary it has.
 *
 * `createManualPaymentProvider()` is the adapter PACHKA launches with: it
 * records a payment as pending settlement and reaches no network. It is a real
 * implementation rather than a stand-in, which is why the tests drive this same
 * object instead of a fake.
 *
 * `maxActiveReservationsPerBuyer` and `flatArtworkPackedDepthMm` are left
 * unset: both defaults are documented in `orders/deps.ts` and both want to come
 * from `app_config`, whose registry is not this agent's file. Passing a literal
 * here would be a magic number in a second place.
 */
export function ordersDeps(db: Database = getDatabase()): OrdersDeps {
  return { db, payments: createManualPaymentProvider() };
}

/**
 * `certificates`, with the buyer-name port wired.
 *
 * `buyerNames` is required only for a buyer's private copy and is deliberately
 * unused by the public verification page — that page "has no business knowing a
 * buyer exists". Wiring it here does not put a name on the public page: the
 * public path returns a `PublicCertificate`, which has no field a name could
 * travel in.
 */
export function certificatesDeps(db: Database = getDatabase()): CertificatesDeps {
  return { db, buyerNames: buyerNamesFromOrders(ordersDeps(db)) };
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------
//
// Until recently nothing in this application sent anything. `checkout/actions.ts`
// said so in its own header, and `admin/deps.ts` listed `mailer` under "what is
// deliberately absent". The transport now exists in `src/shared/mail`, and this
// is where it is handed out.
//
// There is exactly one way in. All six notification-producing modules --
// `orders`, `payouts`, `shipping`, `certificates`, `matchmaker`, `moderation` --
// return `NotificationRequest` descriptors and send nothing; `addressBook()`
// resolves who, the shared template table says what, and
// `dispatchAppNotifications` delivers. Two of those six used to take a `Mailer`
// and compose their own copy. They no longer do, which is why there is one
// dispatcher here and no adapter objects.

/**
 * A dispatcher, as a type, so a form or an action can be handed one.
 *
 * `queue-forms.ts` takes one of these rather than reaching for
 * `dispatchAppNotifications` itself: an admin form has to be able to say
 * whether the artist was actually told, and a test has to be able to make that
 * answer both yes and no without a global.
 */
export type NotificationDispatcher = (
  requests: readonly NotificationRequest[],
) => Promise<NotificationOutcome[]>;

/**
 * Where a notification's address comes from, by audience.
 *
 * Four sources, because PACHKA keeps four kinds of address in four places and
 * each has its own rule:
 *
 *   artist — `artist_contact_details`, which has ALL GRANTS REVOKED from anon
 *     and authenticated and is reachable only through this privileged
 *     connection. `moderation/takedown.ts` used to read it exactly this way,
 *     and now hands over an artist id instead.
 *   buyer  — Supabase auth, which is the only place a buyer's address exists.
 *     There is no `email` column on `profiles`, deliberately: the migration
 *     notes that an anonymously-readable column whose name contains `email` is
 *     a liability. So the service-role client is built lazily, per lookup.
 *   admin  — `moderation.operator_email` from `app_config`. An operator queue
 *     is not a person, which is why an `admin` descriptor carries no
 *     `recipientId` for this function to use.
 *   subscriber — `notify_requests`, by row id. The notify-me list is anonymous:
 *     the address belongs to nobody with an account, so it is looked up here
 *     rather than travelling in a descriptor that gets logged. Reading it at
 *     dispatch time rather than at capture time also means an address that
 *     unsubscribed in between resolves to nothing and is not written to.
 *
 * A missing address is reported, never raised, and the REASON travels with it.
 * "The artist has no contact address on file" is ordinary; an unset
 * `moderation.operator_email` is an operational failure that ships with an
 * empty default and a "Must be set before launch" note. Both end up in a
 * `notification_error` an operator can query, so the resolver that knows the
 * difference is the one that says it.
 */
export function addressBook(db: Database = getDatabase()): AddressBook {
  return {
    async addressFor(audience: string, recipientId?: string): Promise<AddressLookup> {
      if (audience === "admin") {
        const configured = (await getConfig(db, "moderation.operator_email")).trim();
        return configured.length > 0
          ? { address: configured }
          : {
              address: null,
              reason: "No operator address is configured (moderation.operator_email)",
            };
      }

      if (recipientId === undefined || recipientId === "") {
        return { address: null, reason: "No recipient was named" };
      }

      if (audience === "artist") {
        const row = await db.maybeOne<{ email: string | null }>(
          "select email from artist_contact_details where user_id = $1",
          [recipientId],
        );
        const email = row?.email?.trim() ?? "";
        return email.length > 0
          ? { address: email }
          : { address: null, reason: "The artist has no contact address on file" };
      }

      if (audience === "buyer") {
        const { data } = await createSupabaseServiceRoleClient().auth.admin.getUserById(recipientId);
        const email = data.user?.email?.trim() ?? "";
        return email.length > 0
          ? { address: email }
          : { address: null, reason: "No address on file for this recipient" };
      }

      if (audience === "subscriber") {
        const row = await db.maybeOne<{ email: string | null }>(
          "select email from notify_requests where id = $1",
          [recipientId],
        );
        const email = row?.email?.trim() ?? "";
        return email.length > 0
          ? { address: email }
          : { address: null, reason: "That subscription no longer exists" };
      }

      return { address: null, reason: `No address book for audience "${audience}"` };
    },
  };
}

/**
 * Everything `dispatchNotifications` needs besides the mailer.
 *
 * `siteUrl` is supplied here rather than by any module, because
 * `certificates/notifications.ts` refuses to build a URL: "a template that
 * received a finished URL would be a template that could be pointed somewhere
 * else by whatever built it." The notify-me confirmation link and the admin
 * queue link are built from this for the same reason.
 */
export function notificationContext(db: Database = getDatabase()): NotificationContext {
  return { addresses: addressBook(db), siteUrl: publicEnv().NEXT_PUBLIC_SITE_URL };
}

/**
 * Dispatch a module's notifications. Call it AFTER the transaction commits.
 *
 * Never throws and never rejects — see `deliverQuietly`. The outcomes are
 * returned so a caller that wants to report delivery, as the admin queue does,
 * can; a caller that does not may ignore them, and an order is unaffected
 * either way.
 */
export function dispatchAppNotifications(
  requests: readonly NotificationRequest[],
  db: Database = getDatabase(),
): Promise<NotificationOutcome[]> {
  return dispatchNotifications(appMailer(), notificationContext(db), requests);
}
