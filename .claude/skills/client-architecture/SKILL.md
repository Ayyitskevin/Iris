---
name: client-architecture
description: Open when working on the Expo mobile client — routing/navigation, the Legend-State local-first store, the sync manager, the shared API client, or adding a screen/tab.
---

## When to use

- Adding a screen, tab, or route to `apps/mobile`, or changing navigation/redirects.
- Touching how the UI reads or writes state (notes list, editor, settings, sync status).
- Debugging: edits not persisting, sync not firing, a note not updating on screen, the auth gate bouncing, "sync gated" (402) or conflict banners.
- Changing what the client sends to the API, or how the session token is attached.
- NOT for server/RLS/versioning internals — that lives in `apps/api`. This skill stops at the wire.

## Mental model

The client is **local-first** (ADR-005/ADR-011/ADR-012). Legend-State's `store$` is
only the active owner's projection. Credentials are persisted separately; each durable
replica is keyed by immutable workspace + user identity and contains notes, cursor,
device id, outbox, exact `pendingPush`, and conflicts. User edits mutate the projection
synchronously. The coordinator captures a fixed-token generation lease, persists a
request before dispatch, reconciles only while that lease is current, then drains every
pull page. The UI never waits on the network.

Routing is **Expo Router** (file = route). `app/index.tsx` is the gate that redirects to `/notes` or `/sign-in` based on `store$.session`. Route groups `(auth)` and `(app)` organize screens without appearing in the URL. React reads the store through one deliberately version-thin hook, `useObs` (`src/state/hooks.ts`), built on Legend-State's core `observe` + React's `useSyncExternalStore` so a library upgrade can't strand the UI.

## Key files

- `app/_layout.tsx` — hydrates before routing, retries rejected-session tombstones, and runs the 8-second sync loop.
- `app/index.tsx` — the root gate: `useObs(() => store$.session.get() !== null)` → `<Redirect href={signedIn ? '/notes' : '/sign-in'} />`.
- `app/(auth)/_layout.tsx` — `<Stack>` for `sign-in` / `sign-up`. `(auth)` group is not in the URL.
- `app/(app)/_layout.tsx` — `<Tabs>` for the signed-in app. Second gate: `if (!signedIn) return <Redirect href="/sign-in" />`. Declares **four** visible tabs via `<Tabs.Screen>`: `notes` (Notes), `conflicts` (title **Review**, with a `tabBarBadge` of the live `conflictCount`), `activity` (Activity), and `settings` (Settings), plus the hidden `recovery` route. The tabs are keyed by `ownerKey` so route and component state reset across an account switch.
- `app/(app)/conflicts.tsx` — the **Review** inbox (`ConflictInbox`). Reads `store$.conflicts` and resolves each retained sync conflict via `keepLocalConflict` / `useServerConflict` from `sync/manager`.
- `app/(app)/notes/_layout.tsx` — nested `<Stack>` registering `index` and `[id]`.
- `app/(app)/notes/index.tsx` — list screen. Reactive reads via `useObs(selectVisibleNotes)`, `store$.status`, `store$.syncGated`, `store$.syncIssue`, `store$.outbox.length`. It owns the visible terminal-sync banner and manual recovery action. New note: `createNoteLocal(...)` then `router.push('/notes/'+id)`.
- `app/(app)/notes/[id].tsx` — editor. `useLocalSearchParams<{id}>()`, `useObs(() => store$.notes[id].get())`, edits call `updateNoteLocal`/`deleteNoteLocal`. History/restore hit `api` directly.
- `app/(app)/recovery.tsx` — owner-reset Recovery Center. It inventories journal,
  memory-only, and distinct displayed branches through a credential-free inspection lease,
  renders bounded previews, and requests the strict local all-branch export. It has no
  choose/restore/import/merge/discard controls.
- `src/state/store.ts` — owner-keyed replicas, separate session/tombstone storage,
  legacy `iris:state:v1` recovery quarantine, generation leases, verified writes, an
  append-only stale-CAS recovery journal, read-only recovery mode, credential-free recovery
  inspection/export leases, and selectors.
- `src/state/replica-recovery-catalog.ts` + `src/recovery/export.ts` — bounded,
  non-preferential branch summaries and the strict token-free exact-byte bundle.
