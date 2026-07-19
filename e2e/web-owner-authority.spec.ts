import { expect, test, type Page } from '@playwright/test';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const ownerKey = `${workspaceId}.${userId}`;
const initialNoteId = '33333333-3333-4333-8333-333333333333';
const privateSentinel = 'browser-private-note-body';
const takeoverRereadSentinel = 'takeover-reread-only';
const newLeaderWriteSentinel = 'new-leader-durable-write';

const session = {
  token: 'browser-private-token',
  userId,
  workspaceId,
  email: 'browser-private@example.com',
  displayName: 'Browser Operator',
};

const initialReplica = {
  version: 2,
  ownerKey,
  userId,
  workspaceId,
  notes: {
    [initialNoteId]: {
      id: initialNoteId,
      workspaceId,
      title: 'Initial local note',
      bodyMd: 'Initial local body',
      folder: null,
      tags: ['local'],
      version: 1,
      createdAt: '2026-07-19T12:00:00.000Z',
      updatedAt: '2026-07-19T12:00:00.000Z',
      deletedAt: null,
    },
  },
  syncCursor: '',
  deviceId: 'browser-private-device',
  outbox: [],
  pendingPush: null,
  syncIssue: null,
  conflicts: {},
};

type InstrumentedWindow = Window & {
  __irisAuthorityMessages: unknown[];
  __irisFetches: string[];
};

interface BrowserReplicaRecord {
  readonly revision: number;
  readonly serializedReplica: string;
}

interface BrowserReplicaNote {
  readonly title: string;
  readonly bodyMd: string;
  readonly updatedAt: string;
  readonly [key: string]: unknown;
}

interface BrowserReplica {
  readonly notes: Record<string, BrowserReplicaNote>;
  readonly [key: string]: unknown;
}

async function indexedDbRecord(page: Page): Promise<BrowserReplicaRecord> {
  return page.evaluate(
    ({ databaseName, storeName, key }) =>
      new Promise<BrowserReplicaRecord>((resolve, reject) => {
        const open = indexedDB.open(databaseName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction(storeName, 'readonly');
          const request = transaction.objectStore(storeName).get(key);
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => {
            const value = request.result as BrowserReplicaRecord | undefined;
            if (!value) {
              reject(new Error('Owner replica record is missing'));
              return;
            }
            resolve({ revision: value.revision, serializedReplica: value.serializedReplica });
            database.close();
          };
        };
      }),
    { databaseName: 'iris-owner-replicas', storeName: 'owner_replicas', key: ownerKey },
  );
}

/** Simulate a verified primary commit whose post-commit refresh notice was lost with the leader. */
async function writeUnannouncedPrimaryRevision(page: Page): Promise<BrowserReplicaRecord> {
  return page.evaluate(
    ({ databaseName, storeName, key, noteId, title }) =>
      new Promise<BrowserReplicaRecord>((resolve, reject) => {
        const open = indexedDB.open(databaseName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          const request = store.get(key);
          let replacement: BrowserReplicaRecord | null = null;
          request.onsuccess = () => {
            const record = request.result as BrowserReplicaRecord & {
              schemaVersion: number;
              ownerKey: string;
            };
            const replica = JSON.parse(record.serializedReplica) as BrowserReplica;
            const current = replica.notes[noteId];
            if (!current) {
              transaction.abort();
              return;
            }
            const serializedReplica = JSON.stringify({
              ...replica,
              notes: {
                ...replica.notes,
                [noteId]: {
                  ...current,
                  title,
                  bodyMd: title + '-body',
                  updatedAt: '2026-07-19T12:01:00.000Z',
                },
              },
            });
            replacement = {
              ...record,
              revision: record.revision + 1,
              serializedReplica,
            };
            store.put(replacement);
          };
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error ?? new Error('Write aborted'));
          transaction.oncomplete = () => {
            database.close();
            if (!replacement) {
              reject(new Error('Owner replica replacement was not written'));
              return;
            }
            resolve(replacement);
          };
        };
      }),
    {
      databaseName: 'iris-owner-replicas',
      storeName: 'owner_replicas',
      key: ownerKey,
      noteId: initialNoteId,
      title: takeoverRereadSentinel,
    },
  );
}

function serializedReplicaContainsTitle(record: BrowserReplicaRecord, title: string): boolean {
  const replica = JSON.parse(record.serializedReplica) as BrowserReplica;
  return Object.values(replica.notes).some((note) => note.title === title);
}

