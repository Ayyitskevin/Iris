import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import {
  bindConnectivitySource,
  type ConnectivitySource,
  type NetworkConnectivityBinding,
} from './connectivity-core';

const nativeConnectivitySource: ConnectivitySource = {
  subscribe(listener) {
    return NetInfo.addEventListener((state: NetInfoState) => {
      listener({
        isConnected: state.isConnected,
        isInternetReachable: state.isInternetReachable,
      });
    });
  },
  async sample() {
    const state = await NetInfo.fetch();
    return {
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
    };
  },
  async refresh() {
    const state = await NetInfo.refresh();
    return {
      isConnected: state.isConnected,
      isInternetReachable: state.isInternetReachable,
    };
  },
};

/** Native adapter. NetInfo is never imported into the web bundle. */
export function bindNetworkConnectivity(
  onOnline: (online: boolean) => void,
): Promise<NetworkConnectivityBinding> {
  return bindConnectivitySource(nativeConnectivitySource, onOnline, {
    fallbackOnline: true,
    onError: (phase, error) => {
      console.warn(`Native connectivity ${phase} failed; using network request outcomes`, error);
    },
  });
}
