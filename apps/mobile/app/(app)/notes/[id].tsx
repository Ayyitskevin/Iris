import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { NoteVersion } from '@iris/shared';
import { Button, Muted } from '../../../src/components/ui';
import { useObs } from '../../../src/state/hooks';
import { store$ } from '../../../src/state/store';
import { deleteNoteLocal, sync, updateNoteLocal } from '../../../src/sync/manager';
import { api } from '../../../src/api';
import { theme } from '../../../src/theme';

export default function NoteEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const note = useObs(() => (id ? store$.notes[id].get() : undefined));
  const conflict = useObs(() => store$.conflictNoteId.get() === id);
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);

  useEffect(() => {
    // Best-effort: pull the latest server state for this note when opening.
    void sync();
  }, [id]);

  if (!id || !note) {
    return (
      <View style={styles.container}>
        <Muted>Note not found.</Muted>
      </View>
    );
  }

  async function loadHistory() {
    try {
      const res = await api.listVersions(id);
      setVersions(res.versions);
    } catch {
      setVersions([]);
    }
  }

  async function restore(versionId: string) {
    try {
      const res = await api.restoreVersion(id, { versionId });
      store$.notes[id].set(res.note);
      store$.conflictNoteId.set(null);
      setVersions(null);
    } catch {
      // surfaced via status
    }
  }

  function onDelete() {
    deleteNoteLocal(id);
    router.back();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: theme.space(4) }}>
      {conflict ? (
        <Text style={styles.conflict}>
          This note changed elsewhere. The server version is shown below — re-apply your edit if needed.
        </Text>
      ) : null}

      <TextInput
        style={styles.title}
        placeholder="Title"
        placeholderTextColor={theme.colors.textDim}
        value={note.title}
        onChangeText={(t) => updateNoteLocal(id, { title: t })}
      />
      <Text style={styles.meta}>
        v{note.version}
        {note.version === 0 ? ' (unsynced)' : ''} · Markdown
      </Text>

      {/* The editor is a plain view over Markdown — no proprietary block tree (pillar #1). */}
      <TextInput
        style={styles.body}
        placeholder={'# Start writing\n\nMarkdown is the storage format.'}
        placeholderTextColor={theme.colors.textDim}
        value={note.bodyMd}
        onChangeText={(t) => updateNoteLocal(id, { bodyMd: t })}
        multiline
        textAlignVertical="top"
      />

      <View style={styles.actions}>
        <Button label={versions ? 'Hide history' : 'View history'} variant="ghost" onPress={() => (versions ? setVersions(null) : loadHistory())} />
        <Button label="Delete note" variant="danger" onPress={onDelete} />
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
              <Button label="Restore" variant="ghost" onPress={() => restore(v.id)} />
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
    color: theme.colors.danger,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(3),
  },
  title: { color: theme.colors.text, fontSize: 24, fontWeight: '700', paddingVertical: theme.space(2) },
  meta: { color: theme.colors.textDim, fontSize: 12, marginBottom: theme.space(3) },
  body: {
    color: theme.colors.text,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 280,
    fontFamily: undefined,
  },
  actions: { flexDirection: 'row', gap: theme.space(2), marginTop: theme.space(4) },
  history: { marginTop: theme.space(4) },
  historyTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '600', marginBottom: theme.space(2) },
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