- `src/recovery/export-sink.ts` / `.native.ts` — web Blob download vs native
  verified-cache/share handoff. Delivery is not proof that the user retained a destination.
- `src/state/hooks.ts` — `useObs<T>(selector)`. The only sanctioned way to read `store$` in a component.
- `src/state/storage.ts` — `storage: KVStore`. Web `localStorage`; native `expo-secure-store` (~2KB/key cap).
- `src/sync/manager.ts` — optimistic mutations/conflict choices and deliberate
  `recoverSyncIssue` actions; delegates network work.
- `src/sync/coordinator.ts` + `reconcile.ts` — lease-bound staged push, pure
  reconciliation, validation, and complete paged pull.
- `src/api.ts` — unauthenticated `publicApi` plus fixed-token, abortable
  `apiForLease`; authenticated component requests return the checked lease.
- `src/auth/session.ts` — serialized owner adoption and durable sign-out tombstones.
- `src/config.ts` — `API_URL` from `EXPO_PUBLIC_API_URL` env → expo `extra.apiUrl` → `http://localhost:4000`.
- `packages/shared/src/api-client.ts` — typed methods plus distinct `ApiRequestError`
  classifiers for version conflict, idempotency reuse, and payment-required.
- `src/components/ui.tsx` — `Screen`, `Title`, `Muted`, `Field`, `Button`, `Card`. Use these + `src/theme.ts` (`theme.colors`, `theme.space(n)`, `theme.radius`) so screens match.

## Playbook

**Most common task: add a new tab screen ("Search") to the signed-in app.**

1. Create the screen file `app/(app)/search.tsx`. Default-export a component; read state with `useObs`, never touch `store$` directly:

   ```tsx
   import { FlatList, Pressable, Text } from 'react-native';
   import { router } from 'expo-router';
   import { Screen, Muted } from '../../src/components/ui';
   import { useObs } from '../../src/state/hooks';
   import { selectVisibleNotes } from '../../src/state/store';
   import { theme } from '../../src/theme';

   export default function Search() {
     // useObs re-renders when any observable read in the selector changes.
     const notes = useObs(selectVisibleNotes);
     return (
       <Screen>
         <FlatList
           data={notes}
           keyExtractor={(n) => n.id}
           ListEmptyComponent={<Muted>No notes.</Muted>}
           renderItem={({ item }) => (
             <Pressable onPress={() => router.push(`/notes/${item.id}`)}>
               <Text style={{ color: theme.colors.text }}>{item.title || 'Untitled'}</Text>
             </Pressable>
           )}
         />
       </Screen>
     );
   }
   ```

2. Register the tab in `app/(app)/_layout.tsx` — add a `<Tabs.Screen>` alongside the existing three:

   ```tsx
   <Tabs.Screen
     name="search" // must equal the filename (no extension)
     options={{ title: 'Search', tabBarIcon: ({ color }) => <Text style={{ color }}>⌕</Text> }}
   />
   ```

   The `name` must match the route filename exactly. The `(app)/_layout.tsx` gate already blocks the whole group when signed out — no per-screen auth check needed.

3. To instead add a **detail/stack screen** (pushed, not a tab), drop the file under an existing stack dir (e.g. `app/(app)/notes/tag.tsx`) and register `<Stack.Screen name="tag" .../>` in that dir's `_layout.tsx`. Navigate with `router.push('/notes/tag')`. Dynamic segments use `[param].tsx` + `useLocalSearchParams<{ param: string }>()`.

4. **Mutating a note** from any screen goes through the sync manager, never `store$.notes[id].set(...)` directly:

   ```tsx
   import { createNoteLocal, updateNoteLocal, deleteNoteLocal } from '../../src/sync/manager';
   const note = createNoteLocal({ title: '', bodyMd: '' }); // optimistic; version 0 = unsynced
   updateNoteLocal(note.id, { bodyMd: 'hello' }); // patches store + enqueues outbox
   deleteNoteLocal(note.id); // tombstone (deletedAt), enqueues delete
   ```

   Each call uses `applyReplicaForLease`: it coalesces `store$.outbox`, registers the exact
   durability promise before synchronously publishing `store$`, reports persistence failure,
   and triggers `sync()`. The list re-renders because it reads `store$.notes` via `useObs`.

