import { useState } from 'react';
import { Text } from 'react-native';
import { Link, router } from 'expo-router';
import { Button, Field, Muted, Screen, Title } from '../../src/components/ui';
import { signIn } from '../../src/auth/session';
import { theme } from '../../src/theme';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setError(null);
    setLoading(true);
    try {
      await signIn(email.trim(), password);
      router.replace('/notes');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <Title>Iris</Title>
      <Muted>Herald + watcher. Sign in to your workspace.</Muted>
      <Field
        placeholder="you@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={{ marginTop: theme.space(6) }}
      />
      <Field placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      {error ? <Text style={{ color: theme.colors.danger, marginBottom: theme.space(3) }}>{error}</Text> : null}
      <Button label="Sign in" onPress={onSubmit} loading={loading} />
      <Link href="/sign-up" style={{ marginTop: theme.space(3) }}>
        <Text style={{ color: theme.colors.accent }}>New here? Create an account</Text>
      </Link>
    </Screen>
  );
}