test('one tab writes while its follower refreshes, then takes over after a verified reread', async ({
  context,
}) => {
  await context.addInitScript(
    ({ sessionValue, replicaValue, storageOwnerKey }) => {
      const target = window as InstrumentedWindow;
      target.__irisAuthorityMessages = [];
      target.__irisFetches = [];
      localStorage.setItem('iris.session.v2', JSON.stringify(sessionValue));
      localStorage.setItem('iris.replica.v2.' + storageOwnerKey, JSON.stringify(replicaValue));

      const NativeChannel = window.BroadcastChannel;
      class CapturingBroadcastChannel extends NativeChannel {
        override postMessage(message: unknown): void {
          target.__irisAuthorityMessages.push(message);
          super.postMessage(message);
        }
      }
      Object.defineProperty(window, 'BroadcastChannel', {
        configurable: true,
        value: CapturingBroadcastChannel,
      });

      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        target.__irisFetches.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return nativeFetch(input, init);
      };
    },
    { sessionValue: session, replicaValue: initialReplica, storageOwnerKey: ownerKey },
  );

  const leader = await context.newPage();
  await leader.goto('/');
  await expect(leader.getByText('Initial local note')).toBeVisible();
  await expect(leader.getByTestId('replica-authority-notice')).toHaveCount(0);

  const follower = await context.newPage();
  await follower.goto('/');
  await expect(follower.getByText('Initial local note')).toBeVisible();
  await expect(follower.getByTestId('replica-authority-notice')).toContainText(
    'View only in this tab',
  );
  const followerNew = follower.getByRole('button', { name: /New note/ });
  await expect(followerNew).toBeDisabled();
  expect(await follower.evaluate(() => (window as InstrumentedWindow).__irisFetches)).toEqual([]);

  // Signed-in tabs cannot reach the public account-creation mutation surface by direct URL.
  await follower.goto('/sign-up');
  await expect(follower).toHaveURL(/\/notes$/);
  await expect(follower.getByTestId('replica-authority-notice')).toContainText(
    'View only in this tab',
  );
  await expect(follower.getByRole('button', { name: 'Create account' })).toHaveCount(0);
  expect(await follower.evaluate(() => (window as InstrumentedWindow).__irisFetches)).toEqual([]);

  await leader.getByRole('button', { name: /New note/ }).click();
  const title = leader.getByPlaceholder('Title');
  await expect(title).toBeVisible();
  await title.fill(privateSentinel);
  await expect(follower.getByText(privateSentinel)).toBeVisible();

  const recordBeforeFollowerAttempt = await indexedDbRecord(follower);
  await followerNew.evaluate((button: HTMLElement) => button.click());
  await follower.waitForTimeout(250);
  expect(await indexedDbRecord(follower)).toEqual(recordBeforeFollowerAttempt);
  expect(await follower.evaluate(() => (window as InstrumentedWindow).__irisFetches)).toEqual([]);

  // Exercise the actual 8 s app sync interval while the tab is a follower.
  await follower.waitForTimeout(8_250);
  expect(await follower.evaluate(() => (window as InstrumentedWindow).__irisFetches)).toEqual([]);

  const leaderMessages = await leader.evaluate(
    () => (window as InstrumentedWindow).__irisAuthorityMessages,
  );
  expect(leaderMessages.length).toBeGreaterThan(0);
  for (const message of leaderMessages) {
    expect(message).toEqual({ version: 1, type: 'replica-changed' });
    expect(Object.keys(message as object).sort()).toEqual(['type', 'version']);
    expect(JSON.stringify(message)).not.toContain(privateSentinel);
    expect(JSON.stringify(message)).not.toContain(session.token);
    expect(JSON.stringify(message)).not.toContain(initialReplica.deviceId);
  }

  // Change the durable root without a channel notice. Only the mandatory takeover reread can
  // reveal this value in the follower projection.
  const unannouncedRecord = await writeUnannouncedPrimaryRevision(leader);
  await expect(follower.getByText(takeoverRereadSentinel, { exact: true })).toHaveCount(0);

  await leader.close();
  await expect(follower.getByTestId('replica-authority-notice')).toHaveCount(0);
  await expect(follower.getByTestId('replica-authority-status')).toHaveText(
    'This tab is active. Editing and sync are available.',
  );
  await expect(follower.getByText(takeoverRereadSentinel, { exact: true })).toBeVisible();
  await expect(followerNew).toBeEnabled();
  await expect(follower.getByText(/pending/)).toBeVisible();
  const requestsAfterTakeover = await follower.evaluate(
    () => (window as InstrumentedWindow).__irisFetches,
  );
  expect(requestsAfterTakeover.length).toBeLessThanOrEqual(1);
  await followerNew.click();
  const newLeaderTitle = follower.getByPlaceholder('Title');
  await expect(newLeaderTitle).toBeVisible();
  await newLeaderTitle.fill(newLeaderWriteSentinel);
  await expect
    .poll(async () =>
      serializedReplicaContainsTitle(await indexedDbRecord(follower), newLeaderWriteSentinel),
    )
    .toBe(true);
  const recordAfterNewLeaderWrite = await indexedDbRecord(follower);
  expect(recordAfterNewLeaderWrite.revision).toBeGreaterThan(unannouncedRecord.revision);
  expect(serializedReplicaContainsTitle(recordAfterNewLeaderWrite, takeoverRereadSentinel)).toBe(
    true,
  );
});