5. **Authenticated component requests** use `authenticatedRequest`. It captures one
   immutable lease and returns it with the value; assert that lease immediately before
   applying the result to component or replica state:

   ```tsx
   import { authenticatedRequest } from '../../src/api';
   import { assertCurrentSession } from '../../src/state/store';
   const { lease, value } = await authenticatedRequest((client) => client.listVersions(id));
   assertCurrentSession(lease);
   setVersions(value.versions);
   ```

6. Verify: `pnpm --filter @iris/mobile start` (or `dev`), open the app, confirm the tab renders,
   a new note persists across a reload (proves the owner repository + `loadState`), and the sync
   status pill flips `syncing…` → `synced`.

## Invariants & gotchas

- **Never mutate notes on `store$` directly for user edits.** Always go through `createNoteLocal`/`updateNoteLocal`/`deleteNoteLocal`. A raw `store$.notes[id].set(...)` skips the outbox and the `baseVersion` bookkeeping, so the edit never syncs and can be silently overwritten by the next pull. (The reconcile paths inside `sync()` and version _restore_ are the only places that write notes straight to the store — because they carry authoritative server rows.)
- **`version: 0` means local and unacknowledged.** A version mismatch is a per-operation
  HTTP 200 conflict result retained in the Review inbox. HTTP 409 from sync means
  `idempotency_key_reused` and must fail loud.
- **Outbox coalesces; `pendingPush` does not.** The outbox keeps the latest edit per
  note. Once a schema-validated slice of at most six operations and 1,900,000 serialized
  UTF-8 request bytes is staged, that exact request survives until its response is
  durably reconciled; newer edits and the remainder stay in outbox and are rebased or
  sent in later bounded chunks. A cycle drains no more than 16 chunks / 96 operations,
  persisting `pendingPush: null` after each response before staging the next; a larger
  remainder waits for the next cycle. Before sending a batch that was already pending
  when a cycle began, queue an identity replica commit: memory can reflect a failed save
  when a concurrent edit made rollback unsafe.
- **`sync()` is single-flight per session generation.** The coordinator's `activeRuns`
  map owns repeat scheduling. It fires from the root interval, enqueue, and note-open
  effect; do not add another interval.
- **Credentials and replicas are separate.** The owner replica persists notes, cursor,
  device id, outbox, pending request, conflicts, and any terminal `syncIssue`.
  `status` and `syncGated` are ephemeral. Never put the bearer token in a replica or
  reuse component state across owner keys.
- **Pull preserves pending edits and conflicts.** It skips current outbox note ids and
  refreshes a retained conflict's server side without discarding its local mutation.
- **A durable `syncIssue` is a full network stop.** Hydration preserves it, and every
  automatic `sync()` returns before registration, push, or pull until the user chooses
  the visible recovery action. `rekey` changes only affected operation ids,
  `reset-cursor` replays pull from the canonical start, `restage` discards only an
  invalid pre-dispatch pending snapshot so the current outbox can be staged, and
  `retry` preserves the exact pending request.
- **402 = the multi-device billing gate** (ADR-007), raised at `registerDevice`. `sync()` sets `store$.syncGated = true` and returns early — **local editing still works**, only sync stops. Surface it (banner in `notes/index.tsx`); do not treat it as a hard error.
- **Two auth gates, both owner-reset.** Root and app layouts redirect on `session ===
null`; route keys include the owner so component state cannot survive an account
  switch. Sign-out must first commit its token-free tombstone.
