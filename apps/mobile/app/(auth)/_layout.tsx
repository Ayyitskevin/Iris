import { Redirect, Stack } from 'expo-router';
import { useObs } from '../../src/state/hooks';
import { store$ } from '../../src/state/store';
import { theme } from '../../src/theme';

export default function AuthLayout() {
  const signedInOwner = useObs(() =>
    store$.session.get() && store$.activeOwnerKey.get() ? store$.activeOwnerKey.get() : null,
  );
  if (signedInOwner) return <Redirect href="/notes" />;

  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg } }}
    />
  );
}
