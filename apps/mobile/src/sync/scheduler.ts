import type { SyncOutcome, SyncTransientReason } from './coordinator';

export const SYNC_EDIT_DEBOUNCE_MS = 1_500;
export const SYNC_IDLE_POLL_MS = 30_000;
export const SYNC_RETRY_BASE_MS = 2_000;
export const SYNC_RETRY_MAX_MS = 300_000;
export const SYNC_YIELD_MS = 50;

export interface SyncSchedulingContext {
  /** Exact session generation + owner + device identity. Never contains a bearer credential. */
  readonly key: string;
  /** False for durable sync holds; authority/recovery/session fences return no context. */
  readonly runnable: boolean;
}

export interface SyncSchedulerClock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncSchedulerDependencies {
  readContext(): SyncSchedulingContext | null;
  run(expectedKey: string): Promise<SyncOutcome>;
  clock?: Partial<SyncSchedulerClock>;
}

export type SyncRequestPriority = 'immediate' | 'debounced';

export interface SyncScheduler {
  start(options: { active: boolean; online: boolean }): void;
  stop(): void;
  request(priority: SyncRequestPriority): void;
  contextChanged(): void;
  setActive(active: boolean): void;
  setOnline(online: boolean): void;
}

type TimerKind = 'immediate' | 'debounce' | 'backoff' | 'yield' | 'idle';

interface ScheduledTimer {
  readonly handle: unknown;
  readonly kind: TimerKind;
  readonly key: string;
}

interface RetryDeadline {
  readonly key: string;
  readonly at: number;
  readonly reason: SyncTransientReason;
}

function strongerPriority(
  current: SyncRequestPriority | null,
  next: SyncRequestPriority,
): SyncRequestPriority {
  return current === 'immediate' || next === 'immediate' ? 'immediate' : 'debounced';
}

function boundedRandom(random: number): number {
  if (!Number.isFinite(random)) return 0;
  return Math.min(1, Math.max(0, random));
}

/**
 * One owner-fenced foreground scheduler. Local writes remain synchronous; only network timing
 * is deferred. Every timer captures an exact context key and refuses to retarget itself later.
 */
