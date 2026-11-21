import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BigButton, Card, T } from '@/components/ui';
import { VerdictBadge } from '@/components/verdict-card';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatNumber } from '@/lib/phone';
import { redactSafeWords } from '@/lib/redact';
import {
  blockedStore,
  clearHistory,
  historyStore,
  removeBlocked,
  safeWordsStore,
  useStore,
  type HistoryEntry,
} from '@/lib/store';

function when(ms: number) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function Row({ item }: { item: HistoryEntry }) {
  const safeWords = useStore(safeWordsStore);
  return (
    <Card>
      <View style={styles.rowTop}>
        <VerdictBadge verdict={item.verdict} />
        <View style={styles.flex}>
          <T kind="heading" numberOfLines={1}>
            {formatNumber(item.from)}
          </T>
          <T kind="muted">
            {when(item.startedAt)}
            {item.blocked ? ' · Blocked' : ''}
            {item.demo ? ' · Demo' : ''}
          </T>
        </View>
      </View>
      {item.reasons.map((r, i) => (
        <T key={i} kind="muted">
          • {redactSafeWords(r, safeWords)}
        </T>
      ))}
    </Card>
  );
}

export default function HistoryScreen() {
  const history = useStore(historyStore);
  const blocked = useStore(blockedStore);
  const theme = useTheme();

  const confirmClear = () =>
    Alert.alert('Clear history?', 'This removes every screened call from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: clearHistory },
    ]);

  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: theme.background }]}>
      <FlatList
        data={history}
        keyExtractor={(h) => h.callId}
        renderItem={({ item }) => <Row item={item} />}
        contentContainerStyle={[styles.list, { paddingBottom: BottomTabInset + Spacing.lg }]}
        ListHeaderComponent={<T kind="hero">History</T>}
        ListEmptyComponent={
          <Card>
            <T kind="body">No screened calls yet.</T>
            <T kind="muted">Calls the agent answers will be listed here with their verdict.</T>
          </Card>
        }
        ListFooterComponent={
          <View style={styles.footer}>
            {blocked.length > 0 ? (
              <>
                <T kind="heading">Blocked numbers</T>
                {blocked.map((n) => (
                  <Card key={n} style={styles.blockedRow}>
                    <T kind="body" style={styles.flex}>
                      {formatNumber(n)}
                    </T>
                    <BigButton
                      title="Unblock"
                      variant="neutral"
                      style={styles.unblock}
                      onPress={() => removeBlocked(n)}
                    />
                  </Card>
                ))}
                <T kind="muted">Unblocking here only affects this phone’s list.</T>
              </>
            ) : null}
            {history.length > 0 ? <BigButton title="Clear history" variant="neutral" onPress={confirmClear} /> : null}
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: Spacing.md, gap: Spacing.md },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  footer: { gap: Spacing.md, marginTop: Spacing.md },
  blockedRow: { flexDirection: 'row', alignItems: 'center' },
  unblock: { minHeight: 48 },
});
