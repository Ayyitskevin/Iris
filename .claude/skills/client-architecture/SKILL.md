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

The client is **local-first** (ADR-005). A single Legend-State observable, `store$` (`src/state/store.ts`), is the source of truth the UI renders. User edits mutate `store$` **synchronously** through the sync manager (`src/sync/manager.ts`) — the UI never waits on the network. Each local mutation also drops an entry in `store$.outbox`. A background `sync()` loop (kicked every 8s from the root layout, and on every mutation) reconciles: register the device → push the outbox → pull deltas. The server is authoritative on conflict; the client surfaces conflicts, never silently drops them.

Routing is **Expo Router** (file = route). `app/index.tsx` is the gate that redirects to `/notes` or `/sign-in` based on `store$.session`. Route groups `(auth)` and `(app)` organize screens without appearing in the URL. React reads the store through one deliberately version-thin hook, `useObs` (`src/state/hooks.ts`), built on Legend-State's core `observe` + React's `useSyncExternalStore` so a library upgrade can't strand the UI.

## Key files

- `app/_layout.tsx` — root layout. `useEffect` runs `loadState()` and gates render on `ready` (spinner until hydrated → app opens instantly, offline). Second effect runs `sync()` immediately then `setInterval(sync, 8000)` while `store$.session.get()` is truthy. Wraps routes in `SafeAreaProvider` + a headerless `<Stack>`.
- `app/index.tsx` — the root gate: `useObs(() => store$.session.get() !== null)` → `<Redirect href={signedIn ? '/notes' : '/sign-in'} />`.
- `app/(auth)/_layout.tsx` — `<Stack>` for `sign-in` / `sign-up`. `(auth)` group is not in the URL.
- `app/(app)/_layout.tsx` — `<Tabs>` for the signed-in app. Second gate: `if (!signedIn) return <Redirect href="/sign-in" />`. Declares the three tabs via `<Tabs.Screen name="notes|activity|settings" .../>`.
- `app/(app)/notes/_layout.tsx` — nested `<Stack>` registering `index` and `[id]`.
- `app/(app)/notes/index.tsx` — list screen. Reactive reads via `useObs(selectVisibleNotes)`, `store$.status`, `store$.syncGated`, `store$.outbox.length`. New note: `createNoteLocal(...)` then `router.push('/notes/'+id)`.
- `app/(app)/notes/[id].tsx` — editor. `useLocalSearchParams<{id}>()`, `useObs(() => store$.notes[id].get())`, edits call `updateNoteLocal`/`deleteNoteLocal`. History/restore hit `api` directly.
- `src/state/store.ts` — `store$ = observable<AppState>(...)`, the `AppState`/`Session` types, `loadState`/`saveState` (persist key `iris:state:v1`), `generateDeviceId`, and the `selectVisibleNotes()` selector.
- `src/state/hooks.ts` — `useObs<T>(selector)`. The only sanctioned way to read `store$` in a component.
- `src/state/storage.ts` — `storage: KVStore`. Web `localStorage`; native `expo-secure-store` (~2KB/key cap).
- `src/sync/manager.ts` — `createNoteLocal` / `updateNoteLocal` / `deleteNoteLocal` (optimistic + enqueue) and `sync()` (reconcile). Module-level `syncing` flag = single-flight lock.
- `src/api.ts` — `api = createApiClient({ baseUrl: API_URL, getToken: () => store$.session.get()?.token ?? null })`. Token is pulled from the store on every request; nothing else wires auth.
- `src/auth/session.ts` — `signIn`/`signUp` adopt an `AuthResponse` into `store$.session` + `saveState`; `signOut` clears session/notes/outbox/cursor/gate/conflict.
- `src/config.ts` — `API_URL` from `EXPO_PUBLIC_API_URL` env → expo `extra.apiUrl` → `http://localhost:4000`.
- `packages/shared/src/api-client.ts` — `createApiClient`, the method surface, and `ApiRequestError` (`.isConflict`=409, `.isPaymentRequired`=402).
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
     name="search"                       // must equal the filename (no extension)
     options={{ title: 'Search', tabBarIcon: ({ color }) => <Text style={{ color }}>⌕</Text> }}
   />
   ```

   The `name` must match the route filename exactly. The `(app)/_layout.tsx` gate already blocks the whole group when signed out — no per-screen auth check needed.

3. To instead add a **detail/stack screen** (pushed, not a tab), drop the file under an existing stack dir (e.g. `app/(app)/notes/tag.tsx`) and register `<Stack.Screen name="tag" .../>` in that dir's `_layout.tsx`. Navigate with `router.push('/notes/tag')`. Dynamic segments use `[param].tsx` + `useLocalSearchParams<{ param: string }>()`.

4. **Mutating a note** from any screen goes through the sync manager, never `store$.notes[id].set(...)` directly:

   ```tsx
   import { createNoteLocal, updateNoteLocal, deleteNoteLocal } from '../../src/sync/manager';
   const note = createNoteLocal({ title: '', bodyMd: '' });   // optimistic; version 0 = unsynced
   updateNoteLocal(note.id, { bodyMd: 'hello' });             // patches store + enqueues outbox
   deleteNoteLocal(note.id);                                   // tombstone (deletedAt), enqueues delete
   ```

   Each call mutates `store$` synchronously, coalesces into `store$.outbox`, `saveState()`s, and triggers `sync()`. The list re-renders because it reads `store$.notes` via `useObs`.

5. **Calling the API directly** (data not mirrored in the store — billing, agent tokens, version history) uses `api` from `src/api.ts`; the session token is attached automatically. Handle offline with a swallowed `try/catch` and gates by error type:

   ```tsx
   import { api } from '../../src/api';
   import { ApiRequestError } from '@iris/shared';
   try {
     const versions = await api.listVersions(id);
   } catch (e) {
     if (e instanceof ApiRequestError && e.isPaymentRequired) { /* 402: sync gate */ }
   }
   ```

6. Verify: `pnpm --filter @iris/mobile start` (or `dev`), open the app, confirm the tab renders, a new note persists across a reload (proves `saveState`/`loadState`), and the sync status pill flips `syncing…` → `synced`.

## Invariants & gotchas

- **Never mutate notes on `store$` directly for user edits.** Always go through `createNoteLocal`/`updateNoteLocal`/`deleteNoteLocal`. A raw `store$.notes[id].set(...)` skips the outbox and the `baseVersion` bookkeeping, so the edit never syncs and can be silently overwritten by the next pull. (The reconcile paths inside `sync()` and version *restore* are the only places that write notes straight to the store — because they carry authoritative server rows.)
- **`version: 0` means "created locally, not yet acknowledged."** `baseVersion` in each outbox mutation is the optimistic-concurrency token; the server returns **409** when it disagrees. On 409, `sync()` writes `serverNote` into the store and sets `store$.conflictNoteId` — the editor shows the conflict banner and the user re-applies. Do not "fix" a 409 by retrying blindly.
- **The outbox coalesces per note id** (`enqueue` drops any prior mutation for the same note). Only the latest pending mutation per note survives; `opId` is the idempotency key so retries don't double-apply. Don't assume every intermediate edit is a separate outbox entry.
- **`sync()` is single-flight** via the module-level `syncing` flag and no-ops without a session. It fires from three places: the 8s interval in `app/_layout.tsx`, every `enqueue`, and a `useEffect` on note open in `[id].tsx`. Don't add your own interval — reuse these.
- **Only a slice is persisted.** `saveState` writes `session, notes, syncCursor, deviceId, outbox`. `status`, `syncGated`, and `conflictNoteId` are **ephemeral** — they reset to defaults on restart and are recomputed by the next `sync()`. Never persist logic that depends on them surviving a reload.
- **The pull step preserves in-flight edits:** `sync()` builds a `pending` set from the outbox and skips those note ids when applying server changes, so a delta never clobbers an unpushed local edit. Keep that filter if you touch the pull loop.
- **402 = the multi-device billing gate** (ADR-007), raised at `registerDevice`. `sync()` sets `store$.syncGated = true` and returns early — **local editing still works**, only sync stops. Surface it (banner in `notes/index.tsx`); do not treat it as a hard error.
- **Two auth gates, both reactive.** `app/index.tsx` and `app/(app)/_layout.tsx` each redirect on `session === null`. After `signOut()` also call `router.replace('/sign-in')` (see `settings.tsx`) — don't rely on the gate alone mid-stack.
- **`useObs` selector identity matters.** Its `subscribe` is memoized on `[selector]`, so an inline arrow re-subscribes every render (works, but churns). For hot lists prefer a stable module-level selector like `selectVisibleNotes`. Every observable you read *inside* the selector becomes a dependency — read only what the component renders.
- **`Tabs.Screen`/`Stack.Screen` `name` must equal the filename** (sans extension); route groups `(auth)`/`(app)` and the `notes/` folder are path segments, but parenthesized groups are stripped from the URL. A mismatched `name` silently drops the screen from the navigator.
- **Native persistence is best-effort.** `storage.ts` uses SecureStore (~2KB/key) on native, so large note payloads may fail to persist — `saveState` swallows the error by design. A durable native DB (MMKV/expo-sqlite) is a roadmap follow-up; don't build features assuming unbounded local storage on device today.
- **Everything is workspace-scoped by the bearer token.** The client never sends `workspaceId`; `getToken` in `src/api.ts` reads `store$.session.token` and the server derives the tenant. Don't add explicit workspace params to client calls.
