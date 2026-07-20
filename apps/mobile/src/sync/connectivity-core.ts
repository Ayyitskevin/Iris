export interface ConnectivityState {
  readonly isConnected: boolean | null;
  readonly isInternetReachable: boolean | null;
}

export interface ConnectivitySource {
  subscribe(listener: (state: ConnectivityState) => void): () => void;
  sample(): Promise<ConnectivityState>;
  refresh?(): Promise<ConnectivityState>;
}

export type ConnectivityErrorPhase = 'subscribe' | 'initial-sample' | 'refresh';

export interface NetworkConnectivityBinding {
  readonly initialOnline: boolean;
  refresh(): Promise<boolean | null>;
  dispose(): void;
}

interface ConnectivityBindingOptions {
  readonly fallbackOnline?: boolean;
  readonly onError?: (phase: ConnectivityErrorPhase, error: unknown) => void;
}

/**
 * Connectivity is an eligibility hint, not proof that Iris can reach its API.
 * A definite negative wins over a contradictory positive; unknown state leaves
 * the scheduler's last known eligibility unchanged.
 */
export function classifyConnectivity(state: ConnectivityState): boolean | null {
  if (state.isConnected === false || state.isInternetReachable === false) return false;
  if (state.isInternetReachable === true || state.isConnected === true) return true;
  return null;
}

/**
 * Subscribe before sampling so a transition that occurs during the initial read
 * cannot be overwritten by a stale sample. If the platform sensor is unavailable,
 * fall back explicitly to normal network probing; transport failures still enter
 * the scheduler's bounded backoff instead of disabling sync forever.
 */
export async function bindConnectivitySource(
  source: ConnectivitySource,
  onOnline: (online: boolean) => void,
  options: ConnectivityBindingOptions = {},
): Promise<NetworkConnectivityBinding> {
  const fallbackOnline = options.fallbackOnline ?? true;
  let disposed = false;
  let ready = false;
  let eventRevision = 0;
  let refreshRevision = 0;
  let latestKnown: boolean | null = null;
  let unsubscribe: () => void = () => undefined;

  const record = (state: ConnectivityState, event: boolean): boolean | null => {
    if (event) eventRevision += 1;
    const next = classifyConnectivity(state);
    if (next === null) return null;
    latestKnown = next;
    if (ready && !disposed) onOnline(next);
    return next;
  };

  try {
    unsubscribe = source.subscribe((state) => {
      if (!disposed) record(state, true);
    });
  } catch (error) {
    options.onError?.('subscribe', error);
  }

  const revisionBeforeSample = eventRevision;
  try {
    const sampled = await source.sample();
    if (!disposed && eventRevision === revisionBeforeSample) record(sampled, false);
  } catch (error) {
    options.onError?.('initial-sample', error);
  }

  const initialOnline = latestKnown ?? fallbackOnline;
  ready = true;

  return {
    initialOnline,
    async refresh() {
      if (disposed) return null;
      const requestRevision = ++refreshRevision;
      const revisionBeforeRefresh = eventRevision;
      try {
        const sampled = await (source.refresh ?? source.sample)();
        if (disposed) return null;
        if (requestRevision !== refreshRevision || eventRevision !== revisionBeforeRefresh) {
          return latestKnown;
        }
        return record(sampled, false);
      } catch (error) {
        if (!disposed) options.onError?.('refresh', error);
        return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
