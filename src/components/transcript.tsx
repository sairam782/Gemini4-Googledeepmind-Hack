import { StyleSheet, Text, View } from 'react-native';

import { Brand, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Turn, WarningSign } from '@/lib/call';

export function Bubble({ turn, text }: { turn: Turn; text: string }) {
  const theme = useTheme();
  const isAgent = turn.speaker === 'agent';
  return (
    <View style={[styles.row, isAgent ? styles.right : styles.left]}>
      <Text style={[styles.who, { color: theme.textSecondary }]}>{isAgent ? 'Agent' : turn.speaker === 'you' ? 'You' : 'Caller'}</Text>
      <View
        style={[
          styles.bubble,
          { backgroundColor: isAgent ? theme.agentBubble : theme.callerBubble },
          isAgent ? styles.bubbleAgent : styles.bubbleCaller,
        ]}>
        <Text style={[styles.text, { color: theme.text }]}>{text}</Text>
      </View>
    </View>
  );
}

export function WarningSigns({ signs }: { signs: WarningSign[] }) {
  if (signs.length === 0) return null;
  return (
    <View style={styles.signs} accessibilityLabel={`Warning signs: ${signs.map((s) => s.label).join(', ')}`}>
      {signs.map((s) => (
        <View key={s.label} style={styles.sign}>
          <Text style={styles.signText}>⚠ {s.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { maxWidth: '88%', gap: 2 },
  left: { alignSelf: 'flex-start' },
  right: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  who: { fontSize: 13, fontWeight: '700', marginHorizontal: 6 },
  bubble: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleCaller: { borderTopLeftRadius: 6 },
  bubbleAgent: { borderTopRightRadius: 6 },
  text: { fontSize: 18, lineHeight: 25 },
  signs: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  sign: { backgroundColor: '#FBE6E3', borderColor: Brand.red, borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  signText: { color: '#8C241C', fontSize: 16, fontWeight: '700' },
});
