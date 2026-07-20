import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { purgeStaleReplicaRecoveryExports } from '../src/recovery/export-sink';
import { useObs } from '../src/state/hooks';
import {
  loadState,
  retryPendingSessionPersistence,
  selectReplicaAuthorityState,
  store$,
} from '../src/state/store';
import { bindAppLifecycle } from '../src/sync/lifecycle';
import {
  notifySyncContextChanged,
  setSyncLifecycleActive,
  setSyncNetworkOnline,
  startSyncScheduling,
  stopSyncScheduling,
} from '../src/sync/manager';
import { theme } from '../src/theme';

const REJECTED_SESSION_RETRY_MS = 8_000;

interface BrowserNetworkTarget {
  readonly navigator?: { readonly onLine?: boolean };
  addEventListener?(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener?(type: 'online' | 'offline', listener: () => void): void;
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const replicaAuthority = useObs(selectReplicaAuthorityState);
  const sessionToken = useObs(() => store$.session.get()?.token ?? null);

  // Hydrate local state before rendering routes — the app must open instantly, offline.
  useEffect(() => {
    void loadState().then(() => setReady(true));
    void purgeStaleReplicaRecoveryExports().catch((error: unknown) => {
      console.warn('Could not clean stale recovery export cache files', error);
    });
  }, []);

  // One lifecycle-owned scheduler replaces the fixed network interval. AppState also maps to
  // Page Visibility in react-native-web, so hidden tabs and backgrounded native apps pause alike.
  useEffect(() => {
    if (!ready) return;

    const networkTarget =
      Platform.OS === 'web' ? (globalThis as unknown as BrowserNetworkTarget) : null;
    const onOnline = () => setSyncNetworkOnline(true);
    const onOffline = () => setSyncNetworkOnline(false);
    networkTarget?.addEventListener?.('online', onOnline);
    networkTarget?.addEventListener?.('offline', onOffline);

    startSyncScheduling({
      active: false,
      online: networkTarget?.navigator?.onLine !== false,
    });
    const unbindLifecycle = bindAppLifecycle(AppState, setSyncLifecycleActive);

    // This is local credential-safety maintenance, not a network poll. Preserve its existing
    // liveness independently of whether any writable session lease exists.
    void retryPendingSessionPersistence();
    const persistenceRetry = setInterval(() => {
      void retryPendingSessionPersistence();
    }, REJECTED_SESSION_RETRY_MS);

    return () => {
      unbindLifecycle();
      networkTarget?.removeEventListener?.('online', onOnline);
      networkTarget?.removeEventListener?.('offline', onOffline);
      clearInterval(persistenceRetry);
      stopSyncScheduling();
    };
  }, [ready]);

  // Authority and exact credential replacement both invalidate timer ownership. The scheduler
  // rereads a credential-free generation/owner/device key before arming any new request.
  useEffect(() => {
    if (ready) notifySyncContextChanged();
  }, [ready, replicaAuthority, sessionToken]);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg } }}
      />
    </SafeAreaProvider>
  );
}
