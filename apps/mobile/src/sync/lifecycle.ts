import type { AppStateStatus } from 'react-native';

interface AppStateSubscription {
  remove(): void;
}

export interface AppLifecycleSource {
  readonly currentState: AppStateStatus;
  readonly isAvailable: boolean;
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): AppStateSubscription | undefined;
}

/** Subscribe before sampling so an initial native `unknown` transition cannot be missed. */
export function bindAppLifecycle(
  source: AppLifecycleSource,
  onActiveChange: (active: boolean) => void,
): () => void {
  if (source.isAvailable === false) {
    onActiveChange(true);
    return () => undefined;
  }
  const report = (state: AppStateStatus) => onActiveChange(state === 'active');
  const subscription = source.addEventListener('change', report);
  onActiveChange(source.currentState === 'active');
  return () => subscription?.remove();
}
