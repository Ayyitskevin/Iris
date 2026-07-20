import { Redirect } from 'expo-router';
import { useObs } from '../src/state/hooks';
import { store$ } from '../src/state/store';

export default function Index() {
  const signedIn = useObs(() => store$.session.get() !== null);
  const recoveryRequired = useObs(() => store$.status.get() === 'recovery-required');
  return <Redirect href={!signedIn ? '/sign-in' : recoveryRequired ? '/recovery' : '/notes'} />;
}
