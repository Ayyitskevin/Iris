import { useCallback, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { AgentToken, BillingStatus } from '@iris/shared';
import { Button, Card, Field, Muted, Screen, Title } from '../../src/components/ui';
import { api } from '../../src/api';
import { signOut } from '../../src/auth/session';
import { store$ } from '../../src/state/store';
import { useObs } from '../../src/state/hooks';
import { theme } from '../../src/theme';

export default function Settings() {
  const email = useObs(() => store$.session.get()?.email ?? '');
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [newAgentName, setNewAgentName] = useState('');
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, t] = await Promise.all([api.billingStatus(), api.listAgentTokens()]);
      setBilling(b);
      setTokens(t.tokens);
    } catch {
      // offline
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function subscribe() {
    try {
      const { url } = await api.createCheckout();
      await Linking.openURL(url);
    } catch {
      // ignore
    }
  }

  async function issueToken() {
    try {
      const res = await api.issueAgentToken({
        agentName: newAgentName.trim() || 'Agent',
        scopes: ['notes:read', 'notes:write'],
      });
      setIssuedToken(res.token);
      setNewAgentName('');
      await load();
    } catch {
      // ignore
    }
  }

  async function revoke(id: string) {
    try {
      await api.revokeAgentToken(id);
      await load();
    } catch {
      // ignore
    }
  }

  async function exportData() {
    const token = store$.session.get()?.token;
    try {
      const res = await fetch(api.exportUrl(), { headers: { authorization: `Bearer ${token}` } });
      const blob = await res.blob();
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

        <Card style={{ marginTop: theme.space(4) }}>
          <Text style={styles.cardTitle}>Sync plan</Text>
          {billing ? (
            <>
              <Text style={styles.line}>
                Plan: <Text style={styles.strong}>{billing.plan}</Text> ({billing.status})
              </Text>
              <Text style={styles.line}>
                Devices: {billing.activeDevices} / {billing.deviceLimit}
              </Text>
              {billing.plan === 'free' ? (
                <>
                  <Muted>Local use is free. Sync across more than one device with Iris Sync (~$5/mo).</Muted>
                  <View style={{ height: theme.space(2) }} />
                  <Button label="Subscribe to Iris Sync" onPress={subscribe} />
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
          <Field placeholder="Agent name (e.g. Researcher)" value={newAgentName} onChangeText={setNewAgentName} />
          <Button label="Issue agent token" variant="ghost" onPress={issueToken} />
          {issuedToken ? (
            <View style={styles.tokenBox}>
              <Text style={styles.tokenWarn}>Copy now — shown once:</Text>
              <Text selectable style={styles.tokenText}>
                {issuedToken}
              </Text>
            </View>
          ) : null}
          <View style={{ height: theme.space(2) }} />
          {tokens.length === 0 ? <Muted>No agents yet.</Muted> : null}
          {tokens.map((t) => (
            <View key={t.id} style={styles.tokenRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.line}>{t.agentName}</Text>
                <Text style={styles.tokenMeta}>
                  {t.scopes.join(', ')} {t.revokedAt ? '· revoked' : ''}
                </Text>
              </View>
              {!t.revokedAt ? <Button label="Revoke" variant="danger" onPress={() => revoke(t.id)} /> : null}
            </View>
          ))}
        </Card>

        <Card>
          <Text style={styles.cardTitle}>Your data</Text>
          <Muted>Export the whole workspace as plain Markdown. No lock-in.</Muted>
          <View style={{ height: theme.space(2) }} />
          <Button label="Export as Markdown (.zip)" variant="ghost" onPress={exportData} />
          {Platform.OS !== 'web' ? (
            <Muted>On device, export opens a share sheet in a full build (follow-up).</Muted>
          ) : null}
        </Card>

        <Button
          label="Sign out"
          variant="danger"
          onPress={async () => {
            await signOut();
            router.replace('/sign-in');
          }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitle: { color: theme.colors.text, fontSize: 17, fontWeight: '700', marginBottom: theme.space(2) },
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
});
