/**
 * Per-client config cache.
 *
 * `app_config` is read on hot paths, so `getConfig` caches with a short TTL.
 * The cache is keyed by the `Sql` (or `Database`/`Tx`) object identity via a
 * `WeakMap` — deliberately NOT a module-level `Map<ConfigKey, ...>` keyed by
 * nothing. A module-level cache would leak between two `Database` instances
 * that point at two different databases (exactly the situation every
 * integration test is in: `useTestDatabase()` hands each test a fresh
 * `Database`), and a value cached while reading test A's database would be
 * served, wrongly, to test B. Keying by the client object itself means each
 * `Database`/`Tx` gets an independent cache that nothing else can see, and it
 * is garbage-collected for free once nothing references that client anymore.
 */
import type { Sql } from "@/shared/db";
import type { ConfigKey } from "./registry";

/**
 * Five seconds. Long enough to matter on a hot path (avoids a query per
 * request under load), short enough that an admin changing a value through
 * `setConfig`/the future admin route sees the effect land for every other
 * process within one TTL window even if `invalidateConfig` is somehow missed.
 * `invalidateConfig` (called automatically by `setConfig`) is the fast path;
 * the TTL is the backstop.
 */
export const CONFIG_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

const caches = new WeakMap<Sql, Map<ConfigKey, CacheEntry>>();

function cacheFor(db: Sql): Map<ConfigKey, CacheEntry> {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  return cache;
}

export type CacheLookup = { readonly hit: true; readonly value: unknown } | { readonly hit: false };

export function readCache(db: Sql, key: ConfigKey): CacheLookup {
  const entry = cacheFor(db).get(key);
  if (!entry || entry.expiresAt <= Date.now()) return { hit: false };
  return { hit: true, value: entry.value };
}

export function writeCache(db: Sql, key: ConfigKey, value: unknown): void {
  cacheFor(db).set(key, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
}

/** Drop one key's cached value, or every key's if `key` is omitted. */
export function invalidateCache(db: Sql, key?: ConfigKey): void {
  const cache = caches.get(db);
  if (!cache) return;
  if (key === undefined) {
    cache.clear();
  } else {
    cache.delete(key);
  }
}
