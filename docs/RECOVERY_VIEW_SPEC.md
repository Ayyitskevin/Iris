# Recovery view selection

**Status: proposal for review. Not an accepted ADR. Do not implement until the three
review decisions at the top are accepted.**

This slice lets an operator who is already in read-only recovery choose which preserved
local branch is on screen, and switch back to the untouched stored primary. It does not
resume sync, edit notes, choose a writable winner, or delete a journal copy.

On acceptance, amend ADR-021's sentence that Recovery Center is inspection and export
only, and amend ADR-023's sentence that this client does not restore a branch. Those
amendments should say view selection is a fenced projection, not authority.

## Review decisions

1. **Show this copy is available only while status is `recovery-required`.** A healthy
   writable session cannot use this screen to enter the fence.
2. **The reverse action is Show stored primary.** It clears the selection and shows the
   untouched primary again. The fence stays. Sync and editing stay off.
3. **Journal bytes are not discarded here.** Snapshots are not removed, tombstoned,
   hidden, or renumbered. Byte deletion is a later slice with its own contract, described
   at the bottom so it is not smuggled into this one.

## Problem

Recovery Center inventories journal-verified, memory-only, and displayed-only branches
and can export them. The visible projection is whichever root hydration already chose:
a valid fenced primary, or the newest compatible journal snapshot. The operator can see
the other copies and cannot put one on screen.

A memory-only swap would not survive reload. Hydration would show the old winner again
and the operator would believe the choice had stuck.

## In scope

- A durable, owner-scoped selection record that names one existing journal snapshot by
  sequence and exact serialized bytes.
- Two inspection-lease actions: show that snapshot, and show the stored primary.
- Recovery Center controls for those actions, with an in-screen confirmation.
- Hydration that honors a verified selection without writing the primary or legacy root.
- Account-erasure coverage for the new key.
- Tests and the skill/doc updates listed below.

## Out of scope

- Deleting, compacting, or renumbering recovery snapshots.
- Importing an external recovery bundle.
- Merging two note trees.
- Clearing `recovery-required`, issuing a session lease, or making a network request.
- Writing or promoting the primary or legacy replica.
- Changing `/v1` or `/v2` sync, BroadcastChannel payloads, or the durable-storage default.
- A server storage epoch or old-client invalidation.
- Physical device force-quit acceptance. Unit and existing browser gates cover this slice.

## Why discard is not in this slice

ADR-021 requires a non-empty journal envelope whose snapshot sequences are contiguous
and equal to their index plus one. ADR-023 stores `legacyRecoverySequence` and
`primaryRecoverySequence` in the control journal. `assertNoOrphanedDivergenceEvidence`
treats a `legacy-divergence` or `primary-divergence` snapshot whose sequence is not in
that set as orphaned evidence and fences the owner.

Removing a middle snapshot forces either a gap or a renumber:

- A gap breaks the next append, which assigns `snapshots.length + 1` and then requires
  `sequence === index + 1`.
- A renumber changes later sequence numbers. A divergence snapshot that was referenced
  becomes unreferenced and the owner fences with no operator action that can undo it.
- Deleting a referenced divergence snapshot drops the only preserved bytes for that
  branch while the control journal still points at the old sequence.

Concurrent appends retry by rereading and unioning exact root plus reason. A shorter
envelope written over that race drops the new evidence unless the rewrite is a separate
protocol. That protocol is the deferred discard slice, not this one.

## Operator experience

The screen keeps today's inventory, previews, and local export.

While status is not `recovery-required`, the screen does not offer Show. The existing
sentence that this screen cannot select, merge, restore, discard, or delete a copy stays
accurate for a healthy session.

While status is `recovery-required` and the inventory is complete:

- Each journal-verified card that is not the projection on screen offers **Show this
  copy**.
- The card whose exact bytes are already on screen says that it is showing, and offers
  no Show action.
- Memory-only and displayed-only cards offer no Show action.
- When a selection record is active, the screen offers **Show stored primary**.

Confirmation is an in-screen choice, not a platform dialog. Show this copy says that
Iris will show that preserved copy, sync and editing stay off, and both the stored
primary and every journal copy stay unchanged. Show stored primary says that Iris will
show the untouched primary again, sync and editing stay off, and the journal stays
unchanged. Cancel leaves every byte and the projection alone.

After a successful Show, notes, outbox, pending push, conflicts, and the sync issue on
screen are that snapshot. Status remains `recovery-required`. The notes list stays
read-only. Export still succeeds and still does not call the API.

A partial inventory or a memory-only candidate disables both actions. The action does
not run until a catalog read has verified the journal. Show this copy flushes
already-staged memory candidates first, using the same failure rule as export: if the
flush cannot verify them, it writes nothing.

## Selection record

The record lives in the recovery repository, the same backend as the recovery journal,
under a domain-separated key:

