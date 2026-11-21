import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import CallScreener from '../../modules/call-screener';
import { BigButton, Card, Field, Section, Segmented, StatusLine, T } from '@/components/ui';
import { FEATURES } from '@/constants/features';
import { BottomTabInset, Brand, Danger, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { connectionStore } from '@/lib/connection';
import { CARRIERS, dialerUrl, forwardingCodes } from '@/lib/forwarding';
import { getPushToken } from '@/lib/notifications';
import { cleanNumber, formatNumber } from '@/lib/phone';
import { isHttps, registerDevice, uploadSafeWords } from '@/lib/server';
import {
  saveSafeWords,
  saveSettings,
  safeWordsStore,
  settingsStore,
  useStore,
  type Backend,
  type Carrier,
  type SafeWord,
} from '@/lib/store';

export default function SetupScreen() {
  const theme = useTheme();
  return (
    <SafeAreaView edges={['top']} style={[styles.flex, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.content, { paddingBottom: BottomTabInset + Spacing.xl }]}>
          <T kind="hero">Setup</T>
          <YourNumber />
          <Forwarding />
          {Platform.OS === 'android' ? <AndroidCallCheck /> : <IPhoneSilenceGuide />}
          {FEATURES.safeWords ? <SafeWords /> : null}
          <ServerSection />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function YourNumber() {
  const settings = useStore(settingsStore);
  const [draft, setDraft] = useState(settings.myPhone);

  return (
    <Section title="Your phone number" hint="When you tap Join, the agent rings this number and connects you.">
      <Field
        label="Your number"
        value={draft}
        onChangeText={setDraft}
        onEndEditing={() => void saveSettings({ ...settingsStore.get(), myPhone: cleanNumber(draft) })}
        placeholder="(555) 123-4567"
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------

function CodeBox({ code, action, onAction }: { code: string; action: string; onAction: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.codeBox, { borderColor: theme.border }]}>
      <T kind="title" selectable style={styles.flex}>
        {code}
      </T>
      <BigButton title={action} variant="neutral" style={styles.codeButton} onPress={onAction} />
    </View>
  );
}

function Forwarding() {
  const settings = useStore(settingsStore);
  const [agentDraft, setAgentDraft] = useState(settings.agentNumber);
  const codes = forwardingCodes(settings.carrier, settings.agentNumber);

  const dial = async (code: string) => {
    try {
      await Linking.openURL(dialerUrl(code));
    } catch {
      Alert.alert('Couldn’t open the dialer', `Dial ${code} yourself, then press call.`);
    }
  };
  const copy = async (code: string) => {
    await Clipboard.setStringAsync(code);
    Alert.alert('Copied', `Open the Phone app, paste ${code} into the keypad, and press call.`);
  };
  const act = Platform.OS === 'android' ? dial : copy;
  const actLabel = Platform.OS === 'android' ? 'Dial' : 'Copy';

  return (
    <Section
      title="Turn on forwarding"
      hint="Calls you don’t answer go to the agent’s number. You only do this once.">
      <Field
        label="Agent number (Twilio)"
        value={agentDraft}
        onChangeText={setAgentDraft}
        onEndEditing={() => void saveSettings({ ...settingsStore.get(), agentNumber: cleanNumber(agentDraft) })}
        placeholder="(555) 000-0000"
        keyboardType="phone-pad"
      />
      <T kind="label">Your carrier</T>
      <Segmented<Carrier>
        options={CARRIERS}
        value={settings.carrier}
        onChange={(carrier) => void saveSettings({ ...settingsStore.get(), carrier })}
      />
      {codes.on ? (
        <>
          {Platform.OS === 'android' ? (
            <BigButton title="Turn on forwarding" onPress={() => dial(codes.on!)} />
          ) : (
            <T kind="muted">iPhone doesn’t let apps dial * codes. Copy the code, paste it in the Phone keypad, and call.</T>
          )}
          <CodeBox code={codes.on} action={actLabel} onAction={() => act(codes.on!)} />
          <T kind="muted">
            Forwarding to {formatNumber(settings.agentNumber)}. To turn it off later:
          </T>
          <CodeBox code={codes.off} action={actLabel} onAction={() => act(codes.off)} />
        </>
      ) : (
        <T kind="muted">Enter the agent’s 10-digit US number to get your forwarding code.</T>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

const DECISION_TEXT: Record<string, string> = {
  ALLOW_CONTACT: 'rang normally (contact)',
  ALLOW_NO_PERMISSION: 'rang normally (no contacts access)',
  AGENT_UNKNOWN: 'sent to the agent (unknown)',
  AGENT_WITHHELD: 'sent to the agent (no caller ID)',
  AGENT_SPOOFED: 'sent to the agent (number looked faked)',
};

async function readCallCheckStatus() {
  if (!CallScreener) return { roleHeld: false, contacts: false, last: null };
  const contacts = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_CONTACTS);
  const d = CallScreener.getLastDecision();
  return {
    roleHeld: CallScreener.isScreeningRoleHeld(),
    contacts,
    last: d
      ? `${formatNumber(d.number)} ${DECISION_TEXT[d.decision] ?? d.decision} at ${new Date(d.at).toLocaleTimeString()}`
      : null,
  };
}

function AndroidCallCheck() {
  const [{ roleHeld, contacts, last }, setStatus] = useState<{
    roleHeld: boolean;
    contacts: boolean;
    last: string | null;
  }>({ roleHeld: false, contacts: false, last: null });

  const refresh = useCallback(() => void readCallCheckStatus().then(setStatus), []);

  useEffect(() => {
    void readCallCheckStatus().then(setStatus);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void readCallCheckStatus().then(setStatus);
    });
    return () => sub.remove();
  }, []);

  if (!CallScreener) {
    return (
      <Section title="Call check" hint="Needs a development build (npx expo run:android), not Expo Go.">
        <StatusLine ok={false}>Call screening module not found in this build.</StatusLine>
      </Section>
    );
  }
  if (!CallScreener.isSupported()) {
    return (
      <Section title="Call check">
        <StatusLine ok={false}>This phone doesn’t support call screening apps (needs Android 10+).</StatusLine>
      </Section>
    );
  }

  return (
    <Section
      title="Call check"
      hint="Contacts ring normally. Everyone else is declined quietly and forwarded to the agent.">
      <StatusLine ok={contacts}>{contacts ? 'Can see your contacts' : 'Needs access to your contacts'}</StatusLine>
      {!contacts ? (
        <BigButton
          title="Allow contacts"
          onPress={async () => {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_CONTACTS);
            void refresh();
          }}
        />
      ) : null}
      <StatusLine ok={roleHeld}>
        {roleHeld ? 'Uno ReVoice is your call screener' : 'Not your call screener yet'}
      </StatusLine>
      {!roleHeld ? (
        <BigButton
          title="Make Uno ReVoice the call screener"
          onPress={async () => {
            try {
              await CallScreener!.requestScreeningRole();
            } catch (e) {
              Alert.alert('Couldn’t ask Android', String(e));
            }
            void refresh();
          }}
        />
      ) : null}
      <T kind="muted">Last call: {last ?? 'none yet'}</T>
    </Section>
  );
}

function IPhoneSilenceGuide() {
  const steps = ['Open Settings', 'Tap Apps, then Phone', 'Tap Screen Unknown Callers', 'Choose Silence'];
  return (
    <Section
      title="Silence unknown callers"
      hint="iPhone doesn’t let apps check each call. This setting sends unknown callers to voicemail, and forwarding sends them to the agent.">
      <Card>
        {steps.map((s, i) => (
          <View key={s} style={styles.step}>
            <View style={styles.stepNum}>
              <T kind="heading" style={styles.stepNumText}>
                {i + 1}
              </T>
            </View>
            <T kind="body" style={styles.flex}>
              {s}
            </T>
          </View>
        ))}
      </Card>
      <T kind="muted" style={{ color: Danger }}>
        Pick Silence, not “Ask Reason for Calling”, or Apple’s screener answers before the agent does.
      </T>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function SafeWords() {
  const words = useStore(safeWordsStore);
  const [name, setName] = useState('');
  const [word, setWord] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [sync, setSync] = useState<{ ok: boolean | null; text: string } | null>(null);

  const persist = async (next: SafeWord[]) => {
    await saveSafeWords(next);
    const { myPhone, serverUrl } = settingsStore.get();
    if (!serverUrl || !myPhone) {
      setSync({ ok: null, text: 'Saved on this phone. They’ll go to the agent once the server is set up.' });
      return;
    }
    try {
      setSync({ ok: null, text: 'Sending to the agent…' });
      await uploadSafeWords(myPhone, next);
      setSync({ ok: true, text: 'Saved on this phone and sent to the agent.' });
    } catch (e) {
      setSync({ ok: false, text: `Saved on this phone. Not sent: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const add = () => {
    if (!name.trim() || !word.trim()) return;
    void persist([...words, { id: `${Date.now()}`, name: name.trim(), word: word.trim() }]);
    setName('');
    setWord('');
  };

  return (
    <Section
      title="Family safe words"
      hint="A word each family member knows. The agent asks callers who claim to be family for it. Safe words never show in transcripts or history.">
      {words.map((w) => (
        <Card key={w.id} style={styles.wordRow}>
          <Pressable style={styles.flex} onPress={() => setRevealed(revealed === w.id ? null : w.id)}>
            <T kind="heading">{w.name}</T>
            <T kind="muted">{revealed === w.id ? w.word : '••••••  (tap to show)'}</T>
          </Pressable>
          <BigButton
            title="Remove"
            variant="neutral"
            style={styles.smallButton}
            onPress={() => void persist(words.filter((x) => x.id !== w.id))}
          />
        </Card>
      ))}
      <Field label="Family member" value={name} onChangeText={setName} placeholder="Maya (granddaughter)" />
      <Field
        label="Their safe word"
        value={word}
        onChangeText={setWord}
        placeholder="blue heron"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <BigButton title="Add safe word" disabled={!name.trim() || !word.trim()} onPress={add} />
      {sync ? <StatusLine ok={sync.ok}>{sync.text}</StatusLine> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------

const BACKENDS: { id: Backend; label: string }[] = [
  { id: 'phone', label: 'Phone calls' },
  { id: 'web', label: 'Web simulation' },
];

function ServerSection() {
  const settings = useStore(settingsStore);
  const status = useStore(connectionStore);
  const statusText = {
    'not-set-up': 'Not connected',
    connecting: 'Connecting…',
    online: settings.backend === 'web' ? 'Connected to the simulation server' : 'Connected to the agent',
    offline: 'Can’t reach the server. Retrying…',
  }[status];

  return (
    <Section
      title="Agent server"
      hint="Phone calls: real calls forwarded to the Twilio number (twilio-server). Web simulation: calls you start on the web test desk (Abhi’s server).">
      <Segmented<Backend>
        options={BACKENDS}
        value={settings.backend}
        onChange={(backend) => void saveSettings({ ...settingsStore.get(), backend })}
      />
      {settings.backend === 'web' ? <SimServerFields /> : <PhoneServerFields />}
      <StatusLine ok={status === 'online' ? true : status === 'offline' ? false : null}>{statusText}</StatusLine>
    </Section>
  );
}

function SimServerFields() {
  const settings = useStore(settingsStore);
  const [draft, setDraft] = useState(settings.simServerUrl);
  const [token, setToken] = useState(settings.simToken);
  return (
    <>
      <Field
        label="Simulation server address"
        value={draft}
        onChangeText={setDraft}
        onEndEditing={() =>
          void saveSettings({ ...settingsStore.get(), simServerUrl: draft.trim().replace(/\/+$/, '') })
        }
        placeholder="http://localhost:8787"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Field
        label="App token (optional)"
        value={token}
        onChangeText={setToken}
        onEndEditing={() => void saveSettings({ ...settingsStore.get(), simToken: token.trim() })}
        placeholder="APP_TOKEN from the server's .env"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <T kind="muted">
        Start a call on the test desk (https://localhost:5173/desk) and it shows up on the Live call tab. On a real
        phone, use your computer’s network address instead of localhost, and the server’s APP_TOKEN. Join takes the call back from the agent.
      </T>
    </>
  );
}

function PhoneServerFields() {
  const settings = useStore(settingsStore);
  const [draft, setDraft] = useState(settings.serverUrl);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean | null; text: string } | null>(null);

  const connect = async () => {
    const serverUrl = draft.trim().replace(/\/+$/, '');
    await saveSettings({ ...settingsStore.get(), serverUrl });
    const { myPhone } = settingsStore.get();
    if (!myPhone) {
      setResult({ ok: false, text: 'Add your phone number at the top first.' });
      return;
    }
    setBusy(true);
    try {
      const push = await getPushToken();
      await registerDevice(myPhone, push.token, Platform.OS);
      if (FEATURES.safeWords) {
        const words = safeWordsStore.get();
        if (words.length > 0) await uploadSafeWords(myPhone, words);
      }
      setResult({
        ok: push.token ? true : null,
        text: push.token
          ? 'Registered. You’ll get a notification when the agent screens a call.'
          : `Registered, but no notifications: ${push.problem}`,
      });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label="Server address"
        value={draft}
        onChangeText={setDraft}
        placeholder="https://uno-revoice.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      {FEATURES.safeWords && draft.trim() && !isHttps(draft) ? (
        <T kind="muted">Not HTTPS: everything works except sending safe words.</T>
      ) : null}
      <BigButton title="Save and connect" busy={busy} disabled={!draft.trim()} onPress={connect} />
      {result ? <StatusLine ok={result.ok}>{result.text}</StatusLine> : null}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.md, gap: Spacing.xl },
  codeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 14,
    padding: Spacing.md,
  },
  codeButton: { minHeight: 48, minWidth: 90 },
  step: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.xs },
  stepNum: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Brand.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { color: '#FFFFFF' },
  wordRow: { flexDirection: 'row', alignItems: 'center' },
  smallButton: { minHeight: 48 },
});
