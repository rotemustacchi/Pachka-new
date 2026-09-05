/**
 * Matchmaker wiring, with mail.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. Building
 * the dependency object is part of "call a module API", and `matchmaker`'s own
 * `deps.ts` names the alternative it wants replaced: `depsWithoutMail`, which
 * installs `noMailer`, which throws. Its header is honest about the cost —
 * "a lost confirmation, not a silent pretence that one was sent" — and under
 * double opt-in a lost confirmation means the subscription is never mailable
 * again. Notify-me has been storing addresses it can never write to.
 *
 * `appMailer()` replaces it. A `MailTransport` satisfies `matchmaker.Mailer`
 * as it stands, so nothing in the module changes: the port takes
 * `{ to, subject, body }` and that is what this sends. With no
 * `RESEND_API_KEY` the transport is the logging adapter, which records the
 * confirmation and succeeds — so the failure mode is no longer "the address is
 * stored and permanently unconfirmable", it is "the confirmation is in the
 * server log where a developer can find it".
 *
 * THE CONFIRMATION LINK IS ABSOLUTE, AND `depsWithoutMail`'s IS NOT
 * ----------------------------------------------------------------
 * `depsWithoutMail` returns `/matchmaker/notify/confirm/<token>` — a relative
 * path, which is fine in a message nobody sends and useless in one somebody
 * receives, because an email client has no origin to resolve it against. The
 * path is also wrong: the confirmation route lives under `/match`, not
 * `/matchmaker`. Both are reported upstream rather than fixed in the module.
 *
 * NOT YET CALLED — ONE LINE AWAY
 * ------------------------------
 * `src/app/match/notify/route.ts` still calls
 * `captureNotifyRequest(depsWithoutMail(getDatabase()), ...)`. Swapping that
 * for `matchmakerDeps()` is the whole remaining change, and it is a route file
 * this agent is not permitted to write. Raised with the lead architect.
 */
import { getDatabase, type Database } from "@/shared/db";
import { publicEnv } from "@/shared/config";
import { appMailer } from "@/shared/mail";
import type { MatchmakerDeps } from "@/modules/matchmaker";

/**
 * Where a notify-me confirmation link points.
 *
 * Absolute, from `NEXT_PUBLIC_SITE_URL`, and built here rather than in the
 * module: the module is handed a function precisely so that it never has to
 * know the deployment's origin.
 */
export function confirmUrl(confirmationToken: string): string {
  const base = publicEnv().NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  return `${base}/match/notify/confirm/${confirmationToken}`;
}

/** `matchmaker`, with the one seam it has wired to the real transport. */
export function matchmakerDeps(db: Database = getDatabase()): MatchmakerDeps {
  return { db, mailer: appMailer(), confirmUrl };
}
