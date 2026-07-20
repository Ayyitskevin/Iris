import { describe, expect, it } from 'vitest';
import type { SyncOutcome } from './coordinator';
import {
  createSyncScheduler,
  SYNC_EDIT_DEBOUNCE_MS,
  SYNC_IDLE_POLL_MS,
  SYNC_RETRY_MAX_MS,
  SYNC_YIELD_MS,
  type SyncSchedulingContext,
} from './scheduler';

class ManualClock {
  nowMs = 0;
  randomValue = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowMs;
  random = () => this.randomValue;
  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  nextDelay(): number | null {
    const nextAt = Math.min(...[...this.tasks.values()].map((task) => task.at));
    return Number.isFinite(nextAt) ? nextAt - this.nowMs : null;
  }

  async advance(delayMs: number): Promise<void> {
    const target = this.nowMs + delayMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.nowMs = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await flushMicrotasks();
    }
    this.nowMs = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(initialContext: SyncSchedulingContext | null = { key: 'A:1', runnable: true }) {
  const clock = new ManualClock();
  let context = initialContext;
  const runs: string[] = [];
  const outcomes: Array<SyncOutcome | Promise<SyncOutcome>> = [];
  const scheduler = createSyncScheduler({
    readContext: () => context,
    run: async (expectedKey) => {
      runs.push(expectedKey);
      return (await outcomes.shift()) ?? { kind: 'success', hasPendingWork: false };
    },
    clock,
  });
  return {
    clock,
    runs,
    outcomes,
    scheduler,
    setContext(next: SyncSchedulingContext | null) {
      context = next;
    },
  };
}

describe('lifecycle-aware sync scheduler', () => {
  it('trailing-edge debounces editor bursts while preserving the slower idle pull', async () => {
    const h = harness();
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1']);
    expect(h.clock.nextDelay()).toBe(SYNC_IDLE_POLL_MS);

    h.runs.length = 0;
    h.scheduler.request('debounced');
    await h.clock.advance(1_000);
    h.scheduler.request('debounced');
    await h.clock.advance(SYNC_EDIT_DEBOUNCE_MS - 1);
    expect(h.runs).toEqual([]);
    await h.clock.advance(1);
    expect(h.runs).toEqual(['A:1']);
  });

  it('cancels pending work in the background and performs one eligible foreground catch-up', async () => {
    const h = harness();
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    h.runs.length = 0;

    h.scheduler.request('debounced');
    h.scheduler.setActive(false);
    await h.clock.advance(SYNC_IDLE_POLL_MS * 2);
    expect(h.runs).toEqual([]);

    h.scheduler.setActive(true);
    h.scheduler.setActive(true);
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1']);
  });

  it('uses bounded equal-jitter backoff and does not let edits advance its deadline', async () => {
    const h = harness();
    h.outcomes.push(
      { kind: 'transient', reason: 'rate-limit' },
      { kind: 'transient', reason: 'server' },
      { kind: 'success', hasPendingWork: false },
    );
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.runs).toHaveLength(1);
    expect(h.clock.nextDelay()).toBe(1_000);

    h.scheduler.request('debounced');
    await h.clock.advance(999);
    expect(h.runs).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.runs).toHaveLength(2);
    expect(h.clock.nextDelay()).toBe(2_000);

    await h.clock.advance(2_000);
    expect(h.runs).toHaveLength(3);
    expect(h.clock.nextDelay()).toBe(SYNC_IDLE_POLL_MS);
  });

  it('caps exponential retry delay', async () => {
    const h = harness();
    h.clock.randomValue = 1;
    for (let index = 0; index < 10; index += 1) {
      h.outcomes.push({ kind: 'transient', reason: 'server' });
    }
    h.scheduler.start({ active: true, online: true });

    for (let index = 0; index < 10; index += 1) {
      await h.clock.advance(h.clock.nextDelay() ?? 0);
      expect(h.clock.nextDelay()).toBeLessThanOrEqual(SYNC_RETRY_MAX_MS);
    }
    expect(h.clock.nextDelay()).toBe(SYNC_RETRY_MAX_MS);
  });

  it('preserves rate-limit backoff across lifecycle flaps but probes a restored network', async () => {
    const rateLimited = harness();
    rateLimited.outcomes.push({ kind: 'transient', reason: 'rate-limit' });
    rateLimited.scheduler.start({ active: true, online: true });
    await rateLimited.clock.advance(0);
    rateLimited.scheduler.setActive(false);
    await rateLimited.clock.advance(200);
    rateLimited.scheduler.setActive(true);
    expect(rateLimited.clock.nextDelay()).toBe(800);

    const network = harness();
    network.outcomes.push({ kind: 'transient', reason: 'network' });
    network.scheduler.start({ active: true, online: true });
    await network.clock.advance(0);
    network.scheduler.setOnline(false);
    await network.clock.advance(200);
    network.scheduler.setOnline(true);
    await network.clock.advance(0);
    expect(network.runs).toHaveLength(2);
  });

