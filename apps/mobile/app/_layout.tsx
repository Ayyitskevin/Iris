import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
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
import { bindNetworkConnectivity } from '../src/sync/connectivity';
import {
  notifySyncContextChanged,
  setSyncLifecycleActive,
  setSyncNetworkOnline,
  startSyncScheduling,
  stopSyncScheduling,
} from '../src/sync/manager';
import { bindSyncRuntime } from '../src/sync/runtime';
import { theme } from '../src/theme';

const REJECTED_SESSION_RETRY_MS = 8_000;

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

  // One runtime binding samples connectivity before AppState can activate the scheduler.
  // Native NetInfo is refreshed on every foreground transition because iOS may miss network
  // changes while backgrounded; web retains Page Visibility plus online/offline events.
  useEffect(() => {
    if (!ready) return;

    const unbindSyncRuntime = bindSyncRuntime({
      bindConnectivity: bindNetworkConnectivity,
      bindLifecycle: (listener) => bindAppLifecycle(AppState, listener),
      port: {
        start: startSyncScheduling,
        stop: stopSyncScheduling,
        setActive: setSyncLifecycleActive,
        setOnline: setSyncNetworkOnline,
      },
      onError: (error) => {
        console.warn('Could not bind the sync runtime; using request-level retry signals', error);
      },
    });

    // This is local credential-safety maintenance, not a network poll. Preserve its existing
    // liveness independently of whether any writable session lease exists.
    void retryPendingSessionPersistence();
    const persistenceRetry = setInterval(() => {
      void retryPendingSessionPersistence();
    }, REJECTED_SESSION_RETRY_MS);

    return () => {
      clearInterval(persistenceRetry);
      unbindSyncRuntime();
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
