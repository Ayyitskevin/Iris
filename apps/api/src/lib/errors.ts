import type { Note } from '@iris/shared';

/**
 * The one error type routes throw. A single error handler (app.ts) turns it into the
 * uniform `{ error: { code, message, conflict?, operationId? } }` envelope the client expects.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly conflict?: Note,
    public readonly operationId?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Authentication required') =>
  new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not permitted') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const paymentRequired = (msg: string) => new HttpError(402, 'payment_required', msg);
export const idempotencyKeyReused = (operationId: string) =>
  new HttpError(
    409,
    'idempotency_key_reused',
    'This sync operation id is already bound to a different request',
    undefined,
    operationId,
  );
/**
 * A durable receipt exists but cannot be safely replayed (null/malformed outcome or
 * unsupported version). Fail closed without re-applying the mutation — clients must
 * park with a terminal hold rather than treat this as a transient 500.
 */
export const syncReceiptIncomplete = (operationId: string, detail: string) =>
  new HttpError(
    409,
    'sync_receipt_incomplete',
    detail,
    undefined,
    operationId,
  );
/** Version conflict: carries the authoritative server note so the client can reconcile. */
export const conflict = (msg: string, serverNote: Note) =>
  new HttpError(409, 'version_conflict', msg, serverNote);
