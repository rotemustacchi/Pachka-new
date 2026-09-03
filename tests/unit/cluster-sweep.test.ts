/**
 * The abandoned-cluster sweep, tested on directories rather than on real
 * PostgreSQL servers.
 *
 * The sweep exists because killed test runs leave their ephemeral clusters
 * running: sixteen once accumulated on one machine and starved each other until
 * a single test took 362 seconds, which read as two modules having gone
 * mysteriously slow. What has to be true of the sweep is not merely that it
 * deletes wreckage — it is that it *refuses* to delete anything a live process
 * still owns, because reaping a running cluster turns a healthy concurrent run
 * into a stream of corruption-shaped errors.
 *
 * So every "leaves it alone" case below is the point of the file, and the one
 * "deletes it" case is the control that stops them passing vacuously.
 */
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reapAbandonedClusters } from "../harness/cluster";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A scratch directory standing in for the OS temp dir. */
async function sandbox(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pachka-sweep-test-"));
  roots.push(root);
  return root;
}

/**
 * Build a directory shaped like a cluster.
 *
 * `pid` omitted means no `postmaster.pid` at all. `dataDir` overrides the path
 * recorded on line two of the pid file, to simulate a file that is not ours.
 */
async function cluster(
  root: string,
  name: string,
  options: { pid?: number; dataDir?: string; ageMs?: number } = {},
): Promise<string> {
  const dir = path.join(root, name);
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir, { recursive: true });

  if (options.pid !== undefined) {
    // Real postmaster.pid files carry seven or so lines; the sweep reads the
    // first two, so the rest is realistic filler.
    const lines = [
      String(options.pid),
      options.dataDir ?? dataDir,
      "1756900000",
      "5432",
      dir,
      "",
      "  5432001         0",
    ];
    await writeFile(path.join(dataDir, "postmaster.pid"), lines.join("\n"));
  }

  if (options.ageMs !== undefined) {
    const when = new Date(Date.now() - options.ageMs);
    await utimes(dir, when, when);
  }
  return dir;
}

const exists = async (dir: string): Promise<boolean> =>
  stat(dir).then(
    () => true,
    () => false,
  );

/** A pid that cannot be running: process 1 is init, and this is not it. */
const DEAD_PID = 0x7ffffffe;

describe("reapAbandonedClusters()", () => {
  it("deletes a cluster whose postmaster is gone", async () => {
    const root = await sandbox();
    const dead = await cluster(root, "pachka-pg-dead01", { pid: DEAD_PID });

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([dead]);
    expect(await exists(dead)).toBe(false);
  });

  it("leaves a cluster whose postmaster is still running", async () => {
    const root = await sandbox();
    // Our own pid is the one process we can be certain is alive.
    const live = await cluster(root, "pachka-pg-live01", { pid: process.pid });

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([]);
    expect(await exists(live)).toBe(true);
  });

  it("leaves a pid file that records a data directory somewhere else", async () => {
    const root = await sandbox();
    // Same prefix, dead pid — but the file describes another server, so we do
    // not get to conclude anything about this directory from it.
    const foreign = await cluster(root, "pachka-pg-foreign", {
      pid: DEAD_PID,
      dataDir: "/usr/local/var/postgresql@16",
    });

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([]);
    expect(await exists(foreign)).toBe(true);
  });

  it("leaves a freshly created cluster that has no postmaster yet", async () => {
    const root = await sandbox();
    // This is the shape of a concurrent run in the window between mkdtemp and
    // initdb writing its pid file. Deleting it would break a healthy run.
    const starting = await cluster(root, "pachka-pg-starting");

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([]);
    expect(await exists(starting)).toBe(true);
  });

  it("deletes a postmaster-less cluster once it is long past any startup window", async () => {
    const root = await sandbox();
    const abandoned = await cluster(root, "pachka-pg-old001", { ageMs: 60 * 60 * 1000 });

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([abandoned]);
    expect(await exists(abandoned)).toBe(false);
  });

  it("does not touch a directory that is not one of ours", async () => {
    const root = await sandbox();
    // A developer's own PostgreSQL, an unrelated tool's scratch space, and a
    // near-miss name. None carries our prefix; none is in scope.
    const others = await Promise.all([
      cluster(root, "postgresql@16", { pid: DEAD_PID, ageMs: 60 * 60 * 1000 }),
      cluster(root, "pachka-uploads-cache", { ageMs: 60 * 60 * 1000 }),
      cluster(root, "not-pachka-pg-x", { pid: DEAD_PID, ageMs: 60 * 60 * 1000 }),
    ]);

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([]);
    for (const dir of others) expect(await exists(dir)).toBe(true);
  });

  it("reaps the dead while leaving the living, in one pass", async () => {
    const root = await sandbox();
    const dead = await cluster(root, "pachka-pg-dead02", { pid: DEAD_PID });
    const live = await cluster(root, "pachka-pg-live02", { pid: process.pid });

    const reaped = await reapAbandonedClusters(root);

    expect(reaped).toEqual([dead]);
    expect(await exists(dead)).toBe(false);
    expect(await exists(live)).toBe(true);
  });

  it("returns empty rather than throwing when the directory does not exist", async () => {
    // The sweep is housekeeping. It must never be the reason a run fails to
    // start.
    await expect(reapAbandonedClusters(path.join(tmpdir(), "pachka-no-such-dir"))).resolves.toEqual(
      [],
    );
  });
});
