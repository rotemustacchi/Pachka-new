/**
 * Money is always an integer count of agorot (1/100 of a shekel) — never a
 * float, never a decimal string (ARCHITECTURE.md, "Non-negotiable technical
 * decisions": "Money is an integer count of agorot. Never a float, never a
 * decimal string."). `Agorot` is a nominal (branded) type so a raw,
 * unvalidated `number` cannot be passed anywhere money is expected — the only
 * way to obtain one is through `agorot()` / `nonNegativeAgorot()`, both of
 * which validate on construction.
 *
 * Judgement call — negative amounts: they ARE accepted by the base
 * `agorot()` constructor. The payout ledger records corrections as
 * "adjusting entries" rather than editing history
 * (openspec/changes/pachka-marketplace-mvp/specs/artist-payouts/spec.md,
 * "Payout ledger": "corrections SHALL be recorded as new adjusting entries
 * rather than edits"), and an adjusting entry that reverses a previous
 * payment is necessarily negative. Any call site that must never see a
 * negative amount — a listed price, an order subtotal — should use
 * `nonNegativeAgorot()` instead of the base constructor to make that
 * guarantee explicit at the boundary rather than downstream.
 */
import { AppError } from "@/shared/errors";

declare const AGOROT_BRAND: unique symbol;

/** An integer count of agorot. Construct with `agorot()` or `nonNegativeAgorot()`. */
export type Agorot = number & { readonly [AGOROT_BRAND]: true };

function assertFiniteInteger(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw AppError.validation(`${label} must be a finite number, got ${String(value)}`, {
      code: "money.not_finite",
    });
  }
  // Integers only: a fractional agora does not exist. Reject loudly rather
  // than rounding — silent rounding is exactly what "never a float" rules out.
  if (!Number.isInteger(value)) {
    throw AppError.validation(
      `Amount must be a whole number of agorot — money is never rounded silently, got ${value}`,
      { code: "money.not_integer" },
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw AppError.validation(
      `Amount exceeds the range that can be safely represented as a number: ${value}`,
      { code: "money.unsafe_range" },
    );
  }
}

/** Construct a validated amount of agorot. Negative values are accepted — see file header. */
export function agorot(value: number): Agorot {
  assertFiniteInteger(value, "Amount");
  return value as Agorot;
}

/** Like `agorot`, but rejects negative values. Use for prices, subtotals, and quantities-worth of money. */
export function nonNegativeAgorot(value: number): Agorot {
  assertFiniteInteger(value, "Amount");
  if (value < 0) {
    throw AppError.validation(`Amount must not be negative, got ${value}`, {
      code: "money.negative_not_allowed",
    });
  }
  return value as Agorot;
}

/** Runtime check that `value` is a valid `Agorot` — a finite, safe, whole number. */
export function isAgorot(value: unknown): value is Agorot {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value)
  );
}

export const zeroAgorot: Agorot = agorot(0);
