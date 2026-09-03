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
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Every ephemeral cluster this file creates is `<tmpdir>/pachka-pg-XXXXXX`. */
const CLUSTER_PREFIX = "pachka-pg-";

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

/**
 * How long a cluster directory with no postmaster at all must sit untouched
 * before we treat it as abandoned rather than as a run that is still starting.
 *
 * There is a window between `mkdtemp` and the moment `initdb` writes
 * `postmaster.pid` during which a perfectly healthy concurrent run owns a
 * directory that looks, to this sweep, exactly like wreckage. A full suite takes
 * seconds, so half an hour is far past any legitimate startup and far short of
 * the timescale on which a developer would notice the disk.
 */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;

/** True when a process with this id exists and we are therefore not to touch it. */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything.
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to another user — alive, and
    // emphatically not ours. Only ESRCH ("no such process") means gone.
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Delete ephemeral clusters left behind by runs that were killed.
 *
 * A `pg_ctl stop` never happens when the test runner is SIGKILLed, so the data
 * directory and its postmaster survive the run that created them. Sixteen of
 * these once accumulated on one machine and starved each other for shared
 * memory and CPU until a single test took 362 seconds — which is
 * indistinguishable, from the outside, from the code under test having become
 * pathologically slow. Two innocent modules were nearly rewritten over it.
 *
 * The sweep is deliberately timid, because the cost of reaping a live cluster
 * (a concurrent run fails with corrupt-looking errors) is far worse than the
 * cost of leaving a dead one (some disk). It touches a directory only when ALL
 * of the following hold:
 *
 *   • it sits directly in the OS temp dir under our own `pachka-pg-` prefix, so
 *     a developer's real PostgreSQL — which lives in the data directory their
 *     package manager chose, never here — is out of scope by construction;
 *   • its `postmaster.pid` names a process that no longer exists, or there is
 *     no `postmaster.pid` at all and the directory has not been touched for
 *     half an hour;
 *   • and, when a pid file is present, the data directory it records is the one
 *     we are looking at — a pid file naming somewhere else is not ours to read.
 *
 * Anything unreadable, unexpected, or merely ambiguous is left alone. Failures
 * are swallowed: this is housekeeping, and it must never be the reason a test
 * run does not start.
 */
export async function reapAbandonedClusters(root: string = tmpdir()): Promise<string[]> {
  const reaped: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return reaped;
  }

  for (const entry of entries) {
    if (!entry.startsWith(CLUSTER_PREFIX)) continue;
    const dir = path.join(root, entry);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;

      const dataDir = path.join(dir, "data");
      let pidFile: string | undefined;
      try {
        pidFile = await readFile(path.join(dataDir, "postmaster.pid"), "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }

      if (pidFile === undefined) {
        // No postmaster ever started, or it shut down cleanly and only the
        // directory is left. Age is the only signal available.
        if (Date.now() - info.mtimeMs < ABANDONED_AFTER_MS) continue;
      } else {
        // Line 1 is the postmaster pid; line 2 is the data directory it was
        // started with.
        const [pid, recordedDataDir] = pidFile.split("\n");
        if (recordedDataDir !== undefined && recordedDataDir.trim() !== dataDir) continue;
        if (processIsAlive(Number.parseInt(pid ?? "", 10))) continue;
      }

      await rm(dir, { recursive: true, force: true });
      reaped.push(dir);
    } catch {
      // Raced with another sweep, or not ours to read. Leave it.
    }
  }

  return reaped;
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

  // Before adding one more, clear away the ones killed runs left behind. See
  // `reapAbandonedClusters` for why this is not merely tidiness.
  const reaped = await reapAbandonedClusters();
  if (reaped.length > 0) {
    console.warn(
      `[pachka] reaped ${reaped.length} abandoned test cluster(s) left by killed runs.`,
    );
  }

  const binDir = await resolveBinDir();
  const bin = (name: string) => path.join(binDir, name);
  const root = await mkdtemp(path.join(tmpdir(), CLUSTER_PREFIX));
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
