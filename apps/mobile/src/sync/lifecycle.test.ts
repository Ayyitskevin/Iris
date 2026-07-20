import { describe, expect, it } from 'vitest';
import type { AppStateStatus } from 'react-native';
import { bindAppLifecycle, type AppLifecycleSource } from './lifecycle';

class FakeLifecycle implements AppLifecycleSource {
  currentState: AppStateStatus = 'unknown';
  isAvailable = true;
  listener: ((state: AppStateStatus) => void) | null = null;
  removed = false;

  addEventListener(_type: 'change', listener: (state: AppStateStatus) => void) {
    this.listener = listener;
    // Model a native transition between subscription and the required initial sample.
    this.currentState = 'background';
    return { remove: () => (this.removed = true) };
  }
}

describe('app lifecycle binding', () => {
  it('subscribes before sampling and treats only active as runnable', () => {
    const source = new FakeLifecycle();
    const states: boolean[] = [];
    const unbind = bindAppLifecycle(source, (active) => states.push(active));

    expect(states).toEqual([false]);
    source.listener?.('inactive');
    source.listener?.('active');
    expect(states).toEqual([false, false, true]);

    unbind();
    expect(source.removed).toBe(true);
  });

  it('preserves foreground behavior when AppState is unavailable', () => {
    const states: boolean[] = [];
    bindAppLifecycle(
      {
        currentState: 'background',
        isAvailable: false,
        addEventListener: () => {
          throw new Error('Unavailable AppState must not be subscribed');
        },
      },
      (active) => states.push(active),
    );
    expect(states).toEqual([true]);
  });
});
