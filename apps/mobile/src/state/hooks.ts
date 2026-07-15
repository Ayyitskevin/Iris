/**
 * React binding for the Legend-State store. We deliberately go through the core
 * `observe` primitive + `useSyncExternalStore` rather than depend on a specific version
 * of Legend-State's React hooks, so a library upgrade can't strand the UI (ADR-005).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { observe } from '@legendapp/state';

export function useObs<T>(selector: () => T): T {
  const subscribe = useCallback((onChange: () => void) => {
    // `observe` re-runs when any observable read inside `selector` changes.
    const dispose = observe(() => {
      selector();
      onChange();
    });
    return dispose;
  }, [selector]);
  return useSyncExternalStore(subscribe, selector, selector);
}
