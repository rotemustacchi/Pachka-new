/**
 * Ephemeral PostgreSQL cluster for integration tests.
 *
 * Integration tests in PACHKA run against a REAL PostgreSQL server with the
 * real migrations applied (ARCHITECTURE.md, "Test policy" #2). This module
 * provisions that server.
 *
 * Two modes, chosen automatically:
 *
 *   1. EXTERNAL — if `PACHKA_TEST_DATABASE_URL` is set we use that server.
 *      Use this to run the suite against Supabase's local stack
 *      (`npx supabase start`) or a Postgres container in CI.
 *
 *   2. EPHEMERAL (default) — we `initdb` a throwaway data directory into the
 *      OS temp dir and start a `postgres` listening on a unix socket inside
 *      that directory. No TCP port is bound, so parallel runs on the same
 *      machine can never collide, and nothing survives the run.
 *
 * The cluster is tuned for durability-free speed (fsync off, etc). It holds no
 * data anyone cares about; if it is lost mid-run the run has already failed.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * PostgreSQL refuses to start if the postmaster process has become
 * multithreaded, and on macOS the system locale machinery does exactly that
 * unless the locale is pinned. Every child process here runs with a fixed C
 * locale, which also makes sort order deterministic across developer machines.
 */
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C", LC_CTYPE: "C" };
const run = (file: string, args: string[]) => exec(file, args, { env: PG_ENV });

export interface Cluster {
  /** libpq connection options pointing at the `postgres` maintenance database. */
  readonly adminUrl: string;
  /** Build a connection URL for a named database on this cluster. */
  urlFor(database: string): string;
  /** Stop the server and delete every trace of it. No-op in EXTERNAL mode. */
  stop(): Promise<void>;
}

const PG_FLAGS = [
  "-c",
  "fsync=off",
  "-c",
  "full_page_writes=off",
  "-c",
  "synchronous_commit=off",
  "-c",
  "max_connections=200",
  // Deadlocks are a real outcome the orders team must be able to assert on.
  // Fail fast rather than making tests wait the default second.
  "-c",
  "deadlock_timeout=200ms",
];

async function resolveBinDir(): Promise<string> {
  // `initdb` and `pg_ctl` are frequently absent from PATH even when `psql` is
  // present (Homebrew keeps versioned server binaries out of the default
  // prefix). Try PATH first, then the usual keg locations.
  const candidates = [
    "",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
  ];
  for (const dir of candidates) {
    try {
      await run(path.join(dir, "initdb"), ["--version"]);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    [
      "Could not find the PostgreSQL server binaries (`initdb`, `pg_ctl`).",
      "",
      "Integration tests need a real PostgreSQL. Either:",
      "  • install one locally  — macOS: `brew install postgresql@16`",
      "                           Debian/Ubuntu: `apt install postgresql-16`",
      "  • or point the suite at an existing server:",
      "      PACHKA_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres npm test",
      "    (that URL is Supabase's local stack — `npx supabase start`)",
    ].join("\n"),
  );
}

export async function startCluster(): Promise<Cluster> {
  const external = process.env["PACHKA_TEST_DATABASE_URL"];
  if (external) {
    return {
      adminUrl: external,
      urlFor(database) {
        const url = new URL(external);
        url.pathname = `/${database}`;
        return url.toString();
      },
      async stop() {
        /* not ours to stop */
      },
    };
  }

  const binDir = await resolveBinDir();
  const bin = (name: string) => path.join(binDir, name);
  const root = await mkdtemp(path.join(tmpdir(), "pachka-pg-"));
  const dataDir = path.join(root, "data");
  // The socket path lives inside `root`; unix socket paths are capped at ~100
  // chars, and mkdtemp under the system temp dir stays well inside that.
  const socketDir = root;

  await run(bin("initdb"), [
    "-D",
    dataDir,
    "--username=postgres",
    "--auth=trust",
    "--no-sync",
    "--encoding=UTF8",
    "--locale=C",
  ]);

  await run(bin("pg_ctl"), [
    "-D",
    dataDir,
    "-w",
    "-l",
    path.join(root, "server.log"),
    "-o",
    // listen_addresses='' means unix socket only: no port to collide over.
    [`-k ${socketDir}`, "-c listen_addresses=", ...PG_FLAGS].join(" "),
    "start",
  ]);

  const urlFor = (database: string) =>
    `postgresql://postgres@/${database}?host=${encodeURIComponent(socketDir)}`;

  return {
    adminUrl: urlFor("postgres"),
    urlFor,
    async stop() {
      try {
        await run(bin("pg_ctl"), ["-D", dataDir, "-w", "-m", "immediate", "stop"]);
      } catch {
        // Already down, or never came up. Either way the directory goes next.
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
