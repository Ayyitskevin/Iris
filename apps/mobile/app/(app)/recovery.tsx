import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Button, Card, Muted, RecoveryNotice, Screen, Title } from '../../src/components/ui';
import {
  deliverReplicaRecoveryExport,
  type RecoveryExportDeliveryResult,
} from '../../src/recovery/export-sink';
import { useObs } from '../../src/state/hooks';
import type {
  ReplicaRecoveryCatalog,
  ReplicaRecoveryCatalogCopy,
} from '../../src/state/replica-recovery-catalog';
import type { ReplicaRecoveryReason } from '../../src/state/replica-recovery-journal';
import {
  createReplicaRecoveryExportForLease,
  isCurrentRecoveryInspectionLease,
  isCurrentReplicaRecoveryExportArtifact,
  openRecoveryInspectionLease,
  readReplicaRecoveryCatalogForLease,
  recoveryCatalogRevision$,
  StaleSessionError,
  StaleRecoveryInspectionError,
  store$,
  type ReplicaRecoveryExportArtifact,
} from '../../src/state/store';
import { theme } from '../../src/theme';

const reasonLabels = {
  'stale-writer': 'A save was superseded by another local writer.',
  'session-departure': 'Preserved while leaving this account.',
  'session-rejected': 'Preserved after this session was rejected.',
  'promotion-baseline': 'Baseline preserved before transactional promotion.',
  'legacy-divergence': 'Changed legacy branch detected.',
  'primary-divergence': 'Transactional primary branch preserved after divergence.',
} as const satisfies Readonly<Record<ReplicaRecoveryReason, string>>;

function copyTitle(copy: ReplicaRecoveryCatalogCopy): string {
  if (copy.persistence === 'journal-verified') return `Preserved copy #${copy.sequence}`;
  if (copy.persistence === 'memory-only') {
    return `Memory-only copy ${copy.key.split(':')[1] ?? ''}`.trim();
  }
  return 'Currently displayed copy';
}

function persistenceLabel(copy: ReplicaRecoveryCatalogCopy): string {
  if (copy.persistence === 'journal-verified') return 'Verified in local recovery storage';
  if (copy.persistence === 'memory-only') return 'In memory only — keep Iris open';
  return 'Displayed in Iris, not part of the recovery journal';
}

function nativeTemporaryFileMessage(staleCacheCleanupFailed: boolean): string {
  return (
    "A temporary recovery file remains in Iris's private cache. It is not a durable backup. " +
    'Iris attempts cleanup after it is 24 hours old on a later launch or export, and cleanup ' +
    'failure may leave it longer.' +
    (staleCacheCleanupFailed
      ? ' Iris could not clean older temporary recovery files during this attempt.'
      : '')
  );
}

function recoveryDeliveryFromError(error: unknown): RecoveryExportDeliveryResult | null {
  if (!error || typeof error !== 'object' || !('delivery' in error)) return null;
  const delivery = (error as { delivery?: unknown }).delivery;
  if (!delivery || typeof delivery !== 'object' || !('kind' in delivery)) return null;
  if ((delivery as { kind?: unknown }).kind === 'download-requested') {
    return { kind: 'download-requested' };
  }
  return null;
}

