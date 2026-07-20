import type { NetworkConnectivityBinding } from './connectivity-core';

interface SyncRuntimePort {
  start(options: { active: boolean; online: boolean }): void;
  stop(): void;
  setActive(active: boolean): void;
  setOnline(online: boolean): void;
}

interface SyncRuntimeDependencies {
  bindConnectivity(onOnline: (online: boolean) => void): Promise<NetworkConnectivityBinding>;
  bindLifecycle(listener: (active: boolean) => void): () => void;
  readonly port: SyncRuntimePort;
  readonly onError?: (error: unknown) => void;
}

/**
 * Own the ordering between connectivity and AppState. Scheduling starts inactive
 * from a subscribe-before-sample connectivity snapshot; each foreground transition
 * refreshes native state before timers can resume.
 */
export function bindSyncRuntime(deps: SyncRuntimeDependencies): () => void {
  let disposed = false;
  let started = false;
  let activationRequest = 0;
  let network: NetworkConnectivityBinding | null = null;
  let bufferedOnline: boolean | null = null;
  let unbindLifecycle: () => void = () => undefined;

  const bindLifecycle = (refreshBeforeActive: boolean) => {
    unbindLifecycle = deps.bindLifecycle((active) => {
      const request = ++activationRequest;
      if (!active) {
        deps.port.setActive(false);
        return;
      }
      if (!refreshBeforeActive || !network) {
        deps.port.setActive(true);
        return;
      }
      void network
        .refresh()
        .catch((error: unknown) => deps.onError?.(error))
        .finally(() => {
          if (!disposed && request === activationRequest) deps.port.setActive(true);
        });
    });
  };

  void deps
    .bindConnectivity((online) => {
      if (disposed) return;
      if (started) deps.port.setOnline(online);
      else bufferedOnline = online;
    })
    .then(
      (binding) => {
        if (disposed) {
          binding.dispose();
          return;
        }
        network = binding;
        deps.port.start({ active: false, online: bufferedOnline ?? binding.initialOnline });
        started = true;
        bufferedOnline = null;
        try {
          bindLifecycle(true);
        } catch (error) {
          activationRequest += 1;
          deps.onError?.(error);
          binding.dispose();
          network = null;
          deps.port.stop();
          started = false;
        }
      },
      (error: unknown) => {
        if (disposed) return;
        deps.onError?.(error);
        // Sensor setup failure must remain observable, but it must not disable local-first
        // sync permanently. Preserve the scheduler's existing request/backoff fallback.
        deps.port.start({ active: false, online: bufferedOnline ?? true });
        started = true;
        bufferedOnline = null;
        try {
          bindLifecycle(false);
        } catch (lifecycleError) {
          deps.onError?.(lifecycleError);
          deps.port.stop();
          started = false;
        }
      },
    );

  return () => {
    if (disposed) return;
    disposed = true;
    activationRequest += 1;
    try {
      unbindLifecycle();
    } finally {
      try {
        network?.dispose();
      } finally {
        if (started) deps.port.stop();
      }
    }
  };
}