- **`useObs` selector identity matters.** Its `subscribe` is memoized on `[selector]`, so an inline arrow re-subscribes every render (works, but churns). For hot lists prefer a stable module-level selector like `selectVisibleNotes`. Every observable you read _inside_ the selector becomes a dependency — read only what the component renders.
- **`Tabs.Screen`/`Stack.Screen` `name` must equal the filename** (sans extension); route groups `(auth)`/`(app)` and the `notes/` folder are path segments, but parenthesized groups are stripped from the URL. A mismatched `name` silently drops the screen from the navigator.
- **Native replica capacity: the wiring exists behind an opt-in flag; authority is not
  flipped by default yet.** Production defaults to writing the whole replica to one SecureStore
  value (a small per-value ceiling). The transactional stores for real capacity exist for both
  platforms — `IndexedDbTransactionalReplicaStore` (web, ADR-017) and
  `ExpoSqliteTransactionalReplicaStore` (native, ADR-020, `node:sqlite`-tested) — plus a
  `PromotingOwnerReplicaRepository` that lazily copies an existing key/value replica into a
  transactional store on first read. `store.ts` is **fence-aware**: stale recovery is
  single-flight per owner, stages every exact losing root, and synchronously blocks reducers.
  The final barrier publishes a valid winner only after all participants reach the strict
  credential-free append-only journal. Failed appends remain only for same-process retry while
  storage is unavailable; cross-process append union is guaranteed only by a transactional CAS
  repository, not the default legacy last-write-wins adapter. Missing/corrupt/future authority
  stays untouched; a
  compatible recovery candidate reopens read-only as `recovery-required`, and session departure
  is permitted only after pending candidates are verified.
  - **Recovery inspection is a separate capability.** `openRecoveryInspectionLease` contains
    owner identity + generation + abort signal, never bearer or device authority. Catalog reads
    fence projection and recovery-candidate epochs, retry only a bounded pending→journal
    transition, and fail stale on owner/display changes. A failed durable-journal read may expose
    exact memory-only branches only as an explicitly partial inventory.
  - **Local recovery export is fail-closed and all-branch.** It flushes only already-staged
    candidates, never saves the primary root, never calls the API, and emits nothing if every
    branch cannot be verified. Journal roots and a byte-distinct displayed root survive exactly;
    structural equality is for UI matching only. The bundle's projection/recovery epoch is checked
    through platform delivery. Web attaches the anchor and defers URL cleanup. Native reads the
    cache file back before sharing, retains handed-off files for slow receivers, and attempts to
    purge only files with verified timestamps older than 24 hours from Iris's dedicated cache
    directory on later launches/exports; unknown timestamps remain, and a cleanup failure is
    disclosed without blocking a separately named export.
  - **The singleton lives in `select-owner-replica-repository.ts`** (not `replica-repository.ts`,
    which is now pure building blocks). `store.ts` imports `ownerReplicaRepository` from there.
    It picks the platform store by capability detection (IndexedDB present → web; a
    `navigator.product === 'ReactNative'` runtime → native SQLite; else Node/SSR → none) with
    **no static `react-native` import**, so it loads under vitest/tsc.
  - **The flip is gated by `EXPO_PUBLIC_DURABLE_STORAGE` (default off).** Off — or a platform
    with no transactional store — returns the legacy `SerializedKvReplicaRepository` unchanged.
    Set it to `1`/`true` only in controlled device/browser tests. On capable web runtimes the
    selector also installs one owner-scoped Web Lock authority: followers are read-only, receive
    exact metadata-only refresh notices, and reread before takeover. It is **not cutover-safe**:
    the promoter leaves legacy writable, and an already-loaded old client cannot honor the lock
    even though current-runtime tabs and stale CAS are fenced correctly.
  - **`expo-sqlite` is native-only in the bundle:** the opener is platform-split
    (`open-expo-sqlite-store.native.ts` real vs `open-expo-sqlite-store.ts` stub) so Metro never
    pulls `expo-sqlite` into the **web** bundle. If you add another native-only dependency to the
    replica path, split it the same way and re-run `pnpm --filter @iris/mobile run export:web`.
    The recovery sink follows the same split so `expo-file-system` and `expo-sharing` stay on
    native while the base file remains the browser implementation.
  - Remaining CUTOVER: add a mixed-version legacy/primary divergence journal and an enforceable
    old-client compatibility gate, integrate divergence roots into Recovery Center, add
    choose/restore/import/discard controls, and complete browser/native acceptance.
    Only then flip the default and port the coordinator to `/v2`.
    Writes are verified and non-fence failures set `error`; staging failure prevents dispatch.
- **Everything is workspace-scoped by a fixed-token lease.** The client never sends a
  `workspaceId`; the server derives it. Do not replace `apiForLease` with a mutable
  token callback for authenticated work. Do not give Recovery Center a `SessionLease`; its
  local-only `RecoveryInspectionLease` is intentionally credential-free.
