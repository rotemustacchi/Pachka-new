/**
 * Validate that a value read from (or about to be written to) `app_config`
 * actually has the shape its registry entry declares. Pure and side-effect
 * free so it can be unit tested without a database — the database-reading
 * behaviour that calls this lives in `reader.ts` and is integration-tested.
 */
import { AppError } from "@/shared/errors";
import type { ConfigValueType } from "./registry";

export function assertConfigValueMatchesType(
  key: string,
  valueType: ConfigValueType,
  value: unknown,
): void {
  switch (valueType) {
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw mismatch(key, valueType, value);
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw mismatch(key, valueType, value);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        throw mismatch(key, valueType, value);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw mismatch(key, valueType, value);
      }
      return;
    }
    case "json": {
      // Any JSON-representable shape is accepted; there is nothing to check.
      return;
    }
  }
}

function mismatch(key: string, valueType: ConfigValueType, value: unknown): AppError {
  return AppError.validation(
    `app_config."${key}" is declared as "${valueType}" but its stored value is ${JSON.stringify(value)}. ` +
      `An operator likely edited the row directly — fix the value or the migration default, ` +
      `silently falling back would quietly revert a configured setting.`,
    { code: "config.type_mismatch", details: { key, valueType, value } },
  );
}
