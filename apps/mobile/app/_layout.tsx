import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { purgeStaleReplicaRecoveryExports } from '../src/recovery/export-sink';
import { useObs } from '../src/state/hooks';
import {
  loadState,
  replicaMutationsBlocked,
  retryPendingSessionPersistence,
  selectReplicaAuthorityState,
  store$,
} from '../src/state/store';
import { sync } from '../src/sync/manager';
import { theme } from '../src/theme';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const replicaAuthority = useObs(selectReplicaAuthorityState);

  // Hydrate local state before rendering routes — the app must open instantly, offline.
  useEffect(() => {
    void loadState().then(() => setReady(true));
    void purgeStaleReplicaRecoveryExports().catch((error: unknown) => {
      console.warn('Could not clean stale recovery export cache files', error);
    });
  }, []);

  // Background sync loop while signed in.
  useEffect(() => {
    if (!ready) return;
    void retryPendingSessionPersistence();
    if (!replicaMutationsBlocked()) void sync();
    const id = setInterval(() => {
      void retryPendingSessionPersistence();
      if (store$.session.get() && !replicaMutationsBlocked()) void sync();
    }, 8000);
    return () => clearInterval(id);
  }, [ready, replicaAuthority]);

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
