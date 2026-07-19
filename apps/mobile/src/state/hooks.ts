/**
 * React binding for the Legend-State store. We deliberately go through the core
 * `observe` primitive + `useSyncExternalStore` rather than depend on a specific version
 * of Legend-State's React hooks, so a library upgrade can't strand the UI (ADR-005).
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { observe } from '@legendapp/state';

export function useObs<T>(selector: () => T): T {
  // React requires getSnapshot to return the same reference until the external store emits.
  // Several legitimate selectors build arrays/objects, so calling them directly from
  // getSnapshot causes React 19's maximum-update loop. Cache the render snapshot and replace it
  // only when Legend-State reports that one of the selector's observed dependencies changed.
  const cache = useRef<{ selector: () => T; value: T } | null>(null);
  if (!cache.current || cache.current.selector !== selector) {
    cache.current = { selector, value: selector() };
  }

  const subscribe = useCallback(
    (onChange: () => void) => {
      let trackingEstablished = false;
      // `observe` re-runs when any observable read inside `selector` changes.
      const dispose = observe(() => {
        const next = selector();
        if (!trackingEstablished) {
          // The first run establishes dependencies. Keep the exact snapshot React already read.
          trackingEstablished = true;
          return;
        }
        if (cache.current?.selector !== selector) return;
        cache.current = { selector, value: next };
        onChange();
      });
      return dispose;
    },
    [selector],
  );
  const getSnapshot = useCallback(() => cache.current!.value, [selector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
