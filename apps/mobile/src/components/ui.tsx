import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from '../theme';

export function Screen({ children, style, ...rest }: ViewProps & { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={[styles.screenInner, style]} {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Field(props: TextInputProps) {
  return <TextInput placeholderTextColor={theme.colors.textDim} style={styles.field} {...props} />;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}) {
  const bg =
    variant === 'primary'
      ? theme.colors.accent
      : variant === 'danger'
        ? theme.colors.danger
        : 'transparent';
  const fg = variant === 'ghost' ? theme.colors.accent : '#0b0d12';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && styles.buttonGhost,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewProps['style'] }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.bg },
  screenInner: { flex: 1, padding: theme.space(4) },
  title: { color: theme.colors.text, fontSize: 26, fontWeight: '700', marginBottom: theme.space(2) },
  muted: { color: theme.colors.textDim, fontSize: 14 },
  field: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    color: theme.colors.text,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
    fontSize: 16,
    marginBottom: theme.space(3),
  },
  button: {
    borderRadius: theme.radius,
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(4),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.space(2),
  },
  buttonGhost: { borderWidth: 1, borderColor: theme.colors.accentDim },
  buttonText: { fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(4),
    marginBottom: theme.space(3),
  },
});
