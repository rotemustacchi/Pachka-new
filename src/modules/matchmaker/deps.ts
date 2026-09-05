/**
 * What the matchmaker needs handed to it.
 *
 * One field. That is the whole of it, and it is worth saying why, because this
 * file used to have three.
 *
 * The database is real everywhere, including in tests — ARCHITECTURE.md's test
 * policy makes that non-negotiable and the harness gives every test its own
 * PostgreSQL. So `db` is not a seam, it is just a dependency.
 *
 * THERE IS NO MAILER HERE ANY MORE, AND THAT IS THE POINT
 * ------------------------------------------------------
 * This module used to declare a `Mailer` port, compose the notify-me
 * confirmation in Hebrew, and send it — with a `noMailer` default that threw,
 * and a `depsWithoutMail` builder whose header apologised for the resulting
 * "lost confirmation, not a silent pretence that one was sent". It also took a
 * `confirmUrl` function so that it could paste a finished URL into that copy.
 *
 * None of that was this module's work. `captureNotifyRequest` now returns a
 * `NotificationRequest` describing what happened — a subscription wants
 * confirming, and here is the token — and the composition root resolves the
 * address, builds the URL and delivers. The confirmation copy moved with it,
 * unchanged, into the root's template table. What is left here is a module that
 * cannot send mail, cannot fail to send mail, and needs no fake to prove it.
 *
 * THERE IS NO AI PORT HERE EITHER
 * -------------------------------
 * `uploads` declares an `Embedder` and a `VisionAnalyst` because it calls them,
 * once per artwork, at upload. This module declares neither, because it must
 * never call one: "No outbound AI call at query time. Embeddings are computed
 * at upload and stored. If a matchmaker code path can reach an AI provider, it
 * is wrong" (ARCHITECTURE.md). A module cannot accidentally call a provider it
 * was never handed, so the absence of a port here is a structural control
 * rather than a note. If a future change needs one, it has to add it to this
 * file first, in a diff a reviewer sees.
 */
import type { Database } from "@/shared/db";

export interface MatchmakerDeps {
  readonly db: Database;
}
