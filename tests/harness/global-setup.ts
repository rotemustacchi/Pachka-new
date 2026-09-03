/**
 * Runs once per integration-test run, before any test file.
 *
 * Brings up a real PostgreSQL (see `cluster.ts`), applies the real migrations
 * to a template database, and hands the connection details to the test workers.
 * Individual tests never touch this database — they clone it. See `database.ts`.
 */
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { startCluster, type Cluster } from "./cluster";
import { migrate } from "@/shared/db/migrations";
import { ensureLoginRoles, urlAsRole, APP_ROLE, AUTHENTICATOR_ROLE } from "./login-roles";
import { databaseUrl } from "./url";

export const TEMPLATE_DATABASE = "pachka_template";

let cluster: Cluster | undefined;

export default async function setup(project: TestProject) {
  cluster = await startCluster();

  const admin = new Client({ connectionString: cluster.adminUrl });
  await admin.connect();
  try {
    // A previous crashed run may have left the template (external mode only).
    await admin.query(`drop database if exists ${TEMPLATE_DATABASE} with (force)`);
    await admin.query(`create database ${TEMPLATE_DATABASE}`);
  } finally {
    await admin.end();
  }

  const templateUrl = databaseUrl(cluster.adminUrl, TEMPLATE_DATABASE);
  const template = new Client({ connectionString: templateUrl });
  await template.connect();
  try {
    const applied = await migrate(template);
    if (applied.length === 0) {
      throw new Error(
        "No migrations were applied to the test template database. " +
          "Integration tests must run against the real schema — check db/migrations.",
      );
    }
  } finally {
    // `create database ... template` refuses while any session is connected to
    // the source, so this connection must be gone before the first test runs.
    await template.end();
  }

  // Only now, because the roles below are granted membership in `service_role`,
  // `anon` and `authenticated` — which the bootstrap migration creates.
  await ensureLoginRoles(cluster.adminUrl);

  // The superuser URL is provided for exactly two things: creating and dropping
  // the per-test databases, and `privileged.ts`. Tests get the other two.
  project.provide("pachkaAdminUrl", cluster.adminUrl);
  project.provide("pachkaAppUrl", urlAsRole(cluster.adminUrl, APP_ROLE));
  project.provide("pachkaDataApiUrl", urlAsRole(cluster.adminUrl, AUTHENTICATOR_ROLE));
  project.provide("pachkaTemplate", TEMPLATE_DATABASE);

  return async () => {
    await cluster?.stop();
    cluster = undefined;
  };
}
