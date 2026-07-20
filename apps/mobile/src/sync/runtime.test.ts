import { describe, expect, it, vi } from 'vitest';
import type { NetworkConnectivityBinding } from './connectivity-core';
import { bindSyncRuntime } from './runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('sync runtime binding', () => {
  it('starts offline and waits for the initial foreground refresh before activating', async () => {
    const refreshResult = deferred<boolean | null>();
    const refresh = vi.fn(() => refreshResult.promise);
    const network: NetworkConnectivityBinding = {
      initialOnline: false,
      refresh,
      dispose: vi.fn(),
    };
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };

    const dispose = bindSyncRuntime({
      bindConnectivity: async () => network,
      bindLifecycle(listener) {
        listener(true);
        return vi.fn();
      },
      port,
    });
    await flushMicrotasks();

    expect(port.start).toHaveBeenCalledWith({ active: false, online: false });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(port.setActive).not.toHaveBeenCalled();

    refreshResult.resolve(false);
    await flushMicrotasks();
    expect(port.setActive).toHaveBeenLastCalledWith(true);

    dispose();
    expect(port.stop).toHaveBeenCalledTimes(1);
    expect(network.dispose).toHaveBeenCalledTimes(1);
  });

  it('refreshes and publishes connectivity before every foreground activation', async () => {
    let lifecycleListener: ((active: boolean) => void) | null = null;
    let onlineListener: ((online: boolean) => void) | null = null;
    const order: string[] = [];
    const refresh = vi.fn(async () => {
      order.push('refresh');
      onlineListener!(true);
      return true;
    });
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn((active: boolean) => order.push(`active:${active}`)),
      setOnline: vi.fn((online: boolean) => order.push(`online:${online}`)),
    };

    bindSyncRuntime({
      bindConnectivity: async (onOnline) => {
        onlineListener = onOnline;
        return { initialOnline: false, refresh, dispose: vi.fn() };
      },
      bindLifecycle(listener) {
        lifecycleListener = listener;
        listener(true);
        return vi.fn();
      },
      port,
    });
    await flushMicrotasks();

    expect(order).toEqual(['refresh', 'online:true', 'active:true']);
    lifecycleListener!(false);
    lifecycleListener!(true);
    await flushMicrotasks();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      'refresh',
      'online:true',
      'active:true',
      'active:false',
      'refresh',
      'online:true',
      'active:true',
    ]);
  });

  it('does not reactivate from a stale refresh after the app backgrounds', async () => {
    let lifecycleListener: ((active: boolean) => void) | null = null;
    const refreshResult = deferred<boolean | null>();
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };
    bindSyncRuntime({
      bindConnectivity: async () => ({
        initialOnline: true,
        refresh: () => refreshResult.promise,
        dispose: vi.fn(),
      }),
      bindLifecycle(listener) {
        lifecycleListener = listener;
        return vi.fn();
      },
      port,
    });
    await flushMicrotasks();

    lifecycleListener!(true);
    lifecycleListener!(false);
    refreshResult.resolve(true);
    await flushMicrotasks();

    expect(port.setActive).toHaveBeenCalledTimes(1);
    expect(port.setActive).toHaveBeenLastCalledWith(false);
  });

  it('disposes a late connectivity binding without starting scheduling', async () => {
    const pendingNetwork = deferred<NetworkConnectivityBinding>();
    const network: NetworkConnectivityBinding = {
      initialOnline: true,
      refresh: vi.fn(async () => true),
      dispose: vi.fn(),
    };
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };
    const dispose = bindSyncRuntime({
      bindConnectivity: () => pendingNetwork.promise,
      bindLifecycle: () => vi.fn(),
      port,
    });

    dispose();
    pendingNetwork.resolve(network);
    await flushMicrotasks();

    expect(network.dispose).toHaveBeenCalledTimes(1);
    expect(port.start).not.toHaveBeenCalled();
    expect(port.stop).not.toHaveBeenCalled();
  });

  it('uses a connectivity event received during binding instead of an older initial snapshot', async () => {
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };
    bindSyncRuntime({
      bindConnectivity: async (onOnline) => {
        onOnline(false);
        return {
          initialOnline: true,
          refresh: vi.fn(async () => false),
          dispose: vi.fn(),
        };
      },
      bindLifecycle: () => vi.fn(),
      port,
    });
    await flushMicrotasks();

    expect(port.start).toHaveBeenCalledWith({ active: false, online: false });
    expect(port.setOnline).not.toHaveBeenCalled();
  });

  it('fails visibly and keeps the existing network-error fallback if binding rejects', async () => {
    let lifecycleListener: ((active: boolean) => void) | null = null;
    const error = new Error('binding failed');
    const onError = vi.fn();
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };
    const unbindLifecycle = vi.fn();
    const dispose = bindSyncRuntime({
      bindConnectivity: async () => {
        throw error;
      },
      bindLifecycle(listener) {
        lifecycleListener = listener;
        return unbindLifecycle;
      },
      port,
      onError,
    });
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledWith(error);
    expect(port.start).toHaveBeenCalledWith({ active: false, online: true });
    lifecycleListener!(true);
    expect(port.setActive).toHaveBeenLastCalledWith(true);

    dispose();
    expect(unbindLifecycle).toHaveBeenCalledTimes(1);
    expect(port.stop).toHaveBeenCalledTimes(1);
  });

  it('disposes connectivity and stops scheduling when lifecycle binding throws', async () => {
    const error = new Error('lifecycle unavailable');
    const refreshResult = deferred<boolean | null>();
    const onError = vi.fn();
    const network: NetworkConnectivityBinding = {
      initialOnline: true,
      refresh: vi.fn(() => refreshResult.promise),
      dispose: vi.fn(),
    };
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };

    bindSyncRuntime({
      bindConnectivity: async () => network,
      bindLifecycle(listener) {
        listener(true);
        throw error;
      },
      port,
      onError,
    });
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledWith(error);
    expect(network.dispose).toHaveBeenCalledTimes(1);
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(port.stop).toHaveBeenCalledTimes(1);

    refreshResult.resolve(true);
    await flushMicrotasks();
    expect(port.setActive).not.toHaveBeenCalled();
  });

  it('attempts network disposal and scheduler stop when lifecycle cleanup throws', async () => {
    const cleanupError = new Error('cleanup failed');
    const network: NetworkConnectivityBinding = {
      initialOnline: true,
      refresh: vi.fn(async () => true),
      dispose: vi.fn(),
    };
    const port = {
      start: vi.fn(),
      stop: vi.fn(),
      setActive: vi.fn(),
      setOnline: vi.fn(),
    };
    const dispose = bindSyncRuntime({
      bindConnectivity: async () => network,
      bindLifecycle: () => () => {
        throw cleanupError;
      },
      port,
    });
    await flushMicrotasks();

    expect(() => dispose()).toThrow(cleanupError);
    expect(network.dispose).toHaveBeenCalledTimes(1);
    expect(port.stop).toHaveBeenCalledTimes(1);
  });
});
