import { describe, expect, it, vi } from 'vitest';
import {
  bindNetworkConnectivity,
  type BrowserNetworkTarget,
  type BrowserNetworkEvent,
} from './connectivity';

describe('browser connectivity adapter', () => {
  it('samples navigator state, forwards events, and removes both listeners exactly once', async () => {
    const listeners = new Map<BrowserNetworkEvent, () => void>();
    const target: BrowserNetworkTarget = {
      navigator: { onLine: false },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener: vi.fn((type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    const onOnline = vi.fn();

    const binding = await bindNetworkConnectivity(onOnline, target);
    expect(binding.initialOnline).toBe(false);

    target.navigator!.onLine = true;
    listeners.get('online')!();
    expect(onOnline).toHaveBeenLastCalledWith(true);

    target.navigator!.onLine = false;
    listeners.get('offline')!();
    expect(onOnline).toHaveBeenLastCalledWith(false);

    binding.dispose();
    binding.dispose();
    expect(target.removeEventListener).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });
});
