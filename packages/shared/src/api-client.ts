/**
 * A tiny typed client over the Iris REST API, shared by the Expo app (and usable by
 * any agent in TypeScript). Dependency-free — just `fetch`. All methods are
 * workspace-scoped implicitly by the bearer token.
 */
import {
  SyncChangesResponse as SyncChangesResponseSchema,
  SyncPushResponse as SyncPushResponseSchema,
} from './schemas';
import type {
  ActivityListResponse,
  AgentTokenListResponse,
  AuthResponse,
  BillingStatus,
  CreateCheckoutResponse,
  CreateNoteRequest,
  IssueAgentTokenRequest,
  IssueAgentTokenResponse,
  Note,
  NoteListResponse,
  NoteVersionListResponse,
  RegisterDeviceRequest,
  RestoreVersionRequest,
  SearchResponse,
  SignInRequest,
  SignUpRequest,
  SyncChangesResponse,
  SyncPushRequest,
  SyncPushResponse,
  TagListResponse,
  UndoResponse,
  UpdateNoteRequest,
} from './schemas';

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the current bearer token (user session or agent token), or null. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof fetch;
}

/** Thrown when a successful sync response does not satisfy the shared wire schema. */
export class ApiResponseValidationError extends Error {
  constructor(
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`API returned an invalid successful response for ${path}`, options);
    this.name = 'ApiResponseValidationError';
  }
}

/** Thrown on any non-2xx response. `conflict` exists only on `version_conflict`. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly conflict?: Note,
    public readonly operationId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Single-note optimistic-concurrency failure with an authoritative note. */
  get isConflict(): boolean {
    return this.status === 409 && this.code === 'version_conflict';
  }

  /** Sync operation id was already bound to another actor/device/payload. */
  get isIdempotencyKeyReused(): boolean {
    return this.status === 409 && this.code === 'idempotency_key_reused';
  }

  /** 402 Payment Required — the multi-device sync gate (ADR-007). */
  get isPaymentRequired(): boolean {
    return this.status === 402;
  }
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    overrideToken?: string,
    validateResponse?: (value: unknown) => T,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const token = overrideToken ?? (await options.getToken?.());
    if (token) headers['authorization'] = `Bearer ${token}`;

    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 204 && !validateResponse) return undefined as T;

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch (cause) {
      if (res.ok) throw new ApiResponseValidationError(path, { cause });
      throw new ApiRequestError(res.status, 'unknown', `Request failed with ${res.status}`);
    }

    if (!res.ok) {
      const err =
        json && typeof json === 'object' && 'error' in json
          ? ((json as { error?: Record<string, unknown> }).error ?? {})
          : {};
      throw new ApiRequestError(
        res.status,
        typeof err.code === 'string' ? err.code : 'unknown',
        typeof err.message === 'string' ? err.message : `Request failed with ${res.status}`,
        err.conflict as Note | undefined,
        typeof err.operationId === 'string' ? err.operationId : undefined,
      );
    }
    if (!validateResponse) return json as T;
    try {
      return validateResponse(json);
    } catch (cause) {
      throw new ApiResponseValidationError(path, { cause });
    }
  }

  return {
    request,

    // --- Auth ---
    signUp: (b: SignUpRequest) => request<AuthResponse>('POST', '/v1/auth/sign-up', b),
    signIn: (b: SignInRequest) => request<AuthResponse>('POST', '/v1/auth/sign-in', b),
    me: () => request<AuthResponse>('GET', '/v1/auth/me'),

    // --- Notes ---
    listNotes: (tag?: string) =>
      request<NoteListResponse>(
        'GET',
        tag ? `/v1/notes?tag=${encodeURIComponent(tag)}` : '/v1/notes',
      ),
    searchNotes: (q: string) =>
      request<SearchResponse>('GET', `/v1/notes/search?q=${encodeURIComponent(q)}`),
    listTags: () => request<TagListResponse>('GET', '/v1/tags'),
    getNote: (id: string) => request<{ note: Note }>('GET', `/v1/notes/${id}`),
    createNote: (b: CreateNoteRequest) => request<{ note: Note }>('POST', '/v1/notes', b),
    updateNote: (id: string, b: UpdateNoteRequest) =>
      request<{ note: Note }>('PATCH', `/v1/notes/${id}`, b),
    deleteNote: (id: string, baseVersion: number) =>
      request<{ note: Note }>('DELETE', `/v1/notes/${id}`, { baseVersion }),

    // --- Versions ---
    listVersions: (id: string) =>
      request<NoteVersionListResponse>('GET', `/v1/notes/${id}/versions`),
    restoreVersion: (id: string, b: RestoreVersionRequest) =>
      request<{ note: Note }>('POST', `/v1/notes/${id}/restore`, b),

    // --- Agents ---
    issueAgentToken: (b: IssueAgentTokenRequest) =>
      request<IssueAgentTokenResponse>('POST', '/v1/agents/tokens', b),
    listAgentTokens: () => request<AgentTokenListResponse>('GET', '/v1/agents/tokens'),
    revokeAgentToken: (id: string) => request<void>('DELETE', `/v1/agents/tokens/${id}`),

    // --- Activity ---
    listActivity: () => request<ActivityListResponse>('GET', '/v1/activity'),
    undoActivity: (id: string) => request<UndoResponse>('POST', `/v1/activity/${id}/undo`),

    // --- Sync ---
    syncChanges: (since: string, deviceId: string) =>
      request<SyncChangesResponse>(
        'GET',
        `/v1/sync/changes?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}`,
        undefined,
        undefined,
        (value) => SyncChangesResponseSchema.parse(value),
      ),
    syncPush: (b: SyncPushRequest) =>
      request<SyncPushResponse>('POST', '/v1/sync/push', b, undefined, (value) =>
        SyncPushResponseSchema.parse(value),
      ),

    // --- Devices & billing ---
    registerDevice: (b: RegisterDeviceRequest) =>
      request<{ activeDevices: number }>('POST', '/v1/devices', b),
    billingStatus: () => request<BillingStatus>('GET', '/v1/billing/status'),
    createCheckout: () => request<CreateCheckoutResponse>('POST', '/v1/billing/checkout'),

    // --- Export ---
    exportUrl: () => `${base}/v1/export`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
