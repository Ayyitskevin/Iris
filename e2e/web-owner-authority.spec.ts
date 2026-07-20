import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const ownerKey = `${workspaceId}.${userId}`;
const initialNoteId = '33333333-3333-4333-8333-333333333333';
const privateSentinel = 'browser-private-note-body';
const takeoverRereadSentinel = 'takeover-reread-only';
const newLeaderWriteSentinel = 'new-leader-durable-write';
const mixedVersionPrimarySentinel = 'current-runtime-primary-branch';
const legacyDivergenceTitleSentinel = 'frozen-old-runtime-legacy-branch';
const legacyDivergenceBodySentinel = 'frozen-old-runtime-private-body';
const legacyDivergenceDeviceSentinel = 'frozen-old-runtime-private-device';
const databaseName = 'iris-owner-replicas';
const storeName = 'owner_replicas';
const legacyStorageKey = `iris.replica.v2.${ownerKey}`;
const seedMarkerKey = `iris.e2e.owner-authority.seeded.v1.${ownerKey}`;
const divergenceOwnerKey = `iris.replica-divergence.v1.${encodeURIComponent(ownerKey)}`;
const recoveryOwnerKey = `iris.recovery-journal.v1.${encodeURIComponent(ownerKey)}`;
const replicaDigestDomain = 'iris.owner-replica.v2.exact-bytes';

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

const legacyDivergedReplica = {
  ...initialReplica,
  deviceId: legacyDivergenceDeviceSentinel,
  notes: {
    ...initialReplica.notes,
    [initialNoteId]: {
      ...initialReplica.notes[initialNoteId],
      title: legacyDivergenceTitleSentinel,
      bodyMd: legacyDivergenceBodySentinel,
      version: 2,
      updatedAt: '2026-07-19T12:02:00.000Z',
    },
  },
};

const legacyDivergedRaw = JSON.stringify(legacyDivergedReplica);

type InstrumentedWindow = Window & {
  __irisAuthorityMessages: unknown[];
  __irisFetches: string[];
};

interface BrowserReplicaRecord {
  readonly revision: number;
  readonly serializedReplica: string;
}

interface BrowserReplicaRootDigest {
  readonly kind: 'sha256';
  readonly algorithm: 'SHA-256';
  readonly domain: typeof replicaDigestDomain;
  readonly hex: string;
}

interface BrowserDivergenceEntry {
  readonly sequence: number;
  readonly observedAt: string;
  readonly state: 'preparing' | 'transactional' | 'diverged';
  readonly reason:
    | 'promotion'
    | 'commit'
    | 'adopt-existing'
    | 'resume'
    | 'checkpoint'
    | 'legacy-drift'
    | 'primary-drift';
  readonly legacyDigest: BrowserReplicaRootDigest;
  readonly primaryDigest: BrowserReplicaRootDigest;
  readonly targetPrimaryDigest: BrowserReplicaRootDigest | null;
  readonly legacyRecoverySequence: number | null;
  readonly primaryRecoverySequence: number | null;
}

interface BrowserDivergenceEnvelope {
  readonly version: 1;
  readonly ownerKey: string;
  readonly sourceOwnerKey: string;
  readonly legacyBaselineDigest: BrowserReplicaRootDigest;
  readonly entries: BrowserDivergenceEntry[];
}

interface BrowserRecoveryEnvelope {
  readonly version: 1;
  readonly ownerKey: string;
  readonly sourceOwnerKey: string;
  readonly snapshots: Array<{
    readonly sequence: number;
    readonly capturedAt: string;
    readonly reason: string;
    readonly serializedReplica: string;
  }>;
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

async function indexedDbRecord(page: Page, key: string = ownerKey): Promise<BrowserReplicaRecord> {
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
    { databaseName, storeName, key },
  );
}

async function legacyReplicaRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), legacyStorageKey);
}

async function seedAndInstrument(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ({ sessionValue, replicaValue, storageOwnerKey, markerKey }) => {
      const target = window as InstrumentedWindow;
      target.__irisAuthorityMessages = [];
      target.__irisFetches = [];

      if (localStorage.getItem(markerKey) !== '1') {
        localStorage.setItem('iris.session.v2', JSON.stringify(sessionValue));
        localStorage.setItem('iris.replica.v2.' + storageOwnerKey, JSON.stringify(replicaValue));
        localStorage.setItem(markerKey, '1');
      }

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
    {
      sessionValue: session,
      replicaValue: initialReplica,
      storageOwnerKey: ownerKey,
      markerKey: seedMarkerKey,
    },
  );
}