  it('never retargets an A timer to B', async () => {
    const h = harness();
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    h.runs.length = 0;

    h.scheduler.request('debounced');
    h.setContext({ key: 'B:2', runnable: true });
    await h.clock.advance(SYNC_EDIT_DEBOUNCE_MS);
    expect(h.runs).toEqual([]);

    h.scheduler.contextChanged();
    await h.clock.advance(0);
    expect(h.runs).toEqual(['B:2']);
  });

  it('wakes B after an in-flight A cycle settles without transferring A backoff', async () => {
    const h = harness();
    const first = deferred<SyncOutcome>();
    h.outcomes.push(first.promise, { kind: 'success', hasPendingWork: false });
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1']);

    h.setContext({ key: 'B:2', runnable: true });
    h.scheduler.contextChanged();
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1']);

    first.resolve({ kind: 'transient', reason: 'server' });
    await flushMicrotasks();
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1', 'B:2']);
    expect(h.clock.nextDelay()).toBe(SYNC_IDLE_POLL_MS);
  });

  it('coalesces triggers during one run and never immediately repeats a transient failure', async () => {
    const h = harness();
    const first = deferred<SyncOutcome>();
    h.outcomes.push(first.promise, { kind: 'success', hasPendingWork: false });
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1']);

    h.scheduler.request('immediate');
    h.scheduler.request('immediate');
    first.resolve({ kind: 'transient', reason: 'server' });
    await flushMicrotasks();
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1']);
    expect(h.clock.nextDelay()).toBe(1_000);
    await h.clock.advance(1_000);
    expect(h.runs).toEqual(['A:1', 'A:1']);
  });

  it('parks non-transient outcomes until a later immediate wake', async () => {
    const h = harness();
    h.outcomes.push({ kind: 'sync-gated' }, { kind: 'success', hasPendingWork: false });
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    h.scheduler.request('debounced');
    await h.clock.advance(SYNC_IDLE_POLL_MS * 2);
    expect(h.runs).toHaveLength(1);

    h.scheduler.setOnline(false);
    h.scheduler.setOnline(true);
    await h.clock.advance(0);
    expect(h.runs).toHaveLength(1);

    h.scheduler.setActive(false);
    h.scheduler.setActive(true);
    await h.clock.advance(0);
    expect(h.runs).toHaveLength(2);
  });

  it('retains explicit recovery intent while parked and offline', async () => {
    const h = harness();
    h.outcomes.push({ kind: 'sync-gated' }, { kind: 'success', hasPendingWork: false });
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.runs).toHaveLength(1);

    h.scheduler.setOnline(false);
    h.scheduler.request('immediate');
    await h.clock.advance(SYNC_IDLE_POLL_MS);
    expect(h.runs).toHaveLength(1);

    h.scheduler.setOnline(true);
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1', 'A:1']);
  });

  it('retains a foreground restart probe while parked and offline', async () => {
    const h = harness();
    h.outcomes.push({ kind: 'sync-gated' }, { kind: 'success', hasPendingWork: false });
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.runs).toHaveLength(1);

    h.scheduler.stop();
    h.scheduler.start({ active: true, online: false });
    await h.clock.advance(SYNC_IDLE_POLL_MS);
    expect(h.runs).toHaveLength(1);

    h.scheduler.setOnline(true);
    await h.clock.advance(0);
    expect(h.runs).toEqual(['A:1', 'A:1']);
  });

  it('yields quickly when a successful bounded cycle reports remaining work', async () => {
    const h = harness();
    h.outcomes.push(
      { kind: 'success', hasPendingWork: true },
      { kind: 'success', hasPendingWork: false },
    );
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    expect(h.clock.nextDelay()).toBe(SYNC_YIELD_MS);
    await h.clock.advance(SYNC_YIELD_MS);
    expect(h.runs).toEqual(['A:1', 'A:1']);
  });

  it('does not start a second run after backgrounding an in-flight cycle', async () => {
    const h = harness();
    const first = deferred<SyncOutcome>();
    h.outcomes.push(first.promise);
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    h.scheduler.request('immediate');
    h.scheduler.setActive(false);
    first.resolve({ kind: 'success', hasPendingWork: false });
    await flushMicrotasks();
    await h.clock.advance(SYNC_IDLE_POLL_MS * 2);
    expect(h.runs).toEqual(['A:1']);
  });

  it('retains a transient deadline when its in-flight request fails in the background', async () => {
    const h = harness();
    const first = deferred<SyncOutcome>();
    h.outcomes.push(first.promise);
    h.scheduler.start({ active: true, online: true });
    await h.clock.advance(0);
    h.scheduler.setActive(false);
    first.resolve({ kind: 'transient', reason: 'server' });
    await flushMicrotasks();

    await h.clock.advance(200);
    h.scheduler.setActive(true);
    expect(h.clock.nextDelay()).toBe(800);
    await h.clock.advance(800);
    expect(h.runs).toEqual(['A:1', 'A:1']);
  });
});
