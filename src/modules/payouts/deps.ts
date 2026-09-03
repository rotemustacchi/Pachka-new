/**
 * What the payouts module needs handed to it.
 *
 * The database is real in every test (ARCHITECTURE.md test policy: the database
 * is never mocked, and neither is PACHKA's own code). `admin` is the port
 * standing in for `moderation`, which this module's dependency edges do not
 * include; see ./ports for why it exists and why its stand-in raises instead of
 * shrugging.
 */
import type { Database } from "@/shared/db";
import { auditUnavailable, type AdminActionPort } from "./ports";

export interface PayoutsDeps {
  readonly db: Database;
  /**
   * Absent until the composition root wires `moderation` in. Absent means every
   * admin path in this module refuses, which is the correct failure: settlement
   * and bank-detail reveal are both audited events, and an unaudited one is
   * worse than an unavailable one.
   */
  readonly admin?: AdminActionPort;
}

/** The audit writer, or the one that refuses. Never a silent no-op. */
export function adminPort(deps: PayoutsDeps): AdminActionPort {
  return deps.admin ?? auditUnavailable;
}
