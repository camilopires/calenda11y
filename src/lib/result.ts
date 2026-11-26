/**
 * Supabase and Resend return `{ data, error }` instead of throwing. Every call
 * goes through `unwrap` so an error can never be silently ignored.
 */

export class ServiceError extends Error {
  readonly service: string;
  readonly code: string | undefined;
  readonly details: unknown;
  constructor(service: string, message: string, code?: string, details?: unknown) {
    super(`${service}: ${message}`);
    this.name = 'ServiceError';
    this.service = service;
    this.code = code;
    this.details = details;
  }
}

interface ErrorLike {
  message?: string;
  code?: string;
  name?: string;
}

export function unwrap<T>(result: { data: T | null; error: ErrorLike | null }, service = 'supabase', context = ''): T {
  if (result.error) {
    const e = result.error;
    throw new ServiceError(
      service,
      `${context ? `${context}: ` : ''}${e.message ?? 'unknown error'}`,
      e.code ?? e.name,
      e,
    );
  }
  if (result.data === null || result.data === undefined) {
    throw new ServiceError(service, `${context ? `${context}: ` : ''}no data returned`);
  }
  return result.data;
}

/** Like unwrap, but `null` data (e.g. `.maybeSingle()` with no row) is allowed. */
export function unwrapMaybe<T>(
  result: { data: T | null; error: ErrorLike | null },
  service = 'supabase',
  context = '',
): T | null {
  if (result.error) {
    const e = result.error;
    throw new ServiceError(
      service,
      `${context ? `${context}: ` : ''}${e.message ?? 'unknown error'}`,
      e.code ?? e.name,
      e,
    );
  }
  return result.data ?? null;
}