```text
iris.recovery-view.v1.<encodeURIComponent(sourceOwnerKey)>
```

It is not the primary owner key, the legacy key, the recovery-journal key, or the
divergence-journal key. The recovery repository's `commit` writes it. The promoter's
`commit` is not used, so view selection does not recurse into authority coordination.

Exact keys, version 1:

| Field | Rule |
| --- | --- |
| `version` | `1` |
| `sourceOwnerKey` | The replica owner key |
| `sequence` | Safe integer `>= 1`, matching one current snapshot |
| `serializedReplica` | Exact snapshot bytes, not a canonical re-encoding |

`parse` rejects unknown fields, the wrong owner, a credential-like nested field, and any
replica that fails `assertReplicaRecoverySnapshot`. A failed parse is a hard read
failure for the selection key. It does not delete the record and does not fall through
to another root.

The record stores the exact replica so hydration can compare bytes without trusting the
sequence alone. Those bytes are a second local copy of notes already in the journal.
Account erasure removes them. This slice does not claim that the record is encrypted.

## Actions

Both actions take the current recovery inspection lease. They throw `StaleSessionError`
when the lease, owner, user, or workspace is no longer current. They throw
`StaleRecoveryInspectionError` when the projection epoch or that owner's recovery epoch
changes after the action has captured them. They throw a persistence error, without
writing, when the journal cannot be read or the owner is not fenced.

A web follower or an authority role of `acquiring` cannot call either action. The
function throws before any read that it would follow with a write. `leader` and
`unavailable` may write while the owner is fenced. Flag-off and native runtimes are
`leader` through the always-writable driver, so the normal recovery-required path can
show a copy. Followers stay observational. This slice does not post a BroadcastChannel
notice and does not put replica bytes on that channel. Another tab keeps its last
projection until its own hydration. That split is accepted while durable storage
defaults off.

### Show this copy

Preconditions, checked again immediately before the selection write:

- The owner is in `authoritativeRecoveryFencedOwners`.
- Status for the active owner is `recovery-required`.
- The journal read succeeded and there is no pending memory-only candidate after the
  flush.
- `sequence` identifies a snapshot in that envelope.
- The snapshot's `serializedReplica` passes `assertReplicaRecoverySnapshot` for this
  owner.
- The lease and both epochs are unchanged.

The write is a compare-and-swap of the selection key with a bounded retry. On a stale
write, reread the selection key and retry the same snapshot intent. Do not merge the
retry into the journal envelope. After the durable read-back matches the exact record,
recheck the lease. Only then publish the snapshot into the in-memory projection, leave
the fence set, and advance the projection and recovery epochs so an open catalog reloads.

The journal envelope, primary root, and legacy root are not written. No session lease is
opened. No fetch is made.

If the chosen snapshot is already the exact displayed projection, the action is a
successful no-op: it does not write a selection record merely to repeat the screen.

### Show stored primary

Preconditions:

- A selection record for this owner parses and matches the journal snapshot it names.
- `read` of the primary owner key, without promotion, returns bytes that `parseReplica`
  accepts for this session.
- The lease and epochs are unchanged.

The action then erases the selection key, reads it back as absent, rechecks the lease,
and publishes the primary bytes into memory. The fence stays. Status stays
`recovery-required`. The journal, primary, and legacy roots are not otherwise written.

If the primary read or parse fails, the selection record and the current projection stay
as they were. The UI says the stored primary could not be verified.

## Hydration

`loadReplica` keeps its current order until it has a candidate it would publish while
the owner is fenced or while a selection record exists.

When a selection record exists:

1. Read the journal. A journal read failure fails the load with the existing recovery
   read error. The selection is not deleted and is not projected on its own.
2. Find `sequence`. The snapshot's `serializedReplica` must be byte-identical to the
   selection. Then fence the owner if it is not already fenced, and return that replica.
   Do not clear the fence because the primary happens to parse.
3. If the journal read succeeded and the sequence is missing or the bytes differ, erase
   the selection only when a read-back shows it is still the exact stale record. Then
   continue the existing hydration path. Do not erase when the journal read failed.

A fenced load that has no selection record keeps today's behavior: valid writable
primary may clear a stale-CAS fence; a follower or unavailable handle must not; primary
read failure still falls through to the newest compatible journal snapshot.

Showing a journal copy therefore survives reload. Showing the stored primary also
survives reload, because the selection key is gone and the primary bytes were never
replaced.

## Account erasure

`eraseLocalOwnerAfterConfirmedAccountDeletion` and
`PromotingOwnerReplicaRepository.erase` both erase the selection key for that owner,
after the session tombstone and alongside the recovery journal key. Absence is success.
The erase result is verified with a follow-up read before the in-memory projection is
cleared. A leftover selection key fails the erase the same way a leftover journal key
does.

The divergence control key is already outside this erase path. This slice does not
widen that gap and does not claim the control key is removed.

