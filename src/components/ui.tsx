import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native';

import { Brand, Danger, Radius, Spacing, Success } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type TextKind = 'hero' | 'title' | 'heading' | 'body' | 'label' | 'muted';

export function T({ kind = 'body', style, ...rest }: TextProps & { kind?: TextKind }) {
  const theme = useTheme();
  const color = kind === 'muted' || kind === 'label' ? theme.textSecondary : theme.text;
  return <Text style={[{ color }, text[kind], style]} {...rest} />;
}

const text = StyleSheet.create({
  hero: { fontSize: 34, lineHeight: 40, fontWeight: '800' },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '800' },
  heading: { fontSize: 21, lineHeight: 28, fontWeight: '700' },
  body: { fontSize: 18, lineHeight: 26, fontWeight: '500' },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  muted: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
});

type ButtonVariant = 'primary' | 'danger' | 'neutral' | 'success';

export function BigButton({
  title,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  style,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const theme = useTheme();
  const bg = {
    primary: theme.tint,
    danger: Danger,
    success: Success,
    neutral: theme.cardStrong,
  }[variant];
  const fg = variant === 'neutral' ? theme.text : variant === 'primary' ? theme.onTint : '#FFFFFF';
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return <View style={[styles.card, { backgroundColor: theme.card }, style]}>{children}</View>;
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <T kind="heading">{title}</T>
      {hint ? <T kind="muted">{hint}</T> : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <T kind="label">{label}</T>
      <TextInput
        placeholderTextColor={theme.textSecondary}
        style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
        {...input}
      />
    </View>
  );
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: theme.cardStrong }]}>
      {options.map((o) => {
        const selected = o.id === value;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.id)}
            style={[styles.segment, selected && { backgroundColor: theme.background }]}>
            <Text style={[styles.segmentText, { color: selected ? theme.text : theme.textSecondary }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function StatusLine({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const color = ok === null ? '#A39587' : ok ? Brand.green : Brand.coral;
  return (
    <View style={styles.statusLine}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <T kind="muted" style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 60,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 19, fontWeight: '800' },
  card: { borderRadius: Radius.lg, padding: Spacing.md, gap: Spacing.sm },
  section: { gap: Spacing.xs },
  sectionBody: { gap: Spacing.sm, marginTop: Spacing.sm },
  field: { gap: Spacing.xs },
  input: {
    minHeight: 54,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    fontSize: 19,
  },
  segmented: { flexDirection: 'row', borderRadius: Radius.md, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 16, fontWeight: '700' },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
