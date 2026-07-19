import { describe, expect, it, vi } from 'vitest';
import {
  AlwaysWritableOwnerAuthorityDriver,
  parseOwnerAuthorityRefreshNotice,
  WebOwnerAuthorityDriver,
  type BroadcastChannelPort,
  type OwnerAuthorityHooks,
  type OwnerAuthorityRole,
  type OwnerLockPort,
} from './owner-replica-authority';

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

class FakeLockManager implements OwnerLockPort {
  private readonly held = new Set<string>();
  private readonly queues = new Map<
    string,
    Array<{
      callback: (lock: object | null) => Promise<void> | void;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      signal?: AbortSignal;
    }>
  >();

  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: object | null) => Promise<void> | void,
  ): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (options.ifAvailable && this.held.has(name)) {
      return Promise.resolve(callback(null));
    }
    return new Promise((resolve, reject) => {
      const request = { callback, resolve, reject, signal: options.signal };
      if (!this.held.has(name)) this.acquire(name, request);
      else {
        const queue = this.queues.get(name) ?? [];
        queue.push(request);
        this.queues.set(name, queue);
        options.signal?.addEventListener(
          'abort',
          () => {
            const current = this.queues.get(name);
            if (!current) return;
            const index = current.indexOf(request);
            if (index < 0) return;
            current.splice(index, 1);
            reject(abortError());
          },
          { once: true },
        );
      }
    });
  }

  private acquire(
    name: string,
    request: {
      callback: (lock: object | null) => Promise<void> | void;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      signal?: AbortSignal;
    },
  ): void {
    if (request.signal?.aborted) {
      request.reject(abortError());
      this.drain(name);
      return;
    }
    this.held.add(name);
    void Promise.resolve(request.callback(Object.freeze({ name }))).then(
      (value) => {
        request.resolve(value);
        this.held.delete(name);
        this.drain(name);
      },
      (error) => {
        request.reject(error);
        this.held.delete(name);
        this.drain(name);
      },
    );
  }

  private drain(name: string): void {
    const next = this.queues.get(name)?.shift();
    if (next) queueMicrotask(() => this.acquire(name, next));
  }
}

class FakeChannelHub {
  readonly messages: unknown[] = [];
  failPosts = false;
  private readonly channels = new Map<string, Set<FakeChannel>>();

  create = (name: string): BroadcastChannelPort => {
    const channel = new FakeChannel(name, this);
    const set = this.channels.get(name) ?? new Set<FakeChannel>();
    set.add(channel);
    this.channels.set(name, set);
    return channel;
  };

  post(source: FakeChannel, value: unknown): void {
    if (this.failPosts) throw new Error('channel failed');
    this.messages.push(value);
    for (const target of this.channels.get(source.name) ?? []) {
      if (target === source) continue;
      queueMicrotask(() => target.onmessage?.({ data: value }));
    }
  }

  close(channel: FakeChannel): void {
    this.channels.get(channel.name)?.delete(channel);
  }
}

class FakeChannel implements BroadcastChannelPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(
    readonly name: string,
    private readonly hub: FakeChannelHub,
  ) {}

  postMessage(message: unknown): void {
    this.hub.post(this, message);
  }

  close(): void {
    this.hub.close(this);
  }
}

function hooks(options?: { prepare?: () => Promise<void>; refreshed?: () => void }): {
  hooks: OwnerAuthorityHooks;
  roles: OwnerAuthorityRole[];
} {
  const roles: OwnerAuthorityRole[] = [];
  return {
    roles,
    hooks: {
      prepareLeader: async () => options?.prepare?.(),
      onRole: (snapshot) => roles.push(snapshot.role),
      onRefresh: () => options?.refreshed?.(),
    },
  };
}