export function createSyncScheduler(deps: SyncSchedulerDependencies): SyncScheduler {
  const clock: SyncSchedulerClock = {
    now: deps.clock?.now ?? (() => Date.now()),
    random: deps.clock?.random ?? Math.random,
    setTimeout:
      deps.clock?.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)),
    clearTimeout:
      deps.clock?.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number)),
  };

  let started = false;
  let active = false;
  let online = true;
  let observedKey: string | null = null;
  let timer: ScheduledTimer | null = null;
  let running = false;
  let queued: SyncRequestPriority | null = null;
  let retryAttempt = 0;
  let retryDeadline: RetryDeadline | null = null;
  let parkedKey: string | null = null;

  function cancelTimer(): void {
    if (!timer) return;
    clock.clearTimeout(timer.handle);
    timer = null;
  }

  function refreshContext(): SyncSchedulingContext | null {
    const context = deps.readContext();
    const key = context?.key ?? null;
    if (key !== observedKey) {
      cancelTimer();
      observedKey = key;
      queued = null;
      retryAttempt = 0;
      retryDeadline = null;
      parkedKey = null;
    }
    return context;
  }

  function retryDelayMs(): number {
    const exponent = Math.min(retryAttempt, 30);
    const ceiling = Math.min(SYNC_RETRY_BASE_MS * 2 ** exponent, SYNC_RETRY_MAX_MS);
    const random = boundedRandom(clock.random());
    return Math.round(ceiling / 2 + (ceiling / 2) * random);
  }

  function scheduleTimer(kind: TimerKind, key: string, delayMs: number): void {
    cancelTimer();
    const scheduled: ScheduledTimer = {
      handle: clock.setTimeout(
        () => {
          if (timer !== scheduled) return;
          timer = null;
          void execute(key);
        },
        Math.max(0, delayMs),
      ),
      kind,
      key,
    };
    timer = scheduled;
  }

  function scheduleRetryIfNeeded(context: SyncSchedulingContext): boolean {
    if (!retryDeadline || retryDeadline.key !== context.key) return false;
    const remaining = retryDeadline.at - clock.now();
    if (remaining <= 0) {
      retryDeadline = null;
      return false;
    }
    if (!timer || timer.kind !== 'backoff' || timer.key !== context.key) {
      scheduleTimer('backoff', context.key, remaining);
    }
    return true;
  }

  function request(priority: SyncRequestPriority): void {
    if (!started) return;
    const context = refreshContext();
    if (!context?.runnable) return;

    // An explicit recovery may complete while backgrounded or offline. Remember that the parked
    // outcome was cleared, then let the next eligible lifecycle/connectivity wake dispatch it.
    // Retry deadlines remain authoritative and are checked once dispatch becomes eligible.
    if (priority === 'immediate') parkedKey = null;
    if (!active || !online) return;
    if (scheduleRetryIfNeeded(context)) return;

    if (priority === 'debounced' && parkedKey === context.key) return;

    if (running) {
      queued = strongerPriority(queued, priority);
      return;
    }

    if (priority === 'immediate') {
      if (timer?.kind !== 'immediate' || timer.key !== context.key) {
        scheduleTimer('immediate', context.key, 0);
      }
      return;
    }

    // Repeated edits reset one trailing-edge debounce. A due retry is preserved above.
    if (timer?.kind === 'immediate' && timer.key === context.key) return;
    scheduleTimer('debounce', context.key, SYNC_EDIT_DEBOUNCE_MS);
  }

  function scheduleAfterOutcome(key: string, outcome: SyncOutcome): void {
    const context = refreshContext();
    if (!started) return;
    if (context?.key !== key) {
      // A credential/owner/device replacement can happen while the prior context is in flight.
      // Its completion must neither transfer A's outcome policy to B nor strand the catch-up B
      // queued while `running` was true.
      queued = null;
      if (active && online && context?.runnable) request('immediate');
      return;
    }

    const pending = queued;
    queued = null;

    if (outcome.kind === 'transient') {
      const delayMs = retryDelayMs();
      retryAttempt += 1;
      retryDeadline = { key, at: clock.now() + delayMs, reason: outcome.reason };
      if (active && online && context.runnable) scheduleTimer('backoff', key, delayMs);
      return;
    }

    retryAttempt = 0;
    retryDeadline = null;

    if (outcome.kind !== 'success') {
      parkedKey = key;
      return;
    }

    parkedKey = null;
    if (!active || !online || !context.runnable) return;
    if (pending) {
      request(pending);
      return;
    }
    scheduleTimer(
      outcome.hasPendingWork ? 'yield' : 'idle',
      key,
      outcome.hasPendingWork ? SYNC_YIELD_MS : SYNC_IDLE_POLL_MS,
    );
  }

  async function execute(expectedKey: string): Promise<void> {
    if (!started || !active || !online || running) return;
    const context = refreshContext();
    if (!context?.runnable || context.key !== expectedKey) return;
    if (scheduleRetryIfNeeded(context)) return;

    running = true;
    let outcome: SyncOutcome;
    try {
      outcome = await deps.run(expectedKey);
    } catch {
      // The coordinator is expected to return typed outcomes. An unexpected rejection is a
      // local/programming failure and must not become a silent network retry loop.
      outcome = { kind: 'local-error' };
    } finally {
      running = false;
    }
    scheduleAfterOutcome(expectedKey, outcome);
  }

  function wake(): void {
    request('immediate');
  }

  function start(options: { active: boolean; online: boolean }): void {
    if (started) {
      setOnline(options.online);
      setActive(options.active);
      return;
    }
    started = true;
    active = options.active;
    online = options.online;
    refreshContext();
    // Record the foreground probe even when offline so a parked prior mount cannot suppress the
    // eventual reconnect. `request` clears only the park and preserves retry deadlines.
    if (active) wake();
  }

  function stop(): void {
    if (!started && !timer) return;
    started = false;
    active = false;
    cancelTimer();
    queued = null;
  }

  function contextChanged(): void {
    if (!started) return;
    refreshContext();
    if (active && online) wake();
  }

  function setActive(nextActive: boolean): void {
    if (active === nextActive) return;
    active = nextActive;
    if (!started) return;
    if (!active) {
      cancelTimer();
      queued = null;
      return;
    }
    wake();
  }

  function setOnline(nextOnline: boolean): void {
    if (online === nextOnline) return;
    online = nextOnline;
    if (!started) return;
    if (!online) {
      cancelTimer();
      queued = null;
      return;
    }
    const context = refreshContext();
    if (retryDeadline && retryDeadline.key === context?.key && retryDeadline.reason === 'network') {
      retryDeadline = null;
    }
    // Connectivity restoration may pull forward a transport failure or ordinary idle work. It
    // must not turn a billing gate or local/programming failure into an automatic retry.
    if (parkedKey === context?.key) return;
    wake();
  }

  return { start, stop, request, contextChanged, setActive, setOnline };
}
