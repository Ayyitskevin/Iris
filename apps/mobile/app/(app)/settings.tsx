import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ApiRequestError, type AgentToken, type BillingStatus } from '@iris/shared';
import { Button, Card, Field, Muted, RecoveryNotice, Screen, Title } from '../../src/components/ui';
import { authenticatedRequest } from '../../src/api';
import { signOut } from '../../src/auth/session';
import { assertCurrentSession, store$ } from '../../src/state/store';
import { useObs } from '../../src/state/hooks';
import { theme } from '../../src/theme';

export default function Settings() {
  const email = useObs(() => store$.session.get()?.email ?? '');
  const ownerKey = useObs(() => store$.activeOwnerKey.get());
  const recoveryRequired = useObs(() => store$.status.get() === 'recovery-required');
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [newAgentName, setNewAgentName] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  useEffect(() => {
    setBilling(null);
    setTokens([]);
    setNewAgentName('');
    setIssuedToken(null);
    setSigningOut(false);
    setSignOutError(false);
  }, [ownerKey]);

  const load = useCallback(async () => {
    if (recoveryRequired) {
      setBilling(null);
      setTokens([]);
      return;
    }
    try {
      const { lease, value } = await authenticatedRequest((api) =>
        Promise.all([api.billingStatus(), api.listAgentTokens()]),
      );
      assertCurrentSession(lease);
      const [b, t] = value;
      setBilling(b);
      setTokens(t.tokens);
    } catch {
      // offline
    }
  }, [ownerKey, recoveryRequired]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function subscribe() {
    if (recoveryRequired) return;
    try {
      const { lease, value } = await authenticatedRequest((api) => api.createCheckout());
      assertCurrentSession(lease);
      await Linking.openURL(value.url);
      assertCurrentSession(lease);
    } catch {
      // ignore
    }
  }

  async function issueToken() {
    if (recoveryRequired) return;
    try {
      const { lease, value } = await authenticatedRequest((api) =>
        api.issueAgentToken({
          agentName: newAgentName.trim() || 'Agent',
          scopes: ['notes:read', 'notes:write'],
        }),
      );
      assertCurrentSession(lease);
      setIssuedToken(value.token);
      setNewAgentName('');
      await load();
    } catch {
      // ignore
    }
  }

  async function revoke(id: string) {
    if (recoveryRequired) return;
    try {
      const { lease } = await authenticatedRequest((api) => api.revokeAgentToken(id));
      assertCurrentSession(lease);
      await load();
    } catch {
      // ignore
    }
  }

  async function exportData() {
    if (recoveryRequired) return;
    try {
      const { lease, value: res } = await authenticatedRequest((api, currentLease) =>
        fetch(api.exportUrl(), {
          headers: { authorization: 'Bearer ' + currentLease.token },
          signal: currentLease.signal,
        }).then((response) => {
          if (!response.ok) {
            throw new ApiRequestError(
              response.status,
              'export_failed',
              'Export failed with ' + response.status,
            );
          }
          return response;
        }),
      );
      const blob = await res.blob();
      assertCurrentSession(lease);
      if (Platform.OS === 'web') {
        const g = globalThis as unknown as {
          URL: { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
          document: { createElement: (t: string) => any; body: any };
        };
        const url = g.URL.createObjectURL(blob);
        const a = g.document.createElement('a');
        a.href = url;
        a.download = 'iris-export.zip';
        a.click();
        g.URL.revokeObjectURL(url);
      }
    } catch {
      // ignore
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: theme.space(10) }}>
        <Title>Settings</Title>
        <Muted>{email}</Muted>
        {recoveryRequired ? <RecoveryNotice /> : null}

        <Card style={{ marginTop: theme.space(4) }}>
          <Text style={styles.cardTitle}>Sync plan</Text>
          {recoveryRequired ? (
            <Muted>Billing and device sync are unavailable while local recovery is active.</Muted>
          ) : billing ? (
            <>
              <Text style={styles.line}>
                Plan: <Text style={styles.strong}>{billing.plan}</Text> ({billing.status})
              </Text>
              <Text style={styles.line}>
                Devices: {billing.activeDevices} / {billing.deviceLimit}
              </Text>
              {billing.plan === 'free' ? (
                <>
                  <Muted>
                    Local use is free. Sync across more than one device with Iris Sync (~$5/mo).
                  </Muted>
                  <View style={{ height: theme.space(2) }} />
                  <Button
                    label="Subscribe to Iris Sync"
                    onPress={subscribe}
                    disabled={recoveryRequired}
                  />
                </>
              ) : (
                <Muted>You&apos;re on Iris Sync. Sync everywhere.</Muted>
              )}
            </>
          ) : (
            <Muted>Loading…</Muted>
          )}
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Agents</Text>
          <Muted>Issue a scoped token so an agent can read and write via the API.</Muted>
          <View style={{ height: theme.space(2) }} />
          <Field
            placeholder="Agent name (e.g. Researcher)"
            value={newAgentName}
            onChangeText={setNewAgentName}
            editable={!recoveryRequired}
          />
          <Button
            label="Issue agent token"
            variant="ghost"
            onPress={issueToken}
            disabled={recoveryRequired}
          />
          {issuedToken ? (
            <View style={styles.tokenBox}>
              <Text style={styles.tokenWarn}>Copy now — shown once:</Text>
              <Text selectable style={styles.tokenText}>
                {issuedToken}
              </Text>
            </View>
          ) : null}
          <View style={{ height: theme.space(2) }} />
          {recoveryRequired ? (
            <Muted>Agent status and controls are paused during local recovery.</Muted>
          ) : tokens.length === 0 ? (
            <Muted>No agents yet.</Muted>
          ) : null}
          {!recoveryRequired
            ? tokens.map((t) => (
                <View key={t.id} style={styles.tokenRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.line}>{t.agentName}</Text>
                    <Text style={styles.tokenMeta}>
                      {t.scopes.join(', ')} {t.revokedAt ? '· revoked' : ''}
                    </Text>
                  </View>
                  {!t.revokedAt ? (
                    <Button
                      label="Revoke"
                      variant="danger"
                      onPress={() => revoke(t.id)}
                      disabled={recoveryRequired}
                    />
                  ) : null}
                </View>
              ))
            : null}
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Your data</Text>
          <Muted>Export the whole workspace as plain Markdown. No lock-in.</Muted>
          <View style={{ height: theme.space(2) }} />
          <Button
            label="Export server workspace (.zip)"
            variant="ghost"
            onPress={exportData}
            disabled={recoveryRequired}
          />
          {Platform.OS !== 'web' ? (
            <Muted>On device, export opens a share sheet in a full build (follow-up).</Muted>
          ) : null}
        </Card>

        {signOutError ? (
          <Text style={styles.signOutError}>
            Sign-out could not be saved. Your account remains active; try again.
          </Text>
        ) : null}
        <Button
          label="Sign out"
          variant="danger"
          loading={signingOut}
          onPress={async () => {
            setSigningOut(true);
            setSignOutError(false);
            try {
              await signOut();
              router.replace('/sign-in');
            } catch {
              setSignOutError(true);
            } finally {
              setSigningOut(false);
            }
          }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: theme.space(2),
  },
  line: { color: theme.colors.text, fontSize: 14, marginBottom: theme.space(1) },
  strong: { fontWeight: '700', color: theme.colors.accent },
  tokenBox: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginTop: theme.space(2),
  },
  tokenWarn: { color: theme.colors.danger, fontSize: 12, marginBottom: theme.space(1) },
  tokenText: { color: theme.colors.text, fontSize: 12, fontFamily: undefined },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    paddingVertical: theme.space(2),
  },
  tokenMeta: { color: theme.colors.textDim, fontSize: 12 },
  signOutError: {
    color: theme.colors.danger,
    fontSize: 13,
    marginBottom: theme.space(2),
  },
});
