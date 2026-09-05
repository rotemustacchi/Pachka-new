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
import { getDatabase, type Database } from "@/shared/db";
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
