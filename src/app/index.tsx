import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandHeader } from '@/components/brand';
import { Bubble, WarningSigns } from '@/components/transcript';
import { BigButton, Card, StatusLine, T } from '@/components/ui';
import { VerdictCard } from '@/components/verdict-card';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { block, end, join } from '@/lib/actions';
import { callStore, dismissCall, type LiveCall } from '@/lib/call';
import { connectionStore, type ConnectionStatus } from '@/lib/connection';
import { startDemo } from '@/lib/demo';
import { formatNumber } from '@/lib/phone';
import { redactSafeWords } from '@/lib/redact';
import { safeWordsStore, useStore } from '@/lib/store';

export default function LiveCallScreen() {
  const call = useStore(callStore);
  const theme = useTheme();
  return (
    <SafeAreaView edges={['top']} style={[styles.screen, { backgroundColor: theme.background }]}>
      {call ? <ActiveCall call={call} /> : <Idle />}
    </SafeAreaView>
  );
}

const CONNECTION_TEXT: Record<ConnectionStatus, { ok: boolean | null; text: string }> = {
  'not-set-up': { ok: null, text: 'Not connected. Add your number and server in Setup.' },
  connecting: { ok: null, text: 'Connecting to the agent…' },
  online: { ok: true, text: 'Agent is ready to screen calls' },
  offline: { ok: false, text: 'Agent offline. Retrying…' },
};

function Idle() {
  const status = useStore(connectionStore);
  const c = CONNECTION_TEXT[status];
  return (
    <ScrollView contentContainerStyle={[styles.idle, { paddingBottom: BottomTabInset + Spacing.lg }]}>
      <BrandHeader />
      <StatusLine ok={c.ok}>{c.text}</StatusLine>
      <Card style={styles.idleCard}>
        <T kind="title">No call right now</T>
        <T kind="muted">
          When an unknown number calls, the agent answers for you. You’ll get a notification, and the call shows up
          here live.
        </T>
      </Card>
      <T kind="label">Try it without a real call</T>
      <BigButton title="Play scam demo call" variant="neutral" onPress={() => startDemo('scam')} />
      <BigButton title="Play real demo call" variant="neutral" onPress={() => startDemo('real')} />
    </ScrollView>
  );
}

function ActiveCall({ call }: { call: LiveCall }) {
  const safeWords = useStore(safeWordsStore);
  const scroll = useRef<ScrollViewInstance>(null);
  const [busy, setBusy] = useState<'join' | 'end' | 'block' | null>(null);

  useEffect(() => {
    scroll.current?.scrollToEnd({ animated: true });
  }, [call.transcript.length]);

  const run = async (which: 'join' | 'end' | 'block', fn: () => Promise<void>) => {
    setBusy(which);
    try {
      await fn();
    } catch (e) {
      Alert.alert('That didn’t work', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmBlock = () =>
    Alert.alert('Block this number?', `${formatNumber(call.from)} won’t reach you again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: () => run('block', block) },
    ]);

  const state = call.ended
    ? call.blocked
      ? 'Blocked · call ended'
      : 'Call ended'
    : call.joined
      ? 'You’re on the call'
      : call.joining
        ? 'Ringing your phone…'
        : 'Agent is screening';

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <T kind="label">
          {call.demo ? 'Demo · ' : ''}
          {state}
        </T>
        <T kind="hero" numberOfLines={1} adjustsFontSizeToFit>
          {formatNumber(call.from)}
        </T>
      </View>

      <View style={styles.top}>
        <VerdictCard
          verdict={call.verdict}
          reasons={call.reasons.map((r) => redactSafeWords(r, safeWords))}
          ended={call.ended}
        />
        <WarningSigns signs={call.signals} />
      </View>

      <ScrollView ref={scroll} style={styles.flex} contentContainerStyle={styles.transcript}>
        {call.transcript.length === 0 ? <T kind="muted">Waiting for the first words…</T> : null}
        {call.transcript.map((t) => (
          <Bubble key={`${t.turn}-${t.speaker}`} turn={t} text={redactSafeWords(t.text, safeWords)} />
        ))}
      </ScrollView>

      <View style={[styles.actions, { paddingBottom: BottomTabInset + Spacing.sm }]}>
        {call.ended ? (
          <View style={styles.actionRow}>
            {!call.blocked && call.from ? (
              <BigButton title="Block" variant="danger" style={styles.flex} busy={busy === 'block'} onPress={confirmBlock} />
            ) : null}
            <BigButton title="Done" variant="neutral" style={styles.flex} onPress={dismissCall} />
          </View>
        ) : (
          <View style={styles.actionRow}>
            <BigButton
              title={call.joined ? 'Joined' : 'Join'}
              variant="success"
              style={styles.flex}
              disabled={call.joined}
              busy={busy === 'join' || call.joining}
              accessibilityHint="Rings your phone and connects you to the caller"
              onPress={() => run('join', join)}
            />
            <BigButton title="End" variant="neutral" style={styles.flex} busy={busy === 'end'} onPress={() => run('end', end)} />
            <BigButton
              title="Block"
              variant="danger"
              style={styles.flex}
              disabled={!call.from}
              busy={busy === 'block'}
              onPress={confirmBlock}
            />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  idle: { padding: Spacing.md, gap: Spacing.md },
  idleCard: { marginVertical: Spacing.sm, padding: Spacing.lg },
  header: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  top: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, gap: Spacing.sm },
  transcript: { padding: Spacing.md, gap: Spacing.md },
  actions: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  actionRow: { flexDirection: 'row', gap: Spacing.sm },
});