export default function RecoveryCenter() {
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const recoveryRequired = useObs(() => store$.status.get() === 'recovery-required');
  const catalogRevision = useObs(() => recoveryCatalogRevision$.get());
  const [catalog, setCatalog] = useState<ReplicaRecoveryCatalog | null>();
  const [loadError, setLoadError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const requestId = useRef(0);
  const lastCatalogRevision = useRef(catalogRevision);

  useEffect(() => {
    requestId.current += 1;
    setCatalog(undefined);
    setLoadError(false);
    setExporting(false);
    setExportMessage('');
    setExportError(false);
    setExpanded({});
    lastCatalogRevision.current = recoveryCatalogRevision$.get();
  }, [ownerKey]);

  const loadCatalog = useCallback(
    async (preserveExportMessage = false, keepCatalog = false) => {
      const request = ++requestId.current;
      if (!keepCatalog) setCatalog(undefined);
      setLoadError(false);
      if (!preserveExportMessage) {
        setExportMessage('');
        setExportError(false);
      }
      const lease = openRecoveryInspectionLease();
      if (!lease) {
        if (requestId.current === request) {
          setLoadError(true);
          setCatalog(undefined);
        }
        return;
      }
      try {
        const result = await readReplicaRecoveryCatalogForLease(lease);
        if (requestId.current !== request || !isCurrentRecoveryInspectionLease(lease)) return;
        setCatalog(result);
      } catch {
        if (requestId.current === request && store$.activeOwnerKey.get() === ownerKey) {
          setLoadError(true);
          setCatalog(undefined);
        }
      }
    },
    [ownerKey],
  );

  useEffect(() => {
    if (lastCatalogRevision.current === catalogRevision || exporting) return;
    lastCatalogRevision.current = catalogRevision;
    void loadCatalog(true, true);
  }, [catalogRevision, exporting, loadCatalog]);

  useEffect(() => {
    if (!exportMessage || Platform.OS !== 'ios') return;
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (active && enabled) AccessibilityInfo.announceForAccessibility(exportMessage);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [exportMessage]);

  useFocusEffect(
    useCallback(() => {
      void loadCatalog();
      return () => {
        requestId.current += 1;
      };
    }, [loadCatalog]),
  );

  const exportCopies = useCallback(async () => {
    const request = ++requestId.current;
    const lease = openRecoveryInspectionLease();
    let artifact: ReplicaRecoveryExportArtifact | null = null;
    let delivery: RecoveryExportDeliveryResult | null = null;
    if (!lease) {
      setExportError(true);
      setExportMessage('The active account changed. Reopen Recovery Center and try again.');
      return;
    }
    const guard = () => {
      if (requestId.current !== request || !isCurrentRecoveryInspectionLease(lease)) {
        throw new StaleSessionError();
      }
      if (artifact && !isCurrentReplicaRecoveryExportArtifact(lease, artifact)) {
        throw new StaleRecoveryInspectionError();
      }
    };
    setExporting(true);
    setExportMessage('');
    setExportError(false);
    try {
      const completedArtifact = await createReplicaRecoveryExportForLease(lease);
      artifact = completedArtifact;
      guard();
      delivery = await deliverReplicaRecoveryExport(
        completedArtifact.serializedExport,
        completedArtifact.fileName,
        guard,
      );
      guard();
      setCatalog(completedArtifact.catalog);
      if (delivery.kind === 'download-requested') {
        setExportMessage('Download requested. Confirm the file was saved before closing Iris.');
      } else {
        setExportMessage(
          'Share sheet closed. Iris cannot confirm a destination file. ' +
            nativeTemporaryFileMessage(delivery.staleCacheCleanupFailed),
        );
      }
    } catch (error) {
      if (requestId.current === request && store$.activeOwnerKey.get() === ownerKey) {
        setExportError(true);
        const message =
          error instanceof Error ? error.message : 'Recovery export could not be completed.';
        const observedDelivery = delivery ?? recoveryDeliveryFromError(error);
        setExportMessage(
          observedDelivery?.kind === 'share-sheet-closed'
            ? `${message} The native share handoff already occurred. ${nativeTemporaryFileMessage(observedDelivery.staleCacheCleanupFailed)}`
            : observedDelivery?.kind === 'download-requested'
              ? `${message} The browser download was already requested; confirm whether its earlier snapshot was saved.`
              : message,
        );
      }
    } finally {
      if (requestId.current === request && store$.activeOwnerKey.get() === ownerKey) {
        setExporting(false);
      }
    }
  }, [ownerKey]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.back}>
          <Button label="Back" variant="ghost" onPress={() => router.back()} />
        </View>
        <Title>Recovery Center</Title>
        <Muted>
          Inspect and export local copies. This screen cannot select, merge, restore, discard, or
          delete a copy.
        </Muted>
        {recoveryRequired ? <RecoveryNotice /> : null}

        {loadError ? (
          <Card style={styles.errorCard}>
            <View accessibilityRole="alert">
              <Text accessibilityRole="header" style={styles.cardTitle}>
                Recovery storage could not be verified
              </Text>
              <Muted>
                Iris did not normalize, overwrite, or delete it. Retry after storage recovers.
              </Muted>
            </View>
            <View style={styles.gap} />
            <Button label="Retry" variant="ghost" onPress={() => void loadCatalog()} />
          </Card>
        ) : catalog === undefined ? (
          <Card>
            <Text accessibilityRole="header" style={styles.cardTitle}>
              Checking local copies…
            </Text>
          </Card>
        ) : catalog === null ? (
          <Card>
            <Text accessibilityRole="header" style={styles.cardTitle}>
              No preserved copies
            </Text>
            <Muted>Iris has no verified or memory-only recovery branches for this account.</Muted>
          </Card>
        ) : (
          <>
            <Card style={recoveryRequired ? styles.attentionCard : undefined}>
              <Text accessibilityRole="header" style={styles.cardTitle}>
                {catalog.copies.length} local {catalog.copies.length === 1 ? 'branch' : 'branches'}{' '}
                shown
              </Text>
              <Muted>
                {catalog.preservedCount} {catalog.preservedCount === 1 ? 'copy is' : 'copies are'}{' '}
                preserved in recovery storage or memory. Journal numbers are capture sequence only.
                A displayed match does not mean newer, preferred, or more complete.
              </Muted>
              {!catalog.inventoryComplete ? (
                <Text accessibilityRole="alert" style={styles.warning}>
                  Partial inventory: durable recovery storage could not be read. Only current memory
                  candidates and the displayed projection are shown. Retry before treating this list
                  as complete.
                </Text>
              ) : null}
              {catalog.hasUnverifiedCopies ? (
                <Text accessibilityRole="alert" style={styles.warning}>
                  {catalog.memoryOnlyCount}{' '}
                  {catalog.memoryOnlyCount === 1 ? 'copy is' : 'copies are'} still memory-only. Keep
                  Iris open; export will first try to verify{' '}
                  {catalog.memoryOnlyCount === 1 ? 'it' : 'them'} in local recovery storage.
                </Text>
              ) : null}
            </Card>

            {catalog.copies.map((copy) => {
              const isExpanded = Boolean(expanded[copy.key]);
              return (
                <Card key={copy.key}>
                  <Text accessibilityRole="header" style={styles.copyTitle}>
                    {copyTitle(copy)}
                  </Text>
                  <Text style={styles.persistence}>{persistenceLabel(copy)}</Text>
                  {copy.persistence === 'displayed-only' ? (
                    <Text style={styles.match}>Exact copy shown in Iris now</Text>
                  ) : copy.matchesDisplayedProjection ? (
                    <Text style={styles.match}>Same local data as the copy shown in Iris now</Text>
                  ) : null}
                  {copy.reason ? (
                    <Text style={styles.meta}>{reasonLabels[copy.reason]}</Text>
                  ) : null}
                  {copy.capturedAt ? (
                    <Text style={styles.meta}>
                      Captured {new Date(copy.capturedAt).toLocaleString()}
                    </Text>
                  ) : null}
                  <Text style={styles.counts}>
                    {copy.liveNoteCount} live · {copy.deletedNoteCount} deleted · {copy.outboxCount}{' '}
                    queued · {copy.pendingPushCount} pending{' '}
                    {copy.pendingPushCount === 1 ? 'request' : 'requests'} · {copy.conflictCount}{' '}
                    {copy.conflictCount === 1 ? 'conflict' : 'conflicts'} ·{' '}
                    {copy.hasSyncIssue ? 'sync issue' : 'no sync issue'}
                  </Text>
                  <Button
                    label={isExpanded ? 'Hide note previews' : 'Show note previews'}
                    variant="ghost"
                    accessibilityLabel={`${isExpanded ? 'Hide' : 'Show'} note previews for ${copyTitle(copy)}`}
                    accessibilityState={{ expanded: isExpanded }}
                    onPress={() =>
                      setExpanded((current) => ({ ...current, [copy.key]: !isExpanded }))
                    }
                  />
                  {isExpanded ? (
                    <View style={styles.previews}>
                      {copy.notePreviews.length === 0 ? (
                        <Muted>No notes in this copy.</Muted>
                      ) : (
                        copy.notePreviews.map((preview) => (
                          <View key={preview.id} style={styles.preview}>
                            <Text style={styles.previewTitle}>
                              {preview.deleted ? '[Deleted] ' : ''}
                              {preview.title || 'Untitled'}
                            </Text>
                            {preview.body ? (
                              <Text style={styles.previewBody}>{preview.body}</Text>
                            ) : null}
                          </View>
                        ))
                      )}
                      {copy.omittedNotePreviewCount > 0 ? (
                        <Muted>{copy.omittedNotePreviewCount} more notes are not previewed.</Muted>
                      ) : null}
                    </View>
                  ) : null}
                </Card>
              );
            })}

            <Card>
              <Text accessibilityRole="header" style={styles.cardTitle}>
                Export all local copies
              </Text>
              <Muted>
                The JSON file contains exact note, queue, conflict, and recovery metadata for this
                account. It contains no session bearer. Keep it private. Import and restore are not
                available in this build. Iris first verifies every memory-only branch in recovery
                storage; if that cannot be completed, export stops instead of claiming an incomplete
                bundle.
              </Muted>
              <View style={styles.gap} />
              <Button
                label="Export all local copies (.json)"
                loading={exporting}
                disabled={catalog.preservedCount === 0}
                onPress={() => void exportCopies()}
              />
              {exportMessage ? (
                <Text
                  accessibilityLiveRegion={exportError ? 'assertive' : 'polite'}
                  accessibilityRole="alert"
                  style={styles.exportMessage}
                >
                  {exportMessage}
                </Text>
              ) : null}
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: theme.space(10) },
  back: { alignSelf: 'flex-start', marginBottom: theme.space(1) },
  cardTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: theme.space(2),
  },
  copyTitle: { color: theme.colors.text, fontSize: 16, fontWeight: '700' },
  persistence: { color: theme.colors.textDim, fontSize: 12, marginTop: theme.space(1) },
  match: { color: theme.colors.accent, fontSize: 13, fontWeight: '700', marginTop: theme.space(2) },
  meta: { color: theme.colors.textDim, fontSize: 13, marginTop: theme.space(1) },
  counts: { color: theme.colors.text, fontSize: 13, lineHeight: 20, marginTop: theme.space(2) },
  warning: { color: theme.colors.danger, fontSize: 13, marginTop: theme.space(3) },
  attentionCard: { borderColor: theme.colors.danger },
  errorCard: { borderColor: theme.colors.danger },
  gap: { height: theme.space(2) },
  previews: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    marginTop: theme.space(2),
    paddingTop: theme.space(2),
  },
  preview: { marginBottom: theme.space(2) },
  previewTitle: { color: theme.colors.text, fontSize: 13, fontWeight: '700' },
  previewBody: { color: theme.colors.textDim, fontSize: 12, lineHeight: 18 },
  exportMessage: { color: theme.colors.text, fontSize: 13, marginTop: theme.space(2) },
});
