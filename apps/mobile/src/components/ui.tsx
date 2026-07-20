import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type AccessibilityState,
  type TextInputProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useObs } from '../state/hooks';
import { selectReplicaAuthorityState } from '../state/store';
import { theme } from '../theme';

export function Screen({ children, style, ...rest }: ViewProps & { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={[styles.screenInner, style]} {...rest}>
        <ReplicaAuthorityNotice />
        {children}
      </View>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function RecoveryNotice() {
  return (
    <View style={styles.recoveryNotice} accessibilityRole="alert">
      <Text style={styles.recoveryTitle}>Local recovery mode</Text>
      <Text style={styles.recoveryText}>
        Iris paused edits, sync, and remote billing/token actions. One or more local copies need
        attention. The copy shown in Iris may not be newer or more complete. You can still sign out,
        or open Settings → Recovery Center to inspect what Iris can currently verify and request a
        fail-closed local export.
      </Text>
    </View>
  );
}

export function ReplicaAuthorityNotice() {
  const authority = useObs(selectReplicaAuthorityState);
  if (authority === 'local') return null;
  if (authority === 'leader') {
    return (
      <Text
        style={styles.visuallyHidden}
        accessibilityLiveRegion="polite"
        testID="replica-authority-status"
      >
        This tab is active. Editing and sync are available.
      </Text>
    );
  }
  const unavailable = authority === 'unavailable';
  return (
    <View
      style={[styles.authorityNotice, unavailable && styles.authorityUnavailable]}
      accessibilityRole="alert"
      testID="replica-authority-notice"
    >
      <Text style={styles.authorityTitle}>
        {unavailable
          ? 'Local editing is paused'
          : authority === 'acquiring'
            ? 'Taking over this local workspace…'
            : 'View only in this tab'}
      </Text>
      <Text style={styles.authorityText}>
        {unavailable
          ? 'Iris could not verify local write authority. Your notes remain visible, but this app instance will not edit or sync.'
          : authority === 'acquiring'
            ? 'Iris is rereading the verified local replica before enabling edits or sync.'
            : 'Another Iris tab is active. This tab refreshes after verified local changes. Close the active tab to take over.'}
      </Text>
    </View>
  );
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
  accessibilityLabel,
  accessibilityState,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
}) {
  const unavailable = Boolean(disabled || loading);
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
      disabled={unavailable}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ ...accessibilityState, disabled: unavailable, busy: Boolean(loading) }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: unavailable ? 0.5 : pressed ? 0.85 : 1 },
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
  title: {
    color: theme.colors.text,
    fontSize: 26,
    fontWeight: '700',
    marginBottom: theme.space(2),
  },
  muted: { color: theme.colors.textDim, fontSize: 14 },
  recoveryNotice: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.danger,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginVertical: theme.space(3),
  },
  recoveryTitle: {
    color: theme.colors.danger,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: theme.space(1),
  },
  recoveryText: { color: theme.colors.text, fontSize: 13, lineHeight: 19 },
  authorityNotice: {
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.accent,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.space(3),
    marginBottom: theme.space(3),
  },
  authorityUnavailable: { borderColor: theme.colors.danger },
  authorityTitle: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: theme.space(1),
  },
  authorityText: { color: theme.colors.textDim, fontSize: 13, lineHeight: 19 },
  visuallyHidden: {
    position: 'absolute',
    left: -10_000,
    width: 1,
    height: 1,
    overflow: 'hidden',
  },
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
