/**
 * The PACHKA error taxonomy.
 *
 * Module code throws an `AppError` with one of the kinds below; route handlers
 * translate it into a response with `httpStatusFor`. The point of the taxonomy
 * is that a module never has to know it is being called from HTTP, and a route
 * never has to guess what a thrown error means.
 *
 * Anything that is not an `AppError` is a bug: it becomes a 500 and the
 * original message is not shown to the caller.
 */

export type AppErrorKind =
  /** The input is wrong. The caller can fix it and retry. */
  | "validation"
  /** The thing addressed does not exist, or must not be revealed to exist. */
  | "not_found"
  /** The caller is known but not allowed. */
  | "forbidden"
  /** The request is valid but the current state refuses it (double sale, duplicate). */
  | "conflict"
  /** A dependency outside PACHKA failed: AI provider, mail, payment, storage. */
  | "external_failure";

/** Per-field messages for a validation failure, keyed by field path. */
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export interface AppErrorOptions {
  /**
   * Stable machine-readable code, e.g. `artwork.missing_specifications`.
   * Clients switch on this; they must never switch on the message.
   */
  readonly code?: string;
  /** Structured detail safe to return to the caller. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Field-level messages. Only meaningful for `validation`. */
  readonly fields?: FieldErrors;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly fields: FieldErrors | undefined;

  constructor(kind: AppErrorKind, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.kind = kind;
    this.code = options.code ?? kind;
    this.details = options.details ?? {};
    this.fields = options.fields;
  }

  static validation(message: string, options: AppErrorOptions = {}): AppError {
    return new AppError("validation", message, options);
  }

  static notFound(message: string, options: AppErrorOptions = {}): AppError {
    return new AppError("not_found", message, options);
  }

  static forbidden(message: string, options: AppErrorOptions = {}): AppError {
    return new AppError("forbidden", message, options);
  }

  static conflict(message: string, options: AppErrorOptions = {}): AppError {
    return new AppError("conflict", message, options);
  }

  static externalFailure(message: string, options: AppErrorOptions = {}): AppError {
    return new AppError("external_failure", message, options);
  }

  /**
   * Collect field messages into a single validation error.
   * Used at publish time, where the spec requires every missing field to be
   * reported at once rather than one per round trip.
   */
  static fieldsInvalid(fields: FieldErrors, options: AppErrorOptions = {}): AppError {
    const names = Object.keys(fields);
    return new AppError("validation", `Invalid or missing: ${names.join(", ")}`, {
      ...options,
      fields,
    });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

const STATUS: Record<AppErrorKind, number> = {
  validation: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  external_failure: 502,
};

export function httpStatusFor(error: unknown): number {
  return isAppError(error) ? STATUS[error.kind] : 500;
}

export interface ErrorBody {
  readonly error: {
    readonly kind: AppErrorKind | "internal";
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly fields?: FieldErrors;
  };
}

/**
 * Shape an error for the wire.
 *
 * A non-`AppError` is deliberately flattened to a generic message: an
 * unexpected error may carry a connection string or a row of someone else's
 * data in its message, and none of that belongs in a response.
 */
export function toErrorBody(error: unknown): ErrorBody {
  if (!isAppError(error)) {
    return {
      error: { kind: "internal", code: "internal", message: "Something went wrong" },
    };
  }
  return {
    error: {
      kind: error.kind,
      code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      ...(error.fields ? { fields: error.fields } : {}),
    },
  };
}
