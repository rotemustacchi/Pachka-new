/**
 * A price column is `bigint` (ARCHITECTURE.md). node-postgres deliberately
 * returns `bigint` (OID 20) columns as strings rather than numbers, because a
 * value above `Number.MAX_SAFE_INTEGER` would otherwise be silently mangled
 * by an implicit `Number()` cast (see `shared/db/client.ts`). This is the one
 * place that string is turned into an `Agorot`, and the one place a value
 * outside the safe integer range is rejected rather than approximated.
 */
import { AppError } from "@/shared/errors";
import { agorot, type Agorot } from "./types";

const BIGINT_PATTERN = /^-?\d+$/;

/** Parse a `bigint` column's string value into money. Rejects anything unsafe rather than mangling it. */
export function fromDbValue(raw: string): Agorot {
  if (typeof raw !== "string" || !BIGINT_PATTERN.test(raw)) {
    throw AppError.validation(`"${String(raw)}" is not a valid bigint value from the database`, {
      code: "money.db.invalid",
    });
  }

  const big = BigInt(raw);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw AppError.validation(
      `Amount ${raw} exceeds the safe integer range and cannot be represented as money`,
      { code: "money.db.unsafe_range" },
    );
  }

  return agorot(Number(big));
}

/** Render for a parameterised query against a `bigint` column. */
export function toDbValue(value: Agorot): string {
  return String(value);
}