async function installFrozenOldWriter(context: BrowserContext): Promise<void> {
  await context.route('**/frozen-old-writer.html', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Frozen Iris writer</title></head>
  <body>
    <h1>Frozen pre-cutover writer</h1>
    <button id="write-legacy" type="button">Write legacy replica</button>
    <output id="result"></output>
    <script>
      const key = ${JSON.stringify(legacyStorageKey)};
      const raw = ${JSON.stringify(legacyDivergedRaw)};
      document.querySelector('#write-legacy').addEventListener('click', () => {
        localStorage.setItem(key, raw);
        document.querySelector('#result').textContent = 'legacy replica written';
      });
    </script>
  </body>
</html>`,
    });
  });
}

async function fetchCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as InstrumentedWindow).__irisFetches.length);
}

/** Simulate a verified primary commit whose post-commit refresh notice was lost with the leader. */
async function writeUnannouncedPrimaryRevision(page: Page): Promise<BrowserReplicaRecord> {
  return page.evaluate(
    async ({ databaseName, storeName, key, journalKey, noteId, title, digestDomain }) => {
      interface StoredRecord extends BrowserReplicaRecord {
        readonly schemaVersion: number;
        readonly ownerKey: string;
      }

      const open = indexedDB.open(databaseName);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
      });
      const existing = await new Promise<{
        primary: StoredRecord;
        journal: StoredRecord;
      }>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const primaryRequest = store.get(key);
        const journalRequest = store.get(journalKey);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Authority read aborted'));
        transaction.oncomplete = () => {
          const primary = primaryRequest.result as StoredRecord | undefined;
          const journal = journalRequest.result as StoredRecord | undefined;
          if (!primary || !journal) {
            reject(new Error('Verified primary or authority journal is missing'));
            return;
          }
          resolve({ primary, journal });
        };
      });

      async function digest(raw: string): Promise<BrowserReplicaRootDigest> {
        const input = new TextEncoder().encode(digestDomain + '\u0000' + raw);
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
        return {
          kind: 'sha256',
          algorithm: 'SHA-256',
          domain: digestDomain,
          hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        };
      }

      const replica = JSON.parse(existing.primary.serializedReplica) as BrowserReplica;
      const current = replica.notes[noteId];
      if (!current) throw new Error('Primary note for lost-notice revision is missing');
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

      const [primaryDigest, targetPrimaryDigest] = await Promise.all([
        digest(existing.primary.serializedReplica),
        digest(serializedReplica),
      ]);
      const journal = JSON.parse(existing.journal.serializedReplica) as BrowserDivergenceEnvelope;
      const last = journal.entries[journal.entries.length - 1];
      if (
        !last ||
        last.state !== 'transactional' ||
        last.primaryDigest.kind !== 'sha256' ||
        last.primaryDigest.hex !== primaryDigest.hex
      ) {
        throw new Error('Lost-notice helper requires verified transactional authority');
      }

      const preparing: BrowserDivergenceEntry = {
        sequence: last.sequence + 1,
        observedAt: '2026-07-19T12:01:00.000Z',
        state: 'preparing',
        reason: 'commit',
        legacyDigest: journal.legacyBaselineDigest,
        primaryDigest,
        targetPrimaryDigest,
        legacyRecoverySequence: null,
        primaryRecoverySequence: null,
      };
      const transactional: BrowserDivergenceEntry = {
        sequence: preparing.sequence + 1,
        observedAt: '2026-07-19T12:01:00.001Z',
        state: 'transactional',
        reason: 'commit',
        legacyDigest: journal.legacyBaselineDigest,
        primaryDigest: targetPrimaryDigest,
        targetPrimaryDigest: null,
        legacyRecoverySequence: null,
        primaryRecoverySequence: null,
      };
      const replacement: StoredRecord = {
        ...existing.primary,
        revision: existing.primary.revision + 1,
        serializedReplica,
      };
      const journalReplacement: StoredRecord = {
        ...existing.journal,
        revision: existing.journal.revision + 2,
        serializedReplica: JSON.stringify({
          ...journal,
          entries: [...journal.entries, preparing, transactional],
        }),
      };

      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const primaryRequest = store.get(key);
        const journalRequest = store.get(journalKey);
        let requestsCompleted = 0;
        let validationError: Error | null = null;
        const commitIfCurrent = () => {
          requestsCompleted += 1;
          if (requestsCompleted !== 2) return;
          const currentPrimary = primaryRequest.result as StoredRecord | undefined;
          const currentJournal = journalRequest.result as StoredRecord | undefined;
          if (
            currentPrimary?.revision !== existing.primary.revision ||
            currentJournal?.revision !== existing.journal.revision
          ) {
            validationError = new Error('Owner authority changed during lost-notice mutation');
            transaction.abort();
            return;
          }
          store.put(replacement);
          store.put(journalReplacement);
        };
        primaryRequest.onsuccess = commitIfCurrent;
        journalRequest.onsuccess = commitIfCurrent;
        transaction.onerror = () => reject(validationError ?? transaction.error);
        transaction.onabort = () =>
          reject(validationError ?? transaction.error ?? new Error('Authority write aborted'));
        transaction.oncomplete = () => resolve();
      });

      database.close();
      return { revision: replacement.revision, serializedReplica };
    },
    {
      databaseName,
      storeName,
      key: ownerKey,
      journalKey: divergenceOwnerKey,
      noteId: initialNoteId,
      title: takeoverRereadSentinel,
      digestDomain: replicaDigestDomain,
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
  await seedAndInstrument(context);

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

test('a frozen old writer preserves both roots and fences the current runtime before network', async ({
  context,
}) => {
  await seedAndInstrument(context);
  await installFrozenOldWriter(context);

  const current = await context.newPage();
  await current.goto('/');
  await expect(current.getByText('Initial local note')).toBeVisible();
  await expect(current.getByTestId('replica-authority-notice')).toHaveCount(0);
  await expect
    .poll(async () => {
      const envelope = JSON.parse(
        (await indexedDbRecord(current, divergenceOwnerKey)).serializedReplica,
      ) as BrowserDivergenceEnvelope;
      return envelope.entries[envelope.entries.length - 1]?.state;
    })
    .toBe('transactional');

  // Give the current runtime a branch that is distinct from the immutable legacy baseline.
  await current.getByRole('button', { name: /New note/ }).click();
  const currentTitle = current.getByPlaceholder('Title');
  await expect(currentTitle).toBeVisible();
  await currentTitle.fill(mixedVersionPrimarySentinel);
  await expect
    .poll(async () =>
      serializedReplicaContainsTitle(await indexedDbRecord(current), mixedVersionPrimarySentinel),
    )
    .toBe(true);
  const primaryBeforeDrift = await indexedDbRecord(current);
  expect(primaryBeforeDrift.serializedReplica).not.toBe(legacyDivergedRaw);
  await current.getByRole('link', { name: 'Notes, back' }).click();
  await expect(current.getByPlaceholder('Search notes…')).toBeVisible();

  // Let the current mutation's immediate sync attempt settle before defining the drift boundary.
  await current.waitForTimeout(500);
  const requestsBeforeDrift = await fetchCount(current);

  // This same-origin page is a frozen pre-cutover runtime: no app bundle, Web Lock, channel, or
  // current repository code. It can still write the shipped legacy localStorage key exactly.
  const oldWriter = await context.newPage();
  await oldWriter.goto('/frozen-old-writer.html');
  await expect(oldWriter.getByRole('heading', { name: 'Frozen pre-cutover writer' })).toBeVisible();
  await expect(oldWriter.locator('script[src]')).toHaveCount(0);
  await oldWriter.getByRole('button', { name: 'Write legacy replica' }).click();
  await expect(oldWriter.getByText('legacy replica written')).toBeVisible();
  expect(await legacyReplicaRaw(oldWriter)).toBe(legacyDivergedRaw);
  expect(await indexedDbRecord(current)).toEqual(primaryBeforeDrift);
  expect(await fetchCount(current)).toBe(requestsBeforeDrift);

  // Search reaches a real authenticated API boundary. The exact legacy recheck must fence the
  // owner and preserve both branches before global fetch can observe another request.
  await current.getByPlaceholder('Search notes…').fill('mixed-version authority check');
  await expect(current.getByText('Local recovery mode')).toBeVisible();
  await expect(current.getByText(/local recovery required/)).toBeVisible();
  await expect(current.getByRole('button', { name: /New note/ })).toBeDisabled();
  expect(await fetchCount(current)).toBe(requestsBeforeDrift);

  const primaryAfterDrift = await indexedDbRecord(current);
  const legacyAfterDrift = await legacyReplicaRaw(current);
  expect(primaryAfterDrift).toEqual(primaryBeforeDrift);
  expect(legacyAfterDrift).toBe(legacyDivergedRaw);

  const controlRecord = await indexedDbRecord(current, divergenceOwnerKey);
  const control = JSON.parse(controlRecord.serializedReplica) as BrowserDivergenceEnvelope;
  expect(Object.keys(control).sort()).toEqual([
    'entries',
    'legacyBaselineDigest',
    'ownerKey',
    'sourceOwnerKey',
    'version',
  ]);
  expect(control.ownerKey).toBe(divergenceOwnerKey);
  expect(control.sourceOwnerKey).toBe(ownerKey);
  const divergedIndex = control.entries.findIndex((entry) => entry.state === 'diverged');
  expect(divergedIndex).toBe(control.entries.length - 1);
  expect(control.entries.slice(divergedIndex).every((entry) => entry.state === 'diverged')).toBe(
    true,
  );
  const diverged = control.entries[divergedIndex]!;
  expect(diverged.reason).toBe('legacy-drift');
  expect(diverged.legacyDigest.hex).not.toBe(diverged.primaryDigest.hex);
  expect(diverged.legacyRecoverySequence).toEqual(expect.any(Number));
  expect(diverged.primaryRecoverySequence).toEqual(expect.any(Number));

  for (const entry of control.entries) {
    expect(Object.keys(entry).sort()).toEqual([
      'legacyDigest',
      'legacyRecoverySequence',
      'observedAt',
      'primaryDigest',
      'primaryRecoverySequence',
      'reason',
      'sequence',
      'state',
      'targetPrimaryDigest',
    ]);
    for (const digest of [entry.legacyDigest, entry.primaryDigest, entry.targetPrimaryDigest]) {
      if (digest === null || digest.kind !== 'sha256') continue;
      expect(digest).toEqual({
        kind: 'sha256',
        algorithm: 'SHA-256',
        domain: replicaDigestDomain,
        hex: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  }

  // The control plane is provenance only. Exact private bytes belong in the two source roots and
  // their recovery branches, never in digest metadata.
  for (const secret of [
    mixedVersionPrimarySentinel,
    legacyDivergenceTitleSentinel,
    legacyDivergenceBodySentinel,
    legacyDivergenceDeviceSentinel,
    initialReplica.notes[initialNoteId].bodyMd,
    initialReplica.deviceId,
    session.token,
  ]) {
    expect(controlRecord.serializedReplica).not.toContain(secret);
  }

  const recovery = JSON.parse(
    (await indexedDbRecord(current, recoveryOwnerKey)).serializedReplica,
  ) as BrowserRecoveryEnvelope;
  expect(recovery.ownerKey).toBe(recoveryOwnerKey);
  expect(recovery.sourceOwnerKey).toBe(ownerKey);
  const legacyBranch = recovery.snapshots.find(
    (snapshot) => snapshot.sequence === diverged.legacyRecoverySequence,
  );
  const primaryBranch = recovery.snapshots.find(
    (snapshot) => snapshot.sequence === diverged.primaryRecoverySequence,
  );
  expect(legacyBranch).toMatchObject({
    reason: 'legacy-divergence',
    serializedReplica: legacyDivergedRaw,
  });
  expect(primaryBranch).toMatchObject({
    reason: 'primary-divergence',
    serializedReplica: primaryBeforeDrift.serializedReplica,
  });
  expect(new Set(recovery.snapshots.map((snapshot) => snapshot.serializedReplica))).toEqual(
    new Set([
      JSON.stringify(initialReplica),
      legacyDivergedRaw,
      primaryBeforeDrift.serializedReplica,
    ]),
  );

  // Exercise the real 8 s background interval after the absorbing state. It must neither send,
  // resume writes, alter either exact root, nor append a contradictory control transition.
  await current.waitForTimeout(8_250);
  expect(await fetchCount(current)).toBe(requestsBeforeDrift);
  expect(await indexedDbRecord(current)).toEqual(primaryBeforeDrift);
  expect(await legacyReplicaRaw(current)).toBe(legacyDivergedRaw);
  expect(await indexedDbRecord(current, divergenceOwnerKey)).toEqual(controlRecord);
  await expect(current.getByRole('button', { name: /New note/ })).toBeDisabled();

  // A cold current-runtime launch must not collapse authority preparation failure into sign-in
  // or a generic blank error. It installs unavailable authority, keeps the session owner, opens
  // the Recovery Center with the compatible primary projection, and still performs no network.
  const recoveryRecordBeforeRestart = await indexedDbRecord(current, recoveryOwnerKey);
  await current.close();
  const relaunched = await context.newPage();
  await relaunched.goto('/');
  await expect(relaunched).toHaveURL(/\/recovery$/);
  await expect(relaunched.getByText('Recovery Center', { exact: true })).toBeVisible();
  await expect(relaunched.getByText('Local recovery mode')).toBeVisible();
  await expect(relaunched.getByText('3 local branches shown')).toBeVisible();
  await relaunched.getByRole('button', { name: 'View notes read-only' }).click();
  await expect(relaunched).toHaveURL(/\/notes$/);
  await expect(relaunched.getByText(mixedVersionPrimarySentinel)).toBeVisible();
  await expect(relaunched.getByRole('button', { name: /New note/ })).toBeDisabled();
  await relaunched.getByRole('tab', { name: 'Settings' }).click();
  await expect(relaunched.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  await relaunched.waitForTimeout(8_250);
  expect(await fetchCount(relaunched)).toBe(0);
  expect(await indexedDbRecord(relaunched)).toEqual(primaryBeforeDrift);
  expect(await legacyReplicaRaw(relaunched)).toBe(legacyDivergedRaw);
  expect(await indexedDbRecord(relaunched, divergenceOwnerKey)).toEqual(controlRecord);
  expect(await indexedDbRecord(relaunched, recoveryOwnerKey)).toEqual(recoveryRecordBeforeRestart);
});
