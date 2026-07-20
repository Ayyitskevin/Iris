import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = {
  readonly isConnected: boolean | null;
  readonly isInternetReachable: boolean | null;
};

const netInfo = vi.hoisted(() => ({
  listener: null as ((state: MockState) => void) | null,
  unsubscribe: vi.fn(),
  addEventListener: vi.fn((listener: (state: MockState) => void) => {
    netInfo.listener = listener;
    return netInfo.unsubscribe;
  }),
  fetch: vi.fn<() => Promise<MockState>>(),
  refresh: vi.fn<() => Promise<MockState>>(),
}));

vi.mock('@react-native-community/netinfo', () => ({ default: netInfo }));

import { bindNetworkConnectivity } from './connectivity.native';

describe('native connectivity adapter', () => {
  beforeEach(() => {
    netInfo.listener = null;
    netInfo.unsubscribe.mockReset();
    netInfo.addEventListener.mockClear();
    netInfo.fetch.mockReset();
    netInfo.refresh.mockReset();
  });

  it('subscribes before the initial fetch, force-refreshes on foreground, and cleans up', async () => {
    const order: string[] = [];
    netInfo.addEventListener.mockImplementation((listener) => {
      order.push('subscribe');
      netInfo.listener = listener;
      return netInfo.unsubscribe;
    });
    netInfo.fetch.mockImplementation(async () => {
      order.push('fetch');
      return { isConnected: false, isInternetReachable: false };
    });
    netInfo.refresh.mockResolvedValue({ isConnected: true, isInternetReachable: true });
    const onOnline = vi.fn();

    const binding = await bindNetworkConnectivity(onOnline);
    expect(order).toEqual(['subscribe', 'fetch']);
    expect(binding.initialOnline).toBe(false);

    netInfo.listener!({ isConnected: false, isInternetReachable: true });
    expect(onOnline).toHaveBeenLastCalledWith(false);

    await expect(binding.refresh()).resolves.toBe(true);
    expect(netInfo.refresh).toHaveBeenCalledTimes(1);
    expect(netInfo.fetch).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenLastCalledWith(true);

    binding.dispose();
    binding.dispose();
    expect(netInfo.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