describe('WebOwnerAuthorityDriver', () => {
  it('grants exactly one leader per owner while different owners remain independent', async () => {
    const locks = new FakeLockManager();
    const hub = new FakeChannelHub();
    const driver = new WebOwnerAuthorityDriver({ locks, createChannel: hub.create });
    const a1 = hooks();
    const a2 = hooks();
    const b = hooks();

    const first = await driver.start('owner-a', a1.hooks);
    const second = await driver.start('owner-a', a2.hooks);
    const other = await driver.start('owner-b', b.hooks);

    expect([first.snapshot().role, second.snapshot().role].sort()).toEqual(['follower', 'leader']);
    expect(other.snapshot().role).toBe('leader');
    await Promise.all([first.close(), second.close(), other.close()]);
  });

  it('does not expose transferred leadership until the follower preparation read completes', async () => {
    const locks = new FakeLockManager();
    const hub = new FakeChannelHub();
    const driver = new WebOwnerAuthorityDriver({ locks, createChannel: hub.create });
    const leaderHooks = hooks();
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let prepares = 0;
    const followerHooks = hooks({
      prepare: async () => {
        prepares += 1;
        await preparation;
      },
    });
    const leader = await driver.start('owner-a', leaderHooks.hooks);
    const follower = await driver.start('owner-a', followerHooks.hooks);

    const closing = leader.close();
    await vi.waitFor(() => expect(followerHooks.roles.at(-1)).toBe('acquiring'));
    expect(follower.snapshot().role).toBe('acquiring');
    expect(prepares).toBe(1);
    releasePreparation();
    await vi.waitFor(() => expect(follower.snapshot().role).toBe('leader'));
    await closing;
    expect(followerHooks.roles.filter((role) => role === 'leader')).toHaveLength(1);
    await follower.close();
  });

  it('publishes only the exact metadata notice and followers ignore widened payloads', async () => {
    const locks = new FakeLockManager();
    const hub = new FakeChannelHub();
    const driver = new WebOwnerAuthorityDriver({ locks, createChannel: hub.create });
    let refreshes = 0;
    const leader = await driver.start('owner-a', hooks().hooks);
    const follower = await driver.start(
      'owner-a',
      hooks({ refreshed: () => (refreshes += 1) }).hooks,
    );

    leader.publishRefresh();
    await vi.waitFor(() => expect(refreshes).toBe(1));
    expect(hub.messages).toEqual([{ version: 1, type: 'replica-changed' }]);
    expect(Object.keys(hub.messages[0] as object).sort()).toEqual(['type', 'version']);
    expect(JSON.stringify(hub.messages)).not.toContain('secret-device-note-body');

    const attacker = hub.create('iris.owner-authority.v1.channel.owner-a');
    attacker.postMessage({ version: 1, type: 'replica-changed', token: 'secret' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshes).toBe(1);
    attacker.close();
    await Promise.all([leader.close(), follower.close()]);
  });

  it('ignores callbacks after close and releases queued acquisition', async () => {
    const locks = new FakeLockManager();
    const hub = new FakeChannelHub();
    const driver = new WebOwnerAuthorityDriver({ locks, createChannel: hub.create });
    const firstHooks = hooks();
    const secondHooks = hooks();
    const first = await driver.start('owner-a', firstHooks.hooks);
    const second = await driver.start('owner-a', secondHooks.hooks);
    const rolesBeforeClose = [...secondHooks.roles];

    await second.close();
    first.publishRefresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondHooks.roles).toEqual(rolesBeforeClose);
    await first.close();
  });

  it('fails closed and releases the owner lock when refresh publication fails', async () => {
    const locks = new FakeLockManager();
    const hub = new FakeChannelHub();
    const driver = new WebOwnerAuthorityDriver({ locks, createChannel: hub.create });
    const leader = await driver.start('owner-a', hooks().hooks);
    const follower = await driver.start('owner-a', hooks().hooks);

    hub.failPosts = true;
    expect(() => leader.publishRefresh()).toThrow('Owner refresh notice could not be published');
    expect(leader.snapshot().role).toBe('unavailable');
    await vi.waitFor(() => expect(follower.snapshot().role).toBe('leader'));

    await Promise.all([leader.close(), follower.close()]);
  });
});

describe('authority notice parser and local authority', () => {
  it('accepts only the exact allowlisted shape', () => {
    expect(parseOwnerAuthorityRefreshNotice({ version: 1, type: 'replica-changed' })).toEqual({
      version: 1,
      type: 'replica-changed',
    });
    for (const value of [
      null,
      [],
      { version: 2, type: 'replica-changed' },
      { version: 1, type: 'replica-changed', ownerKey: 'owner-a' },
      { version: 1, type: 'replica-changed', note: 'private' },
    ]) {
      expect(parseOwnerAuthorityRefreshNotice(value)).toBeNull();
    }
  });

  it('keeps legacy/native authority local without opening browser primitives', async () => {
    const observed = hooks();
    const handle = await new AlwaysWritableOwnerAuthorityDriver().start('owner-a', observed.hooks);
    expect(handle.snapshot().role).toBe('leader');
    expect(observed.roles).toEqual(['acquiring', 'leader']);
    handle.publishRefresh();
    await handle.close();
  });
});
