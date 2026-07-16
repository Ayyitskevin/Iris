import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { NoteVersion } from '@iris/shared';
import { Button, Muted } from '../../../src/components/ui';
import { useObs } from '../../../src/state/hooks';
import {
  assertCurrentSession,
  isCurrentSession,
  setStatusForLease,
  store$,
  type SessionLease,
  updateReplicaForLease,
} from '../../../src/state/store';
import {
  deleteNoteLocal,
  keepLocalConflict,
  sync,
  updateNoteLocal,
  useServerConflict,
} from '../../../src/sync/manager';
import { authenticatedRequest } from '../../../src/api';
import {
  canRestoreHistory,
  classifyMutationFailure,
  requestStillCurrent,
} from '../../../src/history-safety';
import { theme } from '../../../src/theme';

export default function NoteEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = useObs(() => (id ? store$.notes[id].get() : undefined));
  const conflict = useObs(() => (id ? store$.conflicts.get()[id] : undefined));
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [historyBaseVersion, setHistoryBaseVersion] = useState<number | null>(null);
  const [restoreProtocolVersion, setRestoreProtocolVersion] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [tagsText, setTagsText] = useState('');
  const historyRequestRef = useRef(0);
  const restoreRequestRef = useRef(0);
  const routeIdentity = `${ownerKey ?? ''}:${id ?? ''}`;
  const routeIdentityRef = useRef(routeIdentity);
  routeIdentityRef.current = routeIdentity;

  useEffect(() => {
    // Best-effort: pull the latest server state for this note when opening.
    void sync();
  }, [id]);

  // Seed the tags input once the note is available (keyed on note id, not tags, so
  // the field doesn't fight the user's typing).
  useEffect(() => {
    // Seed only when the note identity changes, not on every tag edit.
    if (note) setTagsText(note.tags.join(', '));
    historyRequestRef.current += 1;
    restoreRequestRef.current += 1;
    setVersions(null);
    setHistoryBaseVersion(null);
    setRestoreProtocolVersion(null);
    setHistoryError(null);
    setRestoreNotice(null);
    setRestoringVersionId(null);
  }, [note?.id, ownerKey]);

  function commitTags() {
    if (!id) return;
    const parsed = [
      ...new Set(
        tagsText
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    updateNoteLocal(id, { tags: parsed });
  }

  if (!id || !note) {
    return (
      <View style={styles.container}>
        <Muted>Note not found.</Muted>
      </View>
    );
  }

  async function loadHistory() {
    const ownerAtStart = ownerKey;
    const pendingRequest = {
      identity: routeIdentityRef.current,
      requestId: ++historyRequestRef.current,
    };
    setHistoryError(null);
    setRestoreNotice(null);
    try {
      const { lease, value } = await authenticatedRequest((api) => api.listVersions(id));
      assertCurrentSession(lease);
      if (
        !requestStillCurrent(pendingRequest, routeIdentityRef.current, historyRequestRef.current)
      ) {
        return;
      }
      setVersions(value.versions);
      setRestoreProtocolVersion(value.restoreProtocolVersion);
      setHistoryBaseVersion(value.headVersion ?? null);
      if (
        value.restoreProtocolVersion === 1 &&
        store$.notes[id].get()?.version !== value.headVersion
      ) {
        void sync();
      }
    } catch {
      if (
        requestStillCurrent(pendingRequest, routeIdentityRef.current, historyRequestRef.current) &&
        store$.activeOwnerKey.get() === ownerAtStart
      ) {
        setVersions(null);
        setHistoryBaseVersion(null);
        setRestoreProtocolVersion(null);
        setHistoryError('Version history could not be loaded. Your note is unchanged.');
      }
    }
  }

  const historyHeadMismatch = historyBaseVersion !== null && note.version !== historyBaseVersion;
  const restoreAllowed = canRestoreHistory({
    protocolVersion: restoreProtocolVersion,
    historyHeadVersion: historyBaseVersion,
    localHeadVersion: note.version,
    blocked: Boolean(conflict || restoringVersionId),
  });

  async function restore(version: NoteVersion) {
    if (!restoreAllowed || historyBaseVersion === null) return;
    const ownerAtStart = ownerKey;
    const pendingRequest = {
      identity: routeIdentityRef.current,
      requestId: ++restoreRequestRef.current,
    };
    const baseVersion = historyBaseVersion;
    let restoreLease: SessionLease | null = null;
    setRestoringVersionId(version.id);
    setHistoryError(null);
    setRestoreNotice(null);
    try {
      const { lease, value } = await authenticatedRequest((api, requestLease) => {
        restoreLease = requestLease;
        return api.restoreVersion(id, {
          versionId: version.id,
          baseVersion,
          preserveCurrentFolderIfUnknown: !version.folderSnapshotKnown,
        });
      });
      await updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: { ...current.notes, [id]: value.note },
      }));
      assertCurrentSession(lease);
      if (
        !requestStillCurrent(pendingRequest, routeIdentityRef.current, restoreRequestRef.current)
      ) {
        return;
      }
      setTagsText(value.note.tags.join(', '));
      setRestoreNotice(
        value.folderRestored
          ? null
          : 'This legacy version restored its content and tags while keeping the current folder.',
      );
      setVersions(null);
      setHistoryBaseVersion(null);
      setRestoreProtocolVersion(null);
    } catch (error) {
      const currentRoute =
        requestStillCurrent(pendingRequest, routeIdentityRef.current, restoreRequestRef.current) &&
        store$.activeOwnerKey.get() === ownerAtStart;
      const failureKind = classifyMutationFailure(error);
      if (restoreLease && isCurrentSession(restoreLease) && failureKind === 'unconfirmed') {
        setStatusForLease(restoreLease, 'error');
      }
      if (currentRoute) {
        if (failureKind === 'conflict') {
          setVersions(null);
          setHistoryBaseVersion(null);
          setRestoreProtocolVersion(null);
          setHistoryError('This note changed after history was loaded. Sync and reopen history.');
          void sync();
        } else if (failureKind === 'confirmed-rejection') {
          setHistoryError('The server rejected that restore. The note was not changed.');
        } else {
          setHistoryError(
            'Iris could not confirm whether the restore completed. Sync before editing or retrying.',
          );
          void sync();
        }
      }
    } finally {
      if (
        requestStillCurrent(pendingRequest, routeIdentityRef.current, restoreRequestRef.current)
      ) {
        setRestoringVersionId(null);
      }
    }
  }

  function closeHistory() {
    historyRequestRef.current += 1;
    setVersions(null);
    setHistoryBaseVersion(null);
    setRestoreProtocolVersion(null);
  }

  function onDelete() {
    if (deleteNoteLocal(id)) router.back();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: theme.space(4) }}>
      {conflict ? (
        <View style={styles.conflict}>
          <Text style={styles.conflictTitle}>This note changed elsewhere</Text>
          <Text style={styles.conflictText}>
            Your draft is retained in this account. Review it, then choose which version to keep.
          </Text>
          <Text style={styles.conflictPreview}>
            {conflict.localMutation.type === 'delete'
              ? 'Your pending change deleted this note.'
              : (conflict.localMutation.note.title || 'Untitled') +
                '\n' +
                conflict.localMutation.note.bodyMd.slice(0, 240)}
          </Text>
          <View style={styles.conflictActions}>
            <Button
              label="Keep my edit"
              onPress={() => {
                if (ownerKey) {
                  keepLocalConflict(ownerKey, id, conflict.localMutation.opId);
                }
              }}
            />
            <Button
              label="Use server"
              variant="ghost"
              onPress={() => {
                if (ownerKey) {
                  useServerConflict(ownerKey, id, conflict.localMutation.opId);
                }
              }}
            />
          </View>
        </View>
      ) : null}

      <TextInput
        style={styles.title}
        placeholder="Title"
        placeholderTextColor={theme.colors.textDim}
        value={note.title}
        onChangeText={(t) => updateNoteLocal(id, { title: t })}
        editable={!conflict}
      />
      <Text style={styles.meta}>
        v{note.version}
        {note.version === 0 ? ' (unsynced)' : ''} · Markdown
      </Text>

      <TextInput
        style={styles.tags}
        placeholder="tags, comma, separated"
        placeholderTextColor={theme.colors.textDim}
        value={tagsText}
        onChangeText={setTagsText}
        onBlur={commitTags}
        onSubmitEditing={commitTags}
        autoCapitalize="none"
        editable={!conflict}
      />

      {/* The editor is a plain view over Markdown — no proprietary block tree (pillar #1). */}
      <TextInput
        style={styles.body}
        placeholder={'# Start writing\n\nMarkdown is the storage format.'}
        placeholderTextColor={theme.colors.textDim}
        value={note.bodyMd}
        onChangeText={(t) => updateNoteLocal(id, { bodyMd: t })}
        multiline
        textAlignVertical="top"
        editable={!conflict}
      />

      <View style={styles.actions}>
        <Button
          label={versions ? 'Hide history' : 'View history'}
          variant="ghost"
          disabled={Boolean(conflict)}
          onPress={() => (versions ? closeHistory() : loadHistory())}
        />
        <Button
          label="Delete note"
          variant="danger"
          disabled={Boolean(conflict)}
          onPress={onDelete}
        />
      </View>
      {historyError ? (
        <Text
          style={styles.historyWarning}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {historyError}
        </Text>
      ) : null}
      {restoreNotice ? (
        <Text
          style={styles.historyWarning}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
        >
          {restoreNotice}
        </Text>
      ) : null}

      {versions ? (
        <View style={styles.history}>
          <Text style={styles.historyTitle}>Version history</Text>
          {restoreProtocolVersion !== null && restoreProtocolVersion !== 1 ? (
            <Text style={styles.historyWarning} accessibilityRole="alert">
              This client can show history but does not support the server's restore protocol.
              Update Iris before restoring.
            </Text>
          ) : null}
          {historyHeadMismatch ? (
            <Text style={styles.historyWarning} accessibilityRole="alert">
              The local note and loaded history are on different heads. Iris is syncing; reopen
              history if they do not converge.
            </Text>
          ) : null}
          {versions.length === 0 ? <Muted>No history yet.</Muted> : null}
          {versions.map((v) => (
            <View key={v.id} style={styles.versionRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.versionText}>
                  v{v.version} · {v.authorType === 'agent' ? '🤖 ' : ''}
                  {v.authorName}
                </Text>
                <Text style={styles.versionMeta}>{new Date(v.createdAt).toLocaleString()}</Text>
                <Text style={styles.versionMeta}>
                  {v.folderSnapshotKnown
                    ? `Folder: ${v.folder === null ? 'Root' : v.folder}`
                    : 'Folder was not captured; restore keeps the current folder'}
                  {` · Tags: ${v.tags.length > 0 ? v.tags.join(', ') : 'None'}`}
                </Text>
              </View>
              <Button
                label={v.folderSnapshotKnown ? 'Restore' : 'Restore content'}
                variant="ghost"
                loading={restoringVersionId === v.id}
                disabled={!restoreAllowed}
                accessibilityLabel={`${v.folderSnapshotKnown ? 'Restore' : 'Restore content from'} version ${v.version}`}
                onPress={() => restore(v)}
              />
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  conflict: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.danger,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(3),
  },
  conflictTitle: { color: theme.colors.danger, fontSize: 15, fontWeight: '700' },
  conflictText: { color: theme.colors.text, fontSize: 13, marginTop: theme.space(1) },
  conflictPreview: {
    color: theme.colors.textDim,
    fontSize: 12,
    marginTop: theme.space(2),
    padding: theme.space(2),
    backgroundColor: theme.colors.bg,
    borderRadius: theme.radius,
  },
  conflictActions: {
    flexDirection: 'row',
    gap: theme.space(2),
    marginTop: theme.space(2),
  },
  title: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: '700',
    paddingVertical: theme.space(2),
  },
  meta: { color: theme.colors.textDim, fontSize: 12, marginBottom: theme.space(3) },
  tags: {
    color: theme.colors.accent,
    fontSize: 14,
    paddingVertical: theme.space(2),
    marginBottom: theme.space(2),
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
  },
  body: {
    color: theme.colors.text,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 280,
    fontFamily: undefined,
  },
  actions: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(4) },
  history: { marginTop: theme.space(4) },
  historyTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: theme.space(2),
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  versionText: { color: theme.colors.text, fontSize: 14 },
  versionMeta: { color: theme.colors.textDim, fontSize: 12 },
  historyWarning: {
    color: theme.colors.accent,
    fontSize: 12,
    marginTop: theme.space(2),
  },
});
