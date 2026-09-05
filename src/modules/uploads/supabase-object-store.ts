/**
 * The production `ObjectStore`: Supabase Storage, reached with the service-role
 * key, from the server only.
 *
 * ARCHITECTURE.md: "The service-role key is server-only. It may not appear in
 * any module that can be bundled for the browser, in any `NEXT_PUBLIC_*`
 * variable, or in any client component." `createSupabaseServiceRoleClient()` is
 * called lazily inside each method rather than at module load, so importing
 * this file does not itself require the key to be present -- which is what lets
 * the test suite import the module's `index.ts` without a Supabase environment.
 *
 * This adapter is deliberately the thinnest thing that can work. Every decision
 * worth testing lives on the other side of the `ObjectStore` interface, in code
 * the tests reach directly.
 *
 * WHAT IS TESTED HERE, AND HOW, WITHOUT LIVE NETWORK
 * --------------------------------------------------
 * ARCHITECTURE.md's test policy forbids live network in tests, which is why
 * this file used to have no test at all. It now takes its Supabase client
 * through a parameter (`clientFactory`), defaulting to the real one, so
 * `uploads-adapters.test.ts` can drive it with an in-memory stand-in for
 * Supabase Storage and assert on what ended up in which bucket. That is a fake
 * for an external boundary -- the same category `ports.ts` already permits --
 * and every assertion is about stored bytes or a raised error, never about
 * whether a function was called.
 *
 * THE BUCKET SPLIT IS THE POINT
 * -----------------------------
 * SECURITY.md S1-9 item 2: "Originals live in a separate, private bucket with
 * no public read policy and no signed-URL generation from any buyer-facing code
 * path." So there are two buckets and three objects:
 *
 *   ORIGINALS_BUCKET  original    private. Retained, never served.
 *   DISPLAY_BUCKET    display     public.  The detail page.
 *   DISPLAY_BUCKET    thumbnail   public.  The catalog card.
 *
 * Which object goes to which bucket is decided in `pipeline.ts` and the keys
 * come from `keys.ts`; this file just carries bytes to the bucket it is told.
 * That makes the routing testable at the pipeline level, where it belongs --
 * `uploads-adapters.test.ts` runs a real upload through a recording store and
 * asserts the original's bytes appear under `ORIGINALS_BUCKET` and appear in no
 * public object at all.
 *
 * SECURITY.md S1-15 item 1 -- "the browser never writes to the artwork bucket"
 * -- is enforced by the ABSENCE of INSERT policies on `storage.objects` for
 * anon and authenticated (see section 8 of the uploads migration), not by this
 * file. The service-role key is not subject to those policies, which is exactly
 * why it must never leave the server.
 */
import { AppError } from "@/shared/errors";
import { createSupabaseServiceRoleClient } from "@/shared/db";
import type { Bucket, ObjectStore, StoredObject } from "./ports";

/**
 * The slice of the Supabase client this adapter actually uses.
 *
 * Narrow on purpose. The real `SupabaseClient` satisfies it structurally, so
 * production passes the real thing unchanged, and a test can satisfy it with
 * about thirty lines rather than by standing up a storage server. Widening this
 * to `SupabaseClient` would make the seam untestable again for no benefit --
 * three methods is the entire dependency.
 */
export interface StorageObjectBody {
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StorageBucketApi {
  upload(
    key: string,
    body: Uint8Array,
    options: { contentType: string; upsert: boolean },
  ): Promise<{ error: { message: string } | null }>;
  download(key: string): Promise<{
    data: StorageObjectBody | null;
    error: { message: string } | null;
  }>;
  remove(keys: readonly string[]): Promise<{ error: { message: string } | null }>;
}

export interface StorageClient {
  readonly storage: { from(bucket: string): StorageBucketApi };
}

/**
 * How the adapter gets a client. Called per operation, not once at construction.
 *
 * Lazily, because a serverless instance that never uploads anything should
 * never require `SUPABASE_SERVICE_ROLE_KEY` to be set, and because
 * `index.ts` imports this module unconditionally.
 */
export type StorageClientFactory = () => StorageClient;

export function createSupabaseObjectStore(
  clientFactory: StorageClientFactory = createSupabaseServiceRoleClient,
): ObjectStore {
  return {
    async put(bucket: Bucket, key: string, object: StoredObject): Promise<void> {
      const client = clientFactory();
      const { error } = await client.storage
        .from(bucket)
        .upload(key, object.bytes, { contentType: object.contentType, upsert: true });

      if (error) {
        throw AppError.externalFailure(`Storage rejected ${bucket}/${key}: ${error.message}`, {
          code: "uploads.storage_write_failed",
          cause: error,
        });
      }
    },

    async get(bucket: Bucket, key: string): Promise<StoredObject | null> {
      const client = clientFactory();
      const { data, error } = await client.storage.from(bucket).download(key);
      if (error || data === null) return null;

      return {
        bytes: new Uint8Array(await data.arrayBuffer()),
        contentType: data.type,
      };
    },

    async remove(bucket: Bucket, key: string): Promise<void> {
      const client = clientFactory();
      const { error } = await client.storage.from(bucket).remove([key]);
      if (error) {
        throw AppError.externalFailure(
          `Storage could not remove ${bucket}/${key}: ${error.message}`,
          { code: "uploads.storage_remove_failed", cause: error },
        );
      }
    },
  };
}
