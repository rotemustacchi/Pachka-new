/**
 * What the accounts module needs handed to it.
 *
 * The database is real in every test (ARCHITECTURE.md test policy: the database
 * is never mocked). `auth` is the one genuinely external boundary, and the only
 * thing tests are permitted to fake.
 */
import type { Database } from "@/shared/db";
import type { AuthGateway } from "./auth-gateway";

export interface AccountsDeps {
  readonly db: Database;
  readonly auth: AuthGateway;
}

/**
 * Where a request came from, for rate limiting. Optional because module code is
 * also called from places with no request -- a backfill, a test, an admin
 * script -- and those must not be silently exempt from validation just because
 * they cannot supply an IP.
 */
export interface RequestOrigin {
  readonly ipAddress?: string;
}
