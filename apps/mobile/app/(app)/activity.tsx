import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ActivityEntry } from '@iris/shared';
import { Button, Muted, Screen, Title } from '../../src/components/ui';
import { api } from '../../src/api';
import { sync } from '../../src/sync/manager';
import { theme } from '../../src/theme';

const ACTION_LABEL: Record<string, string> = {
  'note.create': 'created a note',
  'note.update': 'edited a note',
  'note.delete': 'deleted a note',
  'note.restore': 'restored a version',
  'note.undo': 'undid an action',
};

export default function Activity() {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listActivity();
      setItems(res.activity);
    } catch {
      // offline — keep last feed
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function undo(entry: ActivityEntry) {
    try {
      await api.undoActivity(entry.id);
      await load();
      void sync();
    } catch {
      // surfaced by reload
    }
  }

  return (
    <Screen>
      <Title>Activity</Title>
      <Muted>Everything your agents and you have done. Undo any of it.</Muted>
      <FlatList
        style={{ marginTop: theme.space(3) }}
        data={items}
        keyExtractor={(a) => a.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.colors.accent} />}
        ItemSeparatorComponent={() => <View style={{ height: theme.space(2) }} />}
        ListEmptyComponent={<Muted>No activity yet.</Muted>}
        renderItem={({ item }) => {
          const isAgent = item.actorType === 'agent';
          const undoable = item.action !== 'note.undo' && !item.undone;
          return (
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={[styles.actor, { color: isAgent ? theme.colors.agent : theme.colors.text }]}>
                  {isAgent ? '🤖 ' : '🧑 '}
                  {item.actorName}
                </Text>
                <Text style={styles.action}>
                  {ACTION_LABEL[item.action] ?? item.action}
                  {item.resultingVersion ? ` → v${item.resultingVersion}` : ''}
                </Text>
                <Text style={styles.time}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
              {undoable ? (
                <Button label="Undo" variant="ghost" onPress={() => undo(item)} />
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
