import { Text } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { useObs } from '../../src/state/hooks';
import { store$ } from '../../src/state/store';
import { theme } from '../../src/theme';

export default function AppLayout() {
  const signedIn = useObs(() => store$.session.get() !== null);
  if (!signedIn) return <Redirect href="/sign-in" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textDim,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
      }}
    >
      <Tabs.Screen
        name="notes"
        options={{ title: 'Notes', tabBarIcon: ({ color }) => <Text style={{ color }}>✎</Text> }}
      />
      <Tabs.Screen
        name="activity"
        options={{ title: 'Activity', tabBarIcon: ({ color }) => <Text style={{ color }}>◉</Text> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: ({ color }) => <Text style={{ color }}>⚙</Text> }}
      />
    </Tabs>
  );
}
