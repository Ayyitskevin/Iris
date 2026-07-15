import { useEffect, useState } from 'react';
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
import { theme } from '../../../src/theme';

export default function NoteEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = useObs(() => (id ? store$.notes[id].get() : undefined));
  const conflict = useObs(() => (id ? store$.conflicts.get()[id] : undefined));
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [tagsText, setTagsText] = useState('');

  useEffect(() => {
    // Best-effort: pull the latest server state for this note when opening.
    void sync();
  }, [id]);

  // Seed the tags input once the note is available (keyed on note id, not tags, so
  // the field doesn't fight the user's typing).
  useEffect(() => {
    // Seed only when the note identity changes, not on every tag edit.
    if (note) setTagsText(note.tags.join(', '));
    setVersions(null);
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
    try {
      const { lease, value } = await authenticatedRequest((api) => api.listVersions(id));
      assertCurrentSession(lease);
      setVersions(value.versions);
    } catch {
      if (store$.activeOwnerKey.get() === ownerAtStart) setVersions([]);
    }
  }

  async function restore(versionId: string) {
    if (conflict) return;
    let restoreLease: SessionLease | null = null;
    try {
      const { lease, value } = await authenticatedRequest((api) =>
        api.restoreVersion(id, { versionId }),
      );
      restoreLease = lease;
      await updateReplicaForLease(lease, (current) => ({
        ...current,
        notes: { ...current.notes, [id]: value.note },
      }));
      assertCurrentSession(lease);
      setVersions(null);
    } catch {
      if (restoreLease && isCurrentSession(restoreLease)) {
        setStatusForLease(restoreLease, 'error');
      }
    }
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
          onPress={() => (versions ? setVersions(null) : loadHistory())}
        />
        <Button
          label="Delete note"
          variant="danger"
          disabled={Boolean(conflict)}
          onPress={onDelete}
        />
      </View>

      {versions ? (
        <View style={styles.history}>
          <Text style={styles.historyTitle}>Version history</Text>
          {versions.length === 0 ? <Muted>No history yet.</Muted> : null}
          {versions.map((v) => (
            <View key={v.id} style={styles.versionRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.versionText}>
                  v{v.version} · {v.authorType === 'agent' ? '🤖 ' : ''}
                  {v.authorName}
                </Text>
                <Text style={styles.versionMeta}>{new Date(v.createdAt).toLocaleString()}</Text>
              </View>
              <Button
                label="Restore"
                variant="ghost"
                disabled={Boolean(conflict)}
                onPress={() => restore(v.id)}
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
});
