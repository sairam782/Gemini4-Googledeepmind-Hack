import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandHeader, Logo, Wordmark } from '@/components/brand';
import { Bubble, WarningSigns } from '@/components/transcript';
import { BigButton, Card, StatusLine, T } from '@/components/ui';
import { VerdictCard } from '@/components/verdict-card';
import { BottomTabInset, Brand, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { block, canSteer, end, join, pickDirection, steer } from '@/lib/actions';
import { callStore, dismissCall, type LiveCall } from '@/lib/call';
import { connectionStore, type ConnectionStatus } from '@/lib/connection';
import { startDemo } from '@/lib/demo';
import { notifyScam } from '@/lib/notifications';
import { startPhoneSim, type SimKind } from '@/lib/phone-sim';
import { isSimCall } from '@/lib/simulation';
import { formatNumber } from '@/lib/phone';
import { redactSafeWords } from '@/lib/redact';
import { safeWordsStore, settingsStore, useStore, type AppMode } from '@/lib/store';

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
  demo: { ok: null, text: 'Demo mode: scripted calls, no server.' },
  'not-set-up': { ok: null, text: 'Not connected. Set up the server in Setup.' },
  connecting: { ok: null, text: 'Connecting to the agent…' },
  online: { ok: true, text: 'Agent is ready to screen calls' },
  offline: { ok: false, text: 'Agent offline. Retrying…' },
};

