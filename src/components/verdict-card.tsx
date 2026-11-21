import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Radius, Spacing, VerdictStyle } from '@/constants/theme';
import type { Verdict } from '@/lib/protocol';

export function VerdictCard({ verdict, reasons, ended }: { verdict: Verdict | null; reasons: string[]; ended: boolean }) {
  const v = VerdictStyle[verdict ?? 'pending'];
  const label = !verdict && ended ? 'NO VERDICT' : v.label;
  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`Verdict: ${label}. ${reasons.join('. ')}`}
      style={[styles.card, { backgroundColor: v.bg }]}>
      <View style={styles.row}>
        {!verdict && !ended ? <ActivityIndicator color={v.fg} /> : null}
        <Text style={[styles.label, { color: v.fg }]}>{label}</Text>
      </View>
      {reasons.length > 0 ? (
        reasons.map((r, i) => (
          <Text key={i} style={[styles.reason, { color: v.fg }]}>
            • {r}
          </Text>
        ))
      ) : (
        <Text style={[styles.reason, { color: v.fg }]}>{ended ? 'The call ended before a verdict.' : v.hint}</Text>
      )}
    </View>
  );
}

/** Small pill for lists. */
export function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
  const v = VerdictStyle[verdict ?? 'pending'];
  return (
    <View style={[styles.badge, { backgroundColor: v.bg }]}>
      <Text style={[styles.badgeText, { color: v.fg }]}>{verdict ? v.label : '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.lg, padding: Spacing.md + 4, gap: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  label: { fontSize: 44, lineHeight: 50, fontWeight: '900', letterSpacing: 1 },
  reason: { fontSize: 18, lineHeight: 25, fontWeight: '600' },
  badge: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, minWidth: 82, alignItems: 'center' },
  badgeText: { fontSize: 15, fontWeight: '900', letterSpacing: 0.5 },
});
