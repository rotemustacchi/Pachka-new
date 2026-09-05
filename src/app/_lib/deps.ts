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
// Until now nothing in this application sent anything. `checkout/actions.ts`
// says so in its own header — "No mailer is wired anywhere in this application
// yet" — and `admin/deps.ts` listed `mailer` under "what is deliberately
// absent". The transport now exists in `src/shared/mail`, and this is where it
// is handed out.
//
// The four modules that need mail do not agree on how to ask for it, and this
// file does not try to make them agree. `matchmaker` and `moderation` take a
// `Mailer` and send for themselves; `orders`, `payouts`, `shipping` and
// `certificates` return notification descriptors and expect this root to
// dispatch them. `appMailer()` serves the first pair directly. `addressBook()`
// and `dispatchNotifications` serve the second.

/**
 * Where a notification's address comes from, by audience.
 *
 * Three sources, because PACHKA keeps three kinds of address in three places
 * and each has its own rule:
 *
 *   artist — `artist_contact_details`, which has ALL GRANTS REVOKED from anon
 *     and authenticated and is reachable only through this privileged
 *     connection. `moderation/takedown.ts` reads it exactly this way.
 *   buyer  — Supabase auth, which is the only place a buyer's address exists.
 *     There is no `email` column on `profiles`, deliberately: the migration
 *     notes that an anonymously-readable column whose name contains `email` is
 *     a liability. So the service-role client is built lazily, per lookup.
 *   admin  — `moderation.operator_email` from `app_config`. An operator queue
 *     is not a person, which is why an `admin` descriptor carries no
 *     `recipientId` for this function to use.
 *
 * A missing address returns null rather than raising. `dispatchNotifications`
 * records that as an undelivered message, which is the honest outcome and not
 * a reason to fail the order that produced it.
 */
export function addressBook(db: Database = getDatabase()): AddressBook {
  return {
    async addressFor(audience: string, recipientId?: string): Promise<string | null> {
      if (audience === "admin") {
        const configured = (await getConfig(db, "moderation.operator_email")).trim();
        return configured.length > 0 ? configured : null;
      }

      if (recipientId === undefined || recipientId === "") return null;

      if (audience === "artist") {
        const row = await db.maybeOne<{ email: string | null }>(
          "select email from artist_contact_details where user_id = $1",
          [recipientId],
        );
        const email = row?.email?.trim() ?? "";
        return email.length > 0 ? email : null;
      }

      if (audience === "buyer") {
        const { data } = await createSupabaseServiceRoleClient().auth.admin.getUserById(recipientId);
        const email = data.user?.email?.trim() ?? "";
        return email.length > 0 ? email : null;
      }

      return null;
    },
  };
}

/**
 * Everything `dispatchNotifications` needs besides the mailer.
 *
 * `siteUrl` is supplied here rather than by any module, because
 * `certificates/notifications.ts` refuses to build a URL: "a template that
 * received a finished URL would be a template that could be pointed somewhere
 * else by whatever built it."
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
