import { Redirect } from 'expo-router';
import { useObs } from '../src/state/hooks';
import { store$ } from '../src/state/store';

export default function Index() {
  const signedIn = useObs(() => store$.session.get() !== null);
  return <Redirect href={signedIn ? '/notes' : '/sign-in'} />;
}
