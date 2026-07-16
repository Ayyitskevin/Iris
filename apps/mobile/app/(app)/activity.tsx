import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ApiRequestError, UNDO_PROTOCOL_VERSION, type ActivityEntry } from '@iris/shared';
import { Button, Muted, Screen, Title } from '../../src/components/ui';
import { authenticatedRequest } from '../../src/api';
import {
  classifyMutationFailure,
  latestUndoableActivityIds,
  mergeAuthoritativeNoteIfSafe,
  noteHasPendingWork,
  requestStillCurrent,
  undoResultNotice,
} from '../../src/history-safety';
import { useObs } from '../../src/state/hooks';
import { assertCurrentSession, store$, updateReplicaForLease } from '../../src/state/store';
import { sync } from '../../src/sync/manager';
import { theme } from '../../src/theme';

const ACTION_LABEL: Record<string, string> = {
  'note.create': 'created a note',
  'note.update': 'edited a note',
  'note.delete': 'deleted a note',
  'note.restore': 'restored a note',
  'note.undo': 'undid an action',
};

export default function Activity() {
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const outbox = useObs(() => store$.outbox.get());
  const pendingPush = useObs(() => store$.pendingPush.get());
  const conflictMap = useObs(() => store$.conflicts.get());
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [undoProtocolVersion, setUndoProtocolVersion] = useState<number | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const undoRequestRef = useRef(0);

  useEffect(() => {
    loadRequestRef.current += 1;
    undoRequestRef.current += 1;
    setItems([]);
    setLoading(false);
    setLoadError(null);
    setUndoNotice(null);
    setUndoProtocolVersion(null);
    setUndoingId(null);
  }, [ownerKey]);

  const load = useCallback(async () => {
    const ownerAtStart = ownerKey;
    const pendingRequest = {
      identity: ownerKey ?? '',
      requestId: ++loadRequestRef.current,
    };
    setLoading(true);
    setLoadError(null);
    // Existing rows stay visible during refresh, but their mutation capability is stale.
    setUndoProtocolVersion(null);
    try {
      const { lease, value } = await authenticatedRequest((api) => api.listActivity());
      assertCurrentSession(lease);
      if (
        !requestStillCurrent(
          pendingRequest,
          store$.activeOwnerKey.get() ?? '',
          loadRequestRef.current,
        )
      ) {
        return;
      }
      setItems(value.activity);
      setUndoProtocolVersion(value.undoProtocolVersion);
    } catch {
      if (
        requestStillCurrent(
          pendingRequest,
          store$.activeOwnerKey.get() ?? '',
          loadRequestRef.current,
        ) &&
        store$.activeOwnerKey.get() === ownerAtStart
      ) {
        setUndoProtocolVersion(null);
        setLoadError('Activity could not be loaded. The existing feed has been kept.');
      }
    } finally {
      if (
        requestStillCurrent(
          pendingRequest,
          store$.activeOwnerKey.get() ?? '',
          loadRequestRef.current,
        ) &&
        store$.activeOwnerKey.get() === ownerAtStart
      ) {
        setLoading(false);
      }
    }
  }, [ownerKey]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function undo(entry: ActivityEntry) {
    if (undoProtocolVersion !== UNDO_PROTOCOL_VERSION || loading || undoingId || !entry.noteId) {
      return;
    }
    if (
      noteHasPendingWork(
        entry.noteId,
        store$.outbox.get(),
        store$.pendingPush.get(),
        Boolean(store$.conflicts.get()[entry.noteId]),
      )
    ) {
      setUndoNotice("Sync or resolve this note's pending change before undoing activity.");
      return;
    }
    const ownerAtStart = ownerKey;
    const pendingRequest = {
      identity: ownerKey ?? '',
      requestId: ++undoRequestRef.current,
    };
    setUndoingId(entry.id);
    setUndoNotice(null);
    try {
      const { lease, value } = await authenticatedRequest((api) => api.undoActivity(entry.id));
      assertCurrentSession(lease);
      let authoritativeApplied = false;
      await updateReplicaForLease(lease, (current) => {
        const merged = mergeAuthoritativeNoteIfSafe(current, value.note);
        authoritativeApplied = merged !== current;
        return merged;
      });
      void sync();
      assertCurrentSession(lease);
      if (
        !requestStillCurrent(
          pendingRequest,
          store$.activeOwnerKey.get() ?? '',
          undoRequestRef.current,
        )
      ) {
        return;
      }
      setUndoNotice(
        undoResultNotice(value) +
          (authoritativeApplied ? '' : ' A newer local change was kept and is syncing.'),
      );
      await load();
    } catch (error) {
      if (
        requestStillCurrent(
          pendingRequest,
          store$.activeOwnerKey.get() ?? '',
          undoRequestRef.current,
        ) &&
        store$.activeOwnerKey.get() === ownerAtStart
      ) {
        const failureKind = classifyMutationFailure(error);
        if (failureKind === 'conflict') {
          setUndoNotice(
            "This action is no longer the note's latest change, so Iris left the newer note untouched.",
          );
          void sync();
        } else if (
          failureKind === 'confirmed-rejection' &&
          error instanceof ApiRequestError &&
          error.code === 'incomplete_history'
        ) {
          setUndoNotice(
            'The snapshot required for this undo is missing. The note was not changed.',
          );
        } else if (failureKind === 'confirmed-rejection') {
          setUndoNotice('The server rejected this undo. The note was not changed.');
        } else {
          setUndoNotice(
            'Iris could not confirm whether the undo completed. Refresh activity before retrying.',
          );
          void load();
          void sync();
        }
      }
    } finally {
      if (
        requestStillCurrent(
          pendingRequest,
          store$.activeOwnerKey.get() ?? '',
          undoRequestRef.current,
        ) &&
        store$.activeOwnerKey.get() === ownerAtStart
      ) {
        setUndoingId(null);
      }
    }
  }

  const undoableActivityIds = latestUndoableActivityIds(items);

  return (
    <Screen>
      <Title>Activity</Title>
      <Muted>Everything your agents and you have done. Undo a note's latest safe action.</Muted>
      {loadError ? (
        <Text style={styles.notice} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {loadError}
        </Text>
      ) : null}
      {undoProtocolVersion !== null && undoProtocolVersion !== UNDO_PROTOCOL_VERSION ? (
        <Text style={styles.notice} accessibilityRole="alert">
          This client can show activity but does not support the server's undo protocol. Update Iris
          before undoing.
        </Text>
      ) : null}
      {undoNotice ? (
        <Text style={styles.notice} accessibilityRole="alert" accessibilityLiveRegion="polite">
          {undoNotice}
        </Text>
      ) : null}
      <FlatList
        style={{ marginTop: theme.space(3) }}
        data={items}
        keyExtractor={(a) => a.id}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.colors.accent} />
        }
        ItemSeparatorComponent={() => <View style={{ height: theme.space(2) }} />}
        ListEmptyComponent={
          <Muted>
            {loading
              ? 'Loading activity…'
              : loadError
                ? 'Activity unavailable.'
                : 'No activity yet.'}
          </Muted>
        }
        renderItem={({ item }) => {
          const isAgent = item.actorType === 'agent';
          const canOfferUndo = undoableActivityIds.has(item.id);
          const pendingForNote = Boolean(
            item.noteId &&
            noteHasPendingWork(item.noteId, outbox, pendingPush, Boolean(conflictMap[item.noteId])),
          );
          return (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text
                  style={[
                    styles.actor,
                    { color: isAgent ? theme.colors.agent : theme.colors.text },
                  ]}
                >
                  {isAgent ? '🤖 ' : '🧑 '}
                  {item.actorName}
                </Text>
                <Text style={styles.action}>
                  {ACTION_LABEL[item.action] ?? item.action}
                  {item.resultingVersion ? ` → v${item.resultingVersion}` : ''}
                </Text>
                <Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
              {canOfferUndo ? (
                <Button
                  label={pendingForNote ? 'Sync pending' : 'Undo'}
                  variant="ghost"
                  loading={undoingId === item.id}
                  disabled={
                    loading ||
                    pendingForNote ||
                    undoProtocolVersion !== UNDO_PROTOCOL_VERSION ||
                    undoingId !== null
                  }
                  accessibilityLabel={
                    pendingForNote
                      ? `Sync or resolve pending changes before undoing ${ACTION_LABEL[item.action] ?? item.action}`
                      : `Undo ${ACTION_LABEL[item.action] ?? item.action}`
                  }
                  onPress={() => undo(item)}
                />
              ) : item.undone ? (
                <Text style={styles.undone}>undone</Text>
              ) : null}
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  notice: { color: theme.colors.accent, fontSize: 12, marginTop: theme.space(2) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
  },
  rowMain: { flex: 1 },
  actor: { fontSize: 15, fontWeight: '600' },
  action: { color: theme.colors.textDim, fontSize: 14, marginTop: 2 },
  time: { color: theme.colors.textDim, fontSize: 11, marginTop: 2 },
  undone: { color: theme.colors.textDim, fontSize: 12, fontStyle: 'italic' },
});
