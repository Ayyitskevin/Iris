import { useState } from 'react';
import { Text } from 'react-native';
import { Link, router } from 'expo-router';
import { Button, Field, Muted, Screen, Title } from '../../src/components/ui';
import { signUp } from '../../src/auth/session';
import { theme } from '../../src/theme';

export default function SignUp() {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setError(null);
    setLoading(true);
    try {
      await signUp(email.trim(), password, displayName.trim() || 'Operator');
      router.replace('/notes');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Title>Create your workspace</Title>
      <Muted>One person, several agents. This is your tenant.</Muted>
      <Field
        placeholder="Your name"
        value={displayName}
        onChangeText={setDisplayName}
        style={{ marginTop: theme.space(6) }}
      />
      <Field
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <Field
        placeholder="Password (8+ characters)"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text style={{ color: theme.colors.danger, marginBottom: theme.space(3) }}>{error}</Text> : null}
      <Button label="Create account" onPress={onSubmit} loading={loading} />
      <Link href="/sign-in" style={{ marginTop: theme.space(3) }}>
        <Text style={{ color: theme.colors.accent }}>Already have an account? Sign in</Text>
      </Link>
    </Screen>
  );
}
