import { FlatList, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { SyncMutation } from '@iris/shared';
import { Button, Card, Muted, Screen, Title } from '../../src/components/ui';
import { useObs } from '../../src/state/hooks';
import { store$ } from '../../src/state/store';
import { keepLocalConflict, useServerConflict } from '../../src/sync/manager';
import { theme } from '../../src/theme';

function draftPreview(mutation: SyncMutation): string {
  if (mutation.type === 'delete') return 'Delete this note';
  return mutation.note.bodyMd || 'No content';
}

export default function ConflictInbox() {
  const conflictMap = useObs(() => store$.conflicts.get());
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const conflicts = Object.values(conflictMap).sort((a, b) =>
    a.detectedAt < b.detectedAt ? 1 : -1,
  );

  return (
    <Screen>
      <Title>Conflict Inbox</Title>
      <Muted>
        {conflicts.length === 0
          ? 'All clear. Iris has no drafts waiting for review.'
          : conflicts.length +
            (conflicts.length === 1 ? ' draft needs' : ' drafts need') +
            ' your decision. Both versions stay in this account until you choose.'}
      </Muted>

      <FlatList
        style={styles.list}
        contentContainerStyle={{ paddingBottom: theme.space(8) }}
        data={conflicts}
        keyExtractor={(conflict) => conflict.noteId}
        ListEmptyComponent={
          <Card style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Nothing to reconcile</Text>
            <Muted>New conflicts will appear here and on the affected note.</Muted>
          </Card>
        }
        renderItem={({ item }) => (
          <Card style={styles.conflictCard}>
            <View style={styles.heading}>
              <Text style={styles.noteTitle}>{item.serverNote.title || 'Untitled'}</Text>
              <Text style={styles.time}>{new Date(item.detectedAt).toLocaleString()}</Text>
            </View>

            <View style={styles.versionPanel}>
              <Text style={styles.versionLabel}>YOUR LOCAL DRAFT</Text>
              <Text style={styles.versionTitle}>
                {item.localMutation.type === 'delete'
                  ? 'Pending deletion'
                  : item.localMutation.note.title || 'Untitled'}
              </Text>
              <Text style={styles.preview} numberOfLines={6}>
                {draftPreview(item.localMutation)}
              </Text>
            </View>

            <View style={styles.versionPanel}>
              <Text style={styles.versionLabel}>SERVER VERSION · V{item.serverNote.version}</Text>
              <Text style={styles.versionTitle}>{item.serverNote.title || 'Untitled'}</Text>
              <Text style={styles.preview} numberOfLines={6}>
                {item.serverNote.bodyMd || 'No content'}
              </Text>
            </View>

            <Button
              label="Keep my edit"
              onPress={() => {
                if (ownerKey) {
                  keepLocalConflict(ownerKey, item.noteId, item.localMutation.opId);
                }
              }}
            />
            <Button
              label="Use server version"
              variant="ghost"
              onPress={() => {
                if (ownerKey) {
                  useServerConflict(ownerKey, item.noteId, item.localMutation.opId);
                }
              }}
            />
            <Button
              label="Open note"
              variant="ghost"
              onPress={() => router.push('/notes/' + item.noteId)}
            />
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: theme.space(3) },
  conflictCard: { borderColor: theme.colors.danger },
  emptyCard: { marginTop: theme.space(2) },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: theme.space(1),
  },
  heading: { marginBottom: theme.space(3) },
  noteTitle: { color: theme.colors.text, fontSize: 18, fontWeight: '700' },
  time: { color: theme.colors.textDim, fontSize: 11, marginTop: theme.space(1) },
  versionPanel: {
    backgroundColor: theme.colors.bg,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(2),
  },
  versionLabel: { color: theme.colors.accent, fontSize: 11, fontWeight: '700' },
  versionTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '600',
    marginTop: theme.space(1),
  },
  preview: {
    color: theme.colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: theme.space(1),
  },
});
