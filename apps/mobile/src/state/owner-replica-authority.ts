/**
 * Current-runtime web authority for one owner replica.
 *
 * The Web Lock is the write/sync fence. BroadcastChannel is only an invalidation hint:
 * followers always re-read IndexedDB and never receive replica or credential bytes here.
 */

export const OWNER_AUTHORITY_NOTICE_VERSION = 1 as const;

export type OwnerAuthorityRole = 'acquiring' | 'leader' | 'follower' | 'unavailable';

export interface OwnerAuthoritySnapshot {
  readonly ownerKey: string;
  readonly epoch: number;
  readonly role: OwnerAuthorityRole;
}

export interface OwnerAuthorityRefreshNotice {
  readonly version: typeof OWNER_AUTHORITY_NOTICE_VERSION;
  readonly type: 'replica-changed';
}

export interface OwnerAuthorityHooks {
  /** Called before a newly acquired lock is exposed as writable authority. */
  prepareLeader(snapshot: OwnerAuthoritySnapshot): Promise<void>;
  onRole(snapshot: OwnerAuthoritySnapshot): void;
  onRefresh(snapshot: OwnerAuthoritySnapshot): void;
}

export interface OwnerAuthorityHandle {
  snapshot(): OwnerAuthoritySnapshot;
  /** Publish the exact metadata-only refresh notice after a verified replica commit. */
  publishRefresh(): void;
  close(): Promise<void>;
}

export interface OwnerAuthorityDriver {
  start(ownerKey: string, hooks: OwnerAuthorityHooks): Promise<OwnerAuthorityHandle>;
}

export interface BroadcastChannelPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface OwnerLockPort {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: object | null) => Promise<void> | void,
  ): Promise<unknown>;
}

export interface WebOwnerAuthorityPort {
  locks: OwnerLockPort;
  createChannel(name: string): BroadcastChannelPort;
}

export class OwnerAuthorityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OwnerAuthorityError';
  }
}

export function ownerAuthorityLockName(ownerKey: string): string {
  return 'iris.owner-authority.v1.lock.' + encodeURIComponent(ownerKey);
}

export function ownerAuthorityChannelName(ownerKey: string): string {
  return 'iris.owner-authority.v1.channel.' + encodeURIComponent(ownerKey);
}

export function parseOwnerAuthorityRefreshNotice(
  value: unknown,
): OwnerAuthorityRefreshNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'type' ||
    keys[1] !== 'version' ||
    record.version !== OWNER_AUTHORITY_NOTICE_VERSION ||
    record.type !== 'replica-changed'
  ) {
    return null;
  }
  return Object.freeze({ version: OWNER_AUTHORITY_NOTICE_VERSION, type: 'replica-changed' });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Single-process/native/legacy authority: no lock or channel is opened; preparation still gates it. */
export class AlwaysWritableOwnerAuthorityDriver implements OwnerAuthorityDriver {
  async start(ownerKey: string, hooks: OwnerAuthorityHooks): Promise<OwnerAuthorityHandle> {
    const acquiring = Object.freeze({ ownerKey, epoch: 1, role: 'acquiring' as const });
    hooks.onRole(acquiring);
    try {
      await hooks.prepareLeader(acquiring);
    } catch (cause) {
      // Native transactional startup has no follower process that can keep a usable projection
      // alive when preparation discovers divergence. Return an installed fail-closed handle just
      // like the web driver so hydration can retain a valid primary fenced/read-only or open a
      // separately verified recovery snapshot instead of erasing the session behind the global
      // error boundary.
      return failedHandle(ownerKey, hooks, cause);
    }
    const leader = Object.freeze({ ownerKey, epoch: 2, role: 'leader' as const });
    hooks.onRole(leader);
    return {
      snapshot: () => leader,
      publishRefresh: () => undefined,
      close: async () => undefined,
    };
  }
}

/**
 * Browser implementation. `start` resolves after the initial leader/follower/unavailable
 * classification, never after the held lock is released.
 */
export class WebOwnerAuthorityDriver implements OwnerAuthorityDriver {
  constructor(private readonly port: WebOwnerAuthorityPort) {}

