#!/usr/bin/env tsx
/**
 * Migration CLI.
 *
 *   npm run db:migrate          apply every pending migration
 *   npm run db:status           show what is applied, pending, or drifted
 *   npm run db:new -- <name>    create an empty migration with a correct filename
 *   tsx scripts/migrate.ts lint check migrations against the additive convention
 *
 * Reads DATABASE_URL. See db/README.md for the convention.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  lintMigrations,
  migrate,
  migrationFilename,
  status as migrationStatus,
  MIGRATIONS_DIR,
} from "../src/shared/db/migrations";

function connectionString(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
    process.exit(1);
  }
  return url;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const TEMPLATE = `-- <describe what this migration adds and why>
--
-- Owner: <module name — the module that owns every table touched here>
--
-- Forward-only and additive: see db/README.md. No down migration exists; a
-- mistake is corrected by a further migration.
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "up":
    case undefined: {
      const applied = await withClient(migrate);
      if (applied.length === 0) console.log("Already up to date.");
      else applied.forEach((name) => console.log(`applied  ${name}`));
      return;
    }

    case "status": {
      const rows = await withClient((client) => migrationStatus(client));
      if (rows.length === 0) {
        console.log("No migrations found.");
        return;
      }
      for (const row of rows) {
        const state = row.drifted ? "DRIFTED" : row.applied ? "applied" : "pending";
        console.log(`${state.padEnd(8)} ${row.name}`);
      }
      if (rows.some((r) => r.drifted)) process.exitCode = 1;
      return;
    }

    case "new": {
      const name = rest.join(" ").trim();
      if (!name) {
        console.error('Usage: npm run db:new -- "add artwork images"');
        process.exit(1);
      }
      const filename = migrationFilename(name);
      await writeFile(path.join(MIGRATIONS_DIR, filename), TEMPLATE, { flag: "wx" });
      console.log(path.join("db/migrations", filename));
      return;
    }

    case "lint": {
      const findings = await lintMigrations();
      if (findings.length === 0) {
        console.log("Migrations are additive.");
        return;
      }
      for (const f of findings) {
        console.error(`${f.name}: destructive statement (${f.why}) — see db/README.md`);
      }
      process.exit(1);
      return;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
