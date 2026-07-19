import { useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { Note } from '@iris/shared';
import { Button, Muted, RecoveryNotice, Screen } from '../../../src/components/ui';
import { useObs } from '../../../src/state/hooks';
import {
  assertCurrentSession,
  replicaMutationsBlocked,
  selectTags,
  selectVisibleNotes,
  store$,
} from '../../../src/state/store';
import { createNoteLocal, recoverSyncIssue } from '../../../src/sync/manager';
import { authenticatedRequest } from '../../../src/api';
import { theme } from '../../../src/theme';

export default function NotesList() {
  const allNotes = useObs(selectVisibleNotes);
  const tags = useObs(selectTags);
  const status = useObs(() => store$.status.get());
  const recoveryRequired = status === 'recovery-required';
  const authorityBlocked = useObs(replicaMutationsBlocked);
  const actionsBlocked = recoveryRequired || authorityBlocked;
  const gated = useObs(() => store$.syncGated.get());
  const pending = useObs(() => store$.outbox.get().length);
  const syncIssue = useObs(() => store$.syncIssue.get());
  const conflictMap = useObs(() => store$.conflicts.get());
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const conflicts = new Set(Object.keys(conflictMap));

  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [results, setResults] = useState<Note[] | null>(null); // null = not searching
  const [searchOwnerKey, setSearchOwnerKey] = useState(ownerKey);
  const [recoveringSync, setRecoveringSync] = useState(false);

  useEffect(() => {
    setQuery('');
    setActiveTag(null);
    setResults(null);
    setSearchOwnerKey(ownerKey);
    setRecoveringSync(false);
  }, [ownerKey]);

  // Debounced full-text search against the server, with an offline local fallback.
  useEffect(() => {
    if (searchOwnerKey !== ownerKey) return;
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const ownerAtStart = ownerKey;
    const handle = setTimeout(async () => {
      try {
        const { lease, value } = await authenticatedRequest((api) => api.searchNotes(q));
        assertCurrentSession(lease);
        setResults(value.results.map((result) => result.note));
      } catch {
        if (store$.activeOwnerKey.get() !== ownerAtStart) return;
        const lc = q.toLowerCase();
        setResults(
          selectVisibleNotes().filter((n) => `${n.title} ${n.bodyMd}`.toLowerCase().includes(lc)),
        );
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [ownerKey, query, searchOwnerKey]);

  const searching = results !== null;
  const shown = searching
    ? results!
    : activeTag
      ? allNotes.filter((n) => n.tags.includes(activeTag))
      : allNotes;

  function onNew() {
    if (actionsBlocked) return;
    const note = createNoteLocal({ title: '', bodyMd: '', tags: activeTag ? [activeTag] : [] });
    router.push(`/notes/${note.id}`);
  }

  async function onRecoverSync() {
    if (actionsBlocked) return;
    setRecoveringSync(true);
    try {
      await recoverSyncIssue();
    } finally {
      setRecoveringSync(false);
    }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.count}>Notes</Text>
        <Text style={styles.sync}>
          {recoveryRequired
            ? 'local recovery required'
            : authorityBlocked
              ? 'view only'
              : gated
                ? '🔒 sync gated'
                : status === 'syncing'
                  ? 'syncing…'
                  : status === 'offline'
                    ? 'offline'
                    : status === 'error'
                      ? 'sync error'
                      : status === 'auth-required'
                        ? 'sign in required'
                        : 'synced'}
          {pending > 0 ? ` · ${pending} pending` : ''}
          {conflicts.size > 0 ? ` · ${conflicts.size} conflicts` : ''}
        </Text>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search notes…"
        placeholderTextColor={theme.colors.textDim}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        returnKeyType="search"
      />

      {!searching && tags.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chips}
          contentContainerStyle={{ gap: theme.space(2) }}
        >
          {tags.map(({ tag, count }) => {
            const on = activeTag === tag;
            return (
              <Pressable
                key={tag}
                onPress={() => setActiveTag(on ? null : tag)}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  #{tag} {count}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {recoveryRequired ? <RecoveryNotice /> : null}

      {syncIssue ? (
        <View style={styles.issueBanner}>
          <Text style={styles.issueTitle}>Sync needs your attention</Text>
          <Text style={styles.issueMessage}>{syncIssue.message}</Text>
          <Button
            label={
              syncIssue.recoveryKind === 'rekey'
                ? 'Use new operation ID'
                : syncIssue.recoveryKind === 'reset-cursor'
                  ? 'Reset sync cursor'
                  : syncIssue.recoveryKind === 'restage'
                    ? 'Restage changes'
                    : 'Retry sync'
            }
            onPress={() => void onRecoverSync()}
            variant="ghost"
            loading={recoveringSync}
            disabled={actionsBlocked}
          />
        </View>
      ) : null}

      {gated && !actionsBlocked ? (
        <Text style={styles.gateBanner}>
          You&apos;re editing locally. Subscribe to Iris Sync (Settings) to sync this device.
        </Text>
      ) : null}

      <FlatList
        data={shown}
        keyExtractor={(n) => n.id}
        ItemSeparatorComponent={() => <View style={{ height: theme.space(2) }} />}
        ListEmptyComponent={
          <Muted>
            {searching
              ? 'No matches.'
              : activeTag
                ? `No notes tagged #${activeTag}.`
                : 'No notes yet. Tap “New note”.'}
          </Muted>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, conflicts.has(item.id) && styles.rowConflict]}
            onPress={() => router.push(`/notes/${item.id}`)}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title || 'Untitled'}
            </Text>
            <Text style={styles.rowPreview} numberOfLines={2}>
              {item.bodyMd || 'No content'}
            </Text>
            <Text style={styles.rowMeta}>
              {conflicts.has(item.id) ? '⚠ needs review · ' : ''}
              {item.tags.length ? item.tags.map((t) => `#${t}`).join(' ') + ' · ' : ''}
              {item.folder ? `${item.folder} · ` : ''}v{item.version}
              {item.version === 0 ? ' (unsynced)' : ''}
            </Text>
          </Pressable>
        )}
        contentContainerStyle={{ paddingBottom: theme.space(20) }}
      />

      <View style={styles.footer}>
        <Button label="＋ New note" onPress={onNew} disabled={actionsBlocked} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.space(2),
  },
  count: { color: theme.colors.text, fontSize: 22, fontWeight: '700' },
  sync: { color: theme.colors.textDim, fontSize: 13 },
  search: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    color: theme.colors.text,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    fontSize: 15,
    marginBottom: theme.space(2),
  },
  chips: { marginBottom: theme.space(2), maxHeight: 40 },
  chip: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
    height: 32,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: theme.colors.accentDim, borderColor: theme.colors.accent },
  chipText: { color: theme.colors.textDim, fontSize: 13 },
  chipTextOn: { color: theme.colors.text },
  gateBanner: {
    color: theme.colors.accent,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(3),
    fontSize: 13,
  },
  issueBanner: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.danger,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(3),
  },
  issueTitle: {
    color: theme.colors.danger,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: theme.space(1),
  },
  issueMessage: {
    color: theme.colors.text,
    fontSize: 13,
    marginBottom: theme.space(2),
  },
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(4),
  },
  rowConflict: { borderColor: theme.colors.danger },
  rowTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
  rowPreview: { color: theme.colors.textDim, fontSize: 14, marginTop: theme.space(1) },
  rowMeta: { color: theme.colors.textDim, fontSize: 12, marginTop: theme.space(2) },
  footer: {
    position: 'absolute',
    left: theme.space(4),
    right: theme.space(4),
    bottom: theme.space(4),
  },
});
