/**
 * What the matchmaker needs handed to it.
 *
 * The database is real everywhere, including in tests — ARCHITECTURE.md's test
 * policy makes that non-negotiable and the harness gives every test its own
 * PostgreSQL. So `db` is not a seam, it is just a dependency.
 *
 * `mailer` IS a seam, and it is the only one. It is an external boundary, which
 * is the one category ARCHITECTURE.md permits a deterministic fake for. There
 * is deliberately no AI seam here: see `ports.ts`.
 */
import type { Database } from "@/shared/db";
import type { Mailer } from "./ports";
import { noMailer } from "./ports";

export interface MatchmakerDeps {
  readonly db: Database;
  readonly mailer: Mailer;
  /** Where a notify-me confirmation link points. Supplied by `src/app`. */
  readonly confirmUrl: (confirmationToken: string) => string;
}

/**
 * Deps for a deployment where mail is not wired yet.
 *
 * Named to be conspicuous in a diff. Notify-me still stores the subscription;
 * the confirmation is recorded as attempted and fails, which — under double
 * opt-in — means the address receives nothing and is never mailed later either.
 * That is the honest failure mode: a lost confirmation, not a silent pretence
 * that one was sent.
 */
export function depsWithoutMail(db: Database): MatchmakerDeps {
  return {
    db,
    mailer: noMailer,
    confirmUrl: (confirmationToken) => `/matchmaker/notify/confirm/${confirmationToken}`,
  };
}
