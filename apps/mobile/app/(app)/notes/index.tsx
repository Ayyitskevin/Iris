import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Muted, Screen } from '../../../src/components/ui';
import { useObs } from '../../../src/state/hooks';
import { selectVisibleNotes, store$ } from '../../../src/state/store';
import { createNoteLocal } from '../../../src/sync/manager';
import { theme } from '../../../src/theme';

export default function NotesList() {
  const notes = useObs(selectVisibleNotes);
  const status = useObs(() => store$.status.get());
  const gated = useObs(() => store$.syncGated.get());
  const pending = useObs(() => store$.outbox.get().length);

  function onNew() {
    const note = createNoteLocal({ title: '', bodyMd: '' });
    router.push(`/notes/${note.id}`);
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.count}>
          {notes.length} note{notes.length === 1 ? '' : 's'}
        </Text>
        <Text style={styles.sync}>
          {gated ? '🔒 sync gated' : status === 'syncing' ? 'syncing…' : status === 'offline' ? 'offline' : 'synced'}
          {pending > 0 ? ` · ${pending} pending` : ''}
        </Text>
      </View>

      {gated ? (
        <Text style={styles.gateBanner}>
          You&apos;re editing locally. Subscribe to Iris Sync (Settings) to sync this device.
        </Text>
      ) : null}

      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        ItemSeparatorComponent={() => <View style={{ height: theme.space(2) }} />}
        ListEmptyComponent={<Muted>No notes yet. Tap “New note” to capture something.</Muted>}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/notes/${item.id}`)}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title || 'Untitled'}
            </Text>
            <Text style={styles.rowPreview} numberOfLines={2}>
              {item.bodyMd || 'No content'}
            </Text>
            <Text style={styles.rowMeta}>
              {item.folder ? `${item.folder} · ` : ''}v{item.version}
              {item.version === 0 ? ' (unsynced)' : ''}
            </Text>
          </Pressable>
        )}
        contentContainerStyle={{ paddingBottom: theme.space(20) }}
      />

      <View style={styles.footer}>
        <Button label="＋ New note" onPress={onNew} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.space(3) },
  count: { color: theme.colors.text, fontSize: 20, fontWeight: '700' },
  sync: { color: theme.colors.textDim, fontSize: 13 },
  gateBanner: {
    color: theme.colors.accent,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(3),
    fontSize: 13,
  },
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(4),
  },
  rowTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
  rowPreview: { color: theme.colors.textDim, fontSize: 14, marginTop: theme.space(1) },
  rowMeta: { color: theme.colors.textDim, fontSize: 12, marginTop: theme.space(2) },
  footer: { position: 'absolute', left: theme.space(4), right: theme.space(4), bottom: theme.space(4) },
});
