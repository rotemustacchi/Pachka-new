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
 * This adapter is deliberately the thinnest thing that can work. It is the one
 * file in the module with no integration test behind it, because testing it
 * would mean live network, which ARCHITECTURE.md's test policy forbids. Every
 * decision worth testing therefore lives on the other side of the `ObjectStore`
 * interface, in code the tests do reach.
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

export function createSupabaseObjectStore(): ObjectStore {
  return {
    async put(bucket: Bucket, key: string, object: StoredObject): Promise<void> {
      const client = createSupabaseServiceRoleClient();
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
      const client = createSupabaseServiceRoleClient();
      const { data, error } = await client.storage.from(bucket).download(key);
      if (error || data === null) return null;

      return {
        bytes: new Uint8Array(await data.arrayBuffer()),
        contentType: data.type,
      };
    },

    async remove(bucket: Bucket, key: string): Promise<void> {
      const client = createSupabaseServiceRoleClient();
      const { error } = await client.storage.from(bucket).remove([key]);
      if (error) {
        throw AppError.externalFailure(`Storage could not remove ${bucket}/${key}: ${error.message}`, {
          code: "uploads.storage_remove_failed",
          cause: error,
        });
      }
    },
  };
}
