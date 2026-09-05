/**
 * Matchmaker wiring.
 *
 * ARCHITECTURE.md: routes parse input, call a module API, and render. Building
 * the dependency object is part of "call a module API".
 *
 * THERE IS ALMOST NOTHING LEFT TO WIRE, AND THAT IS THE CHANGE
 * -----------------------------------------------------------
 * This file used to hand `matchmaker` a `Mailer` and a `confirmUrl`, replacing
 * a `depsWithoutMail` stand-in that installed a mailer which threw. The module
 * composed the notify-me confirmation itself, pasted the URL this file built
 * into the Hebrew copy, and sent it inside a `catch` that swallowed everything.
 *
 * It does none of that now. `captureNotifyRequest` returns a
 * `NotificationRequest` carrying the confirmation token, and
 * `dispatchAppNotifications` resolves the subscriber's address out of
 * `notify_requests`, builds the link from `NEXT_PUBLIC_SITE_URL`, and delivers.
 * The confirmation copy moved verbatim into the shared template table. So the
 * deps are a database, and the confirmation route at
 * `/match/notify/confirm/[token]` is reached by a link the mail layer builds
 * rather than by one this file passes down.
 */
import { getDatabase, type Database } from "@/shared/db";
import type { MatchmakerDeps } from "@/modules/matchmaker";

/** `matchmaker`, which needs a database and nothing else. */
export function matchmakerDeps(db: Database = getDatabase()): MatchmakerDeps {
  return { db };
}