function Idle() {
  const status = useStore(connectionStore);
  const c = CONNECTION_TEXT[status];
  const { mode } = useStore(settingsStore);
  const [starting, setStarting] = useState<SimKind | null>(null);
  // Deep link for demos and shortcuts: unorevoice:///?simulate=scam (or real).
  const { simulate: linked } = useLocalSearchParams<{ simulate?: string }>();

  const simulate = async (kind: SimKind) => {
    setStarting(kind);
    try {
      await startPhoneSim(kind);
    } catch (e) {
      Alert.alert('Couldn’t start the call', e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  };

  useEffect(() => {
    if (linked !== 'scam' && linked !== 'real') return;
    router.setParams({ simulate: undefined });
    startPhoneSim(linked).catch((e: unknown) =>
      Alert.alert('Couldn’t start the call', e instanceof Error ? e.message : String(e)),
    );
  }, [linked]);

  return (
    <ScrollView contentContainerStyle={[styles.idle, { paddingBottom: BottomTabInset + Spacing.lg }]}>
      <BrandHeader />
      <ModeBadge />
      <StatusLine ok={c.ok}>{c.text}</StatusLine>
      <Card style={styles.idleCard}>
        <T kind="title">No call right now</T>
        <T kind="muted">
          When an unknown number calls, the agent answers for you. You’ll get a notification, and the call shows up
          here live.
        </T>
      </Card>
      {mode === 'simulation' ? (
        <>
          <T kind="label">Simulate an incoming call</T>
          <T kind="muted">The AI agent answers a caller played by Gemini, with voices.</T>
          <BigButton
            title="Incoming scam call"
            busy={starting === 'scam'}
            disabled={starting !== null}
            onPress={() => void simulate('scam')}
          />
          <BigButton
            title="Incoming real call"
            variant="neutral"
            busy={starting === 'real'}
            disabled={starting !== null}
            onPress={() => void simulate('real')}
          />
        </>
      ) : null}
      {mode === 'demo' ? (
        <>
          <T kind="label">Try it without a real call</T>
          <BigButton title="Start scam demo call" onPress={() => startDemo('scam')} />
          <BigButton title="Start real demo call" variant="neutral" onPress={() => startDemo('real')} />
        </>
      ) : null}
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

  // Scam verdict on a real or simulated call: say so clearly, and let the user decide to hang up.
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (call.demo || call.ended || call.verdict !== 'scam' || warned.current === call.callId) return;
    warned.current = call.callId;
    void notifyScam(call.callId, call.reasons[0]);
    Alert.alert('This call is a scam', call.reasons.slice(0, 2).join('\n') || 'Gemini flagged this caller as a scam.', [
      { text: 'Keep listening', style: 'cancel' },
      { text: 'Hang up', onPress: () => void run('end', end) },
      { text: 'Hang up and block', style: 'destructive', onPress: () => void run('block', block) },
    ]);
    // run is recreated each render; the guard above makes this fire once per call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.verdict, call.callId, call.ended, call.demo]);

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
        <View style={styles.headerRow}>
          <View style={styles.brandRow}>
            <Logo size={26} />
            <Wordmark size={20} />
          </View>
          <ModeBadge mode={call.demo ? 'demo' : isSimCall(call.callId) ? 'simulation' : 'live'} />
        </View>
        <T kind="label" style={styles.state}>
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
        {!call.ended && !call.joined && call.directions.length > 0 ? <Suggestions call={call} /> : null}
        {canSteer(call) ? <SteerBox /> : null}
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

const MODE_LABEL: Record<AppMode, string> = { demo: 'DEMO', simulation: 'SIMULATION', live: 'LIVE' };
const MODE_COLOR: Record<AppMode, string> = { demo: '#7A7F95', simulation: Brand.green, live: Brand.red };

/** Small pill showing the mode (or, during a call, where that call comes from). */
function ModeBadge({ mode: forCall }: { mode?: AppMode }) {
  const settings = useStore(settingsStore);
  const mode = forCall ?? settings.mode;
  return (
    <View style={[styles.badge, { borderColor: MODE_COLOR[mode] }]} accessibilityLabel={`${mode} mode`}>
      <Text style={[styles.badgeText, { color: MODE_COLOR[mode] }]}>{MODE_LABEL[mode]}</Text>
    </View>
  );
}

/** Suggested replies from Gemini: tap one and the agent says it next. */
function Suggestions({ call }: { call: LiveCall }) {
  const theme = useTheme();
  const [sending, setSending] = useState<string | null>(null);
  const pick = async (id: string) => {
    const d = call.directions.find((x) => x.id === id);
    if (!d) return;
    setSending(id);
    try {
      await pickDirection(d);
    } catch (e) {
      Alert.alert('Couldn’t send that reply', e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  };
  return (
    <View style={styles.suggest}>
      <T kind="label">Suggested replies</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestRow}>
        {call.directions.map((d) => (
          <Pressable
            key={d.id}
            accessibilityRole="button"
            accessibilityHint={`The agent says: ${d.say}`}
            disabled={sending !== null}
            onPress={() => void pick(d.id)}
            style={({ pressed }) => [
              styles.suggestCard,
              { borderColor: theme.border, backgroundColor: theme.card, opacity: pressed || sending === d.id ? 0.6 : 1 },
            ]}>
            <Text style={[styles.suggestLabel, { color: theme.text }]} numberOfLines={1}>
              {d.label}
            </Text>
            <Text style={[styles.suggestSay, { color: theme.textSecondary }]} numberOfLines={2}>
              “{d.say}”
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** Steer: a private instruction for the agent's next line (Live calls). */
function SteerBox() {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await steer(t);
      setText('');
    } catch (e) {
      Alert.alert('Couldn’t steer the agent', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.steer}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => void submit()}
        placeholder="Steer the agent, e.g. “Ask for their full name”"
        placeholderTextColor={theme.textSecondary}
        returnKeyType="send"
        editable={!busy}
        style={[styles.steerInput, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }]}
      />
      <BigButton title="Send" variant="neutral" busy={busy} disabled={!text.trim()} style={styles.steerButton} onPress={() => void submit()} />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  state: { marginTop: Spacing.sm },
  badge: { alignSelf: 'flex-start', borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  steer: { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.sm },
  suggest: { gap: 4, marginBottom: Spacing.sm },
  suggestRow: { gap: Spacing.sm, paddingRight: Spacing.md },
  suggestCard: { width: 230, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  suggestLabel: { fontSize: 15, fontWeight: '800' },
  suggestSay: { fontSize: 13, lineHeight: 17 },
  steerInput: { flex: 1, minHeight: 48, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, fontSize: 17 },
  steerButton: { minHeight: 48, minWidth: 80 },
  screen: { flex: 1 },
  flex: { flex: 1 },
  idle: { padding: Spacing.md, gap: Spacing.md },
  idleCard: { marginVertical: Spacing.sm, padding: Spacing.lg },
  header: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  top: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, paddingBottom: Spacing.xs, gap: Spacing.sm },
  transcript: { padding: Spacing.md, gap: Spacing.md },
  actions: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },
  actionRow: { flexDirection: 'row', gap: Spacing.sm },
});