  async start(ownerKey: string, hooks: OwnerAuthorityHooks): Promise<OwnerAuthorityHandle> {
    let channel: BroadcastChannelPort;
    try {
      channel = this.port.createChannel(ownerAuthorityChannelName(ownerKey));
    } catch (cause) {
      return failedHandle(ownerKey, hooks, cause);
    }

    let epoch = 0;
    let current = Object.freeze({
      ownerKey,
      epoch,
      role: 'acquiring' as OwnerAuthorityRole,
    });
    let closed = false;
    let initialSettled = false;
    let settleInitial!: () => void;
    const initial = new Promise<void>((resolve) => {
      settleInitial = resolve;
    });
    const queuedAbort = new AbortController();
    const operations = new Set<Promise<unknown>>();
    let releaseHeldLock: (() => void) | null = null;
    let channelClosed = false;

    const publishRole = (role: OwnerAuthorityRole): OwnerAuthoritySnapshot => {
      epoch += 1;
      current = Object.freeze({ ownerKey, epoch, role });
      if (!closed) hooks.onRole(current);
      if (!initialSettled && role !== 'acquiring') {
        initialSettled = true;
        settleInitial();
      }
      return current;
    };

    const releaseRuntimePrimitives = (): void => {
      queuedAbort.abort();
      const release = releaseHeldLock;
      releaseHeldLock = null;
      release?.();
      channel.onmessage = null;
      if (channelClosed) return;
      channelClosed = true;
      try {
        channel.close();
      } catch {
        // A closed channel cannot restore authority; releasing the lock remains the priority.
      }
    };

    const failClosed = (cause: unknown): void => {
      if (closed || isAbortError(cause)) return;
      publishRole('unavailable');
      // Once the coordination channel is unreliable, this tab must stop writing and let a
      // healthy waiter acquire the owner lock. It never falls back to uncoordinated legacy state.
      releaseRuntimePrimitives();
    };

    const holdLock = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseHeldLock = resolve;
      });

    const prepareAndHold = async (): Promise<void> => {
      if (closed) return;
      const acquiring = publishRole('acquiring');
      try {
        await hooks.prepareLeader(acquiring);
      } catch (cause) {
        failClosed(cause);
        return;
      }
      if (closed) return;
      publishRole('leader');
      await holdLock();
    };

    const track = (operation: Promise<unknown>): void => {
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => undefined);
    };

    const queueTakeover = (): void => {
      if (closed) return;
      let operation: Promise<unknown>;
      try {
        operation = this.port.locks.request(
          ownerAuthorityLockName(ownerKey),
          { mode: 'exclusive', signal: queuedAbort.signal },
          async (lock) => {
            if (!lock || closed) return;
            await prepareAndHold();
          },
        );
      } catch (cause) {
        failClosed(cause);
        return;
      }
      track(operation);
      void operation.catch(failClosed);
    };

    channel.onmessage = (event) => {
      if (closed || current.role !== 'follower' || !parseOwnerAuthorityRefreshNotice(event.data)) {
        return;
      }
      hooks.onRefresh(current);
    };

    let initialRequest: Promise<unknown>;
    try {
      initialRequest = this.port.locks.request(
        ownerAuthorityLockName(ownerKey),
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (closed) return;
          if (lock) {
            await prepareAndHold();
            return;
          }
          publishRole('follower');
          queueTakeover();
        },
      );
    } catch (cause) {
      failClosed(cause);
      initialRequest = Promise.resolve();
    }
    track(initialRequest);
    void initialRequest.catch(failClosed);

    await initial;

    return {
      snapshot: () => current,
      publishRefresh: () => {
        if (closed || current.role !== 'leader') {
          throw new OwnerAuthorityError('Only the current owner leader may publish a refresh');
        }
        try {
          channel.postMessage({
            version: OWNER_AUTHORITY_NOTICE_VERSION,
            type: 'replica-changed',
          } satisfies OwnerAuthorityRefreshNotice);
        } catch (cause) {
          failClosed(cause);
          throw new OwnerAuthorityError('Owner refresh notice could not be published', { cause });
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        releaseRuntimePrimitives();
        await Promise.allSettled([...operations]);
      },
    };
  }
}

async function failedHandle(
  ownerKey: string,
  hooks: OwnerAuthorityHooks,
  cause: unknown,
): Promise<OwnerAuthorityHandle> {
  const snapshot = Object.freeze({ ownerKey, epoch: 1, role: 'unavailable' as const });
  hooks.onRole(snapshot);
  const error = new OwnerAuthorityError('Owner authority could not be initialized', { cause });
  return {
    snapshot: () => snapshot,
    publishRefresh: () => {
      throw error;
    },
    close: async () => undefined,
  };
}
