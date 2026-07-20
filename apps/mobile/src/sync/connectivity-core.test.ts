import { describe, expect, it, vi } from 'vitest';
import {
  bindConnectivitySource,
  classifyConnectivity,
  type ConnectivitySource,
  type ConnectivityState,
} from './connectivity-core';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('connectivity source binding', () => {
  it.each([
    [{ isConnected: false, isInternetReachable: true }, false],
    [{ isConnected: true, isInternetReachable: false }, false],
    [{ isConnected: null, isInternetReachable: true }, true],
    [{ isConnected: true, isInternetReachable: null }, true],
    [{ isConnected: null, isInternetReachable: null }, null],
  ] satisfies [ConnectivityState, boolean | null][])('classifies %j as %s', (state, expected) => {
    expect(classifyConnectivity(state)).toBe(expected);
  });

  it('subscribes before sampling and lets a newer event beat a stale initial sample', async () => {
    const sample = deferred<ConnectivityState>();
    let listener: ((state: ConnectivityState) => void) | null = null;
    const unsubscribe = vi.fn();
    const onOnline = vi.fn();
    const source: ConnectivitySource = {
      subscribe(next) {
        listener = next;
        return unsubscribe;
      },
      sample: () => sample.promise,
    };

    const pending = bindConnectivitySource(source, onOnline);
    listener!({ isConnected: false, isInternetReachable: false });
    sample.resolve({ isConnected: true, isInternetReachable: true });
    const binding = await pending;

    expect(binding.initialOnline).toBe(false);
    expect(onOnline).not.toHaveBeenCalled();

    listener!({ isConnected: true, isInternetReachable: true });
    expect(onOnline).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenLastCalledWith(true);

    binding.dispose();
    binding.dispose();
    listener!({ isConnected: false, isInternetReachable: false });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('refreshes known state, ignores unknown state, and preserves the last eligibility', async () => {
    let sampled: ConnectivityState = {
      isConnected: false,
      isInternetReachable: false,
    };
    const onOnline = vi.fn();
    const source: ConnectivitySource = {
      subscribe: () => () => undefined,
      sample: async () => sampled,
    };
    const binding = await bindConnectivitySource(source, onOnline);

    expect(binding.initialOnline).toBe(false);
    sampled = { isConnected: true, isInternetReachable: true };
    await expect(binding.refresh()).resolves.toBe(true);
    expect(onOnline).toHaveBeenLastCalledWith(true);

    sampled = { isConnected: null, isInternetReachable: null };
    await expect(binding.refresh()).resolves.toBe(null);
    expect(onOnline).toHaveBeenCalledTimes(1);
  });

  it('lets the newest overlapping refresh win when an older sample resolves later', async () => {
    const older = deferred<ConnectivityState>();
    const newer = deferred<ConnectivityState>();
    const samples = [older, newer];
    const onOnline = vi.fn();
    const source: ConnectivitySource = {
      subscribe: () => () => undefined,
      sample: async () => ({ isConnected: false, isInternetReachable: false }),
      refresh: vi.fn(() => samples.shift()!.promise),
    };
    const binding = await bindConnectivitySource(source, onOnline);

    const olderResult = binding.refresh();
    const newerResult = binding.refresh();
    newer.resolve({ isConnected: true, isInternetReachable: true });
    await expect(newerResult).resolves.toBe(true);
    older.resolve({ isConnected: false, isInternetReachable: false });
    await expect(olderResult).resolves.toBe(true);

    expect(onOnline).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenLastCalledWith(true);
  });

  it('reports an unavailable source and falls back explicitly to optimistic network probing', async () => {
    const errors: string[] = [];
    const sample = vi.fn(async () => {
      throw new Error('cannot sample');
    });
    const source: ConnectivitySource = {
      subscribe() {
        throw new Error('native module unavailable');
      },
      sample,
    };
    const binding = await bindConnectivitySource(source, vi.fn(), {
      fallbackOnline: true,
      onError: (phase) => errors.push(phase),
    });

    expect(binding.initialOnline).toBe(true);
    expect(errors).toEqual(['subscribe', 'initial-sample']);
    await expect(binding.refresh()).resolves.toBe(null);
    expect(errors).toEqual(['subscribe', 'initial-sample', 'refresh']);
    binding.dispose();
    await expect(binding.refresh()).resolves.toBe(null);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['subscribe', 'initial-sample', 'refresh']);
  });
});
