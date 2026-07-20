import {
  bindConnectivitySource,
  type ConnectivitySource,
  type NetworkConnectivityBinding,
} from './connectivity-core';

export type BrowserNetworkEvent = 'online' | 'offline';

export interface BrowserNetworkTarget {
  readonly navigator?: { onLine?: boolean };
  addEventListener?(type: BrowserNetworkEvent, listener: () => void): void;
  removeEventListener?(type: BrowserNetworkEvent, listener: () => void): void;
}

function browserConnectivitySource(target: BrowserNetworkTarget): ConnectivitySource {
  return {
    subscribe(listener) {
      const online = () => listener({ isConnected: true, isInternetReachable: null });
      const offline = () => listener({ isConnected: false, isInternetReachable: false });
      target.addEventListener?.('online', online);
      target.addEventListener?.('offline', offline);
      return () => {
        target.removeEventListener?.('online', online);
        target.removeEventListener?.('offline', offline);
      };
    },
    async sample() {
      const online = target.navigator?.onLine;
      return {
        isConnected: typeof online === 'boolean' ? online : null,
        isInternetReachable: null,
      };
    },
  };
}

/** Web/Node adapter. Metro resolves connectivity.native.ts for iOS and Android. */
export function bindNetworkConnectivity(
  onOnline: (online: boolean) => void,
  target: BrowserNetworkTarget = globalThis as unknown as BrowserNetworkTarget,
): Promise<NetworkConnectivityBinding> {
  return bindConnectivitySource(browserConnectivitySource(target), onOnline, {
    fallbackOnline: true,
    onError: (phase, error) => {
      console.warn(`Browser connectivity ${phase} failed; using network request outcomes`, error);
    },
  });
}