## UI contract

`recovery.tsx` reads an inspection result:

```ts
interface ReplicaRecoveryInspection {
  catalog: ReplicaRecoveryCatalog | null;
  viewSource: 'recovery-selection' | 'stored-primary' | 'unselected';
  selectedSequence: number | null;
}
```

`buildReplicaRecoveryCatalog` stays selection-unaware. The store attaches the view
fields after it reads the selection key. `viewSource` is `recovery-selection` only when
the selection verified against the journal and the displayed bytes match it.
`stored-primary` means the fence is active, no verified selection is active, and the
displayed bytes came from the primary. `unselected` is the healthy or not-yet-fenced
inventory.

Buttons use the existing `Button` variants. Show this copy is `primary`. Show stored
primary is `ghost`. The confirming step uses `danger` only for the confirming Show
action, because it replaces the visible notes. Neither action is labeled restore,
discard, or delete.

One action is in flight at a time. Export, Show, and catalog reload share the screen's
request generation. A newer request or a stale lease leaves the previous result unapplied.
Success and failure messages are text on the screen, announced on iOS when a screen
reader is enabled, matching export.

## Failure matrix

| Case | Result |
| --- | --- |
| Show a verified snapshot while fenced | Projection matches those bytes. Status stays `recovery-required`. Journal, primary, and legacy bytes are unchanged. Selection read-back matches. No fetch. |
| Reload after that Show | Hydration projects the same bytes and keeps the fence, including when the primary parses. |
| Show the snapshot already on screen | No selection write. Projection unchanged. |
| Show stored primary after a verified primary read | Selection key is absent. Projection is the primary. Fence and `recovery-required` remain. Journal unchanged. |
| Primary unreadable during Show stored primary | Selection and projection unchanged. UI reports that the primary could not be verified. |
| Last or middle snapshot, divergence snapshot, displayed snapshot | Show still only copies it into the selection. The journal still contains it. |
| Memory-only card, displayed-only card, partial inventory | Action refused before a selection write. |
| Owner switch, stale lease, epoch change, follower, `acquiring` | No selection write and no projection publish. |
| Selection write conflicts | Retry the same snapshot intent against the selection key. Exhaustion leaves the previous selection and projection in place. |
| Journal unreadable | No selection write. Existing selection is not deleted. |
| Stale selection on a successful journal read | That exact stale selection is erased, then ordinary hydration runs. |
| Confirmed account erasure | Selection key, primary, and journal key are absent before success is returned. |

## Tests

Add `apps/mobile/src/state/replica-recovery-selection.test.ts` for the key, the exact
parser, credential rejection, and owner mismatch.

Extend the store fence tests, or add `store-recovery-view.test.ts`, for every row in
the failure matrix that the store owns. Assert primary and journal raw bytes with
direct repository reads. Assert that the API client is not called.

Extend `account-deletion-local.test.ts` so a selection key cannot survive a verified
erase, including the promoter path.

Extend `promoting-replica-repository` erase coverage for the new key without changing
divergence-journal behavior.

Parser tests for the recovery envelope stay red if a snapshot is removed or renumbered.
This slice adds no such test change because it does not change the envelope.

## Docs and skills

In the same implementation change:

- Amend ADR-021 and ADR-023 only as far as the acceptance paragraph above.
- Update the Recovery Center paragraph in `.claude/skills/client-architecture/SKILL.md`.
- Update the ambiguous-replica row in `docs/SYNC_RECOVERY.md` from "choose/restore
  remains gated" to view selection without authority change.
- Update the Recovery Center sentence in `docs/ROADMAP.md` and `docs/MASTER_PLAN.md`
  so choose/restore/import/discard is not described as shipped. View selection is
  shipped; import, discard, and writable resolution stay open.

## Acceptance

Accepted when the review decisions above are unchanged, the mobile tests for this slice
pass, and `pnpm typecheck` and `pnpm lint` pass. A browser pass of Recovery Center is
required only when a recovery-required fixture can be driven in the running web client.
This slice does not flip `EXPO_PUBLIC_DURABLE_STORAGE` and does not require a device.

## Deferred discard contract

A later slice may remove journal bytes only if it lands all of the following together:

- Sequence numbers never change.
- Append assigns `max(sequence) + 1`, and the parser accepts a non-empty sparse set.
- A snapshot whose sequence is stored in the control journal cannot be removed.
- A `legacy-divergence` or `primary-divergence` snapshot cannot be removed.
- The last remaining snapshot cannot be removed, because the envelope cannot be empty.
- The rewrite is a reread-and-apply intent with stale retry, so a concurrent append is
  unioned rather than overwritten.
- The selection record is cleared or repointed in the same successful outcome when it
  named a removed sequence.
- Account erasure remains the only path that deletes divergence evidence and the
  control journal.

Until that slice exists, Recovery Center does not offer discard.
