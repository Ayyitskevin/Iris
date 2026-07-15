import { Stack } from 'expo-router';
import { theme } from '../../../src/theme';

export default function NotesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Notes' }} />
      <Stack.Screen name="[id]" options={{ title: 'Note' }} />
    </Stack>
  );
}
