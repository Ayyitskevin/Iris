import { Stack } from 'expo-router';
import { theme } from '../../src/theme';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg } }}
    />
  );
}
