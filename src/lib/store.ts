import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import type { Verdict } from '@/lib/protocol';

// ---------------------------------------------------------------------------
// Tiny external store, so non-React code (WebSocket, demo timers) can update state.
// ---------------------------------------------------------------------------

export type Store<T> = {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ---------------------------------------------------------------------------
// Persisted app data
// ---------------------------------------------------------------------------

export type Carrier = 'verizon' | 'att_tmobile';

/**
 * How the app gets its calls:
 *  - 'demo':       scripted scam/real calls (demo.ts). No server, works offline. The judging backup.
 *  - 'simulation': the team's agent server (server/, /ws): Gemini plays the caller. No phone line.
 *  - 'live':       real forwarded calls: SignalWire → twilio-server/ (/app) → Gemini.
 */
export type AppMode = 'demo' | 'simulation' | 'live';

export const isAppMode = (v: unknown): v is AppMode => v === 'demo' || v === 'simulation' || v === 'live';

export type Settings = {
  /** The user's real phone. The server rings it when they tap Join. */
  myPhone: string;
  /** The Twilio number calls are forwarded to. Not a secret. */
  agentNumber: string;
  carrier: Carrier;
  /** Live mode: the phone server (twilio-server/), e.g. https://abcd.ngrok-free.app */
  serverUrl: string;
  /** How the app gets its calls. See AppMode. */
  mode: AppMode;
  /** Simulation mode: the team's agent server (server/), e.g. http://localhost:8787 */
  simServerUrl: string;
  /** APP_TOKEN of the agent server. Needed when the app isn't on the server's own computer. */
  simToken: string;
};

export type SafeWord = { id: string; name: string; word: string };

export type HistoryEntry = {
  callId: string;
  from: string;
  startedAt: number;
  endedAt: number;
  verdict: Verdict | null;
  reasons: string[];
  blocked: boolean;
  demo: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  myPhone: process.env.EXPO_PUBLIC_MY_PHONE ?? '',
  agentNumber: process.env.EXPO_PUBLIC_AGENT_NUMBER ?? '',
  carrier: 'verizon',
  serverUrl: process.env.EXPO_PUBLIC_SERVER_URL ?? '',
  mode: isAppMode(process.env.EXPO_PUBLIC_MODE) ? process.env.EXPO_PUBLIC_MODE : 'live',
  simServerUrl: process.env.EXPO_PUBLIC_SIM_SERVER_URL ?? 'http://localhost:8787',
  simToken: '',
};

export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS);
export const safeWordsStore = createStore<SafeWord[]>([]);
export const historyStore = createStore<HistoryEntry[]>([]);
export const blockedStore = createStore<string[]>([]);
export const loadedStore = createStore(false);

// Settings and safe words live in the OS keychain / keystore.
const SETTINGS_KEY = 'uno_revoice.settings';
const SAFE_WORDS_KEY = 'uno_revoice.safe_words';
// History and the block list aren't secret; plain files avoid keychain size limits.
const historyFile = () => new File(Paths.document, 'history.json');
const blockedFile = () => new File(Paths.document, 'blocked.json');

function readJsonFile<T>(file: File, fallback: T): T {
  try {
    return file.exists ? (JSON.parse(file.textSync()) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: File, value: unknown) {
  try {
    if (!file.exists) file.create();
    file.write(JSON.stringify(value));
  } catch (e) {
    console.warn('Could not save', file.uri, e);
  }
}

export async function loadPersisted() {
  try {
    const [rawSettings, rawWords] = await Promise.all([
      SecureStore.getItemAsync(SETTINGS_KEY),
      SecureStore.getItemAsync(SAFE_WORDS_KEY),
    ]);
    if (rawSettings) {
      const saved = JSON.parse(rawSettings) as Partial<Settings> & { backend?: string };
      // Older builds saved `backend: 'phone' | 'web'` instead of `mode`.
      if (!isAppMode(saved.mode) && saved.backend === 'web') saved.mode = 'simulation';
      delete saved.backend;
      settingsStore.set({ ...DEFAULT_SETTINGS, ...saved, mode: isAppMode(saved.mode) ? saved.mode : DEFAULT_SETTINGS.mode });
    }
    if (rawWords) safeWordsStore.set(JSON.parse(rawWords));
  } catch (e) {
    console.warn('Could not load secure settings', e);
  }
  historyStore.set(readJsonFile<HistoryEntry[]>(historyFile(), []));
  blockedStore.set(readJsonFile<string[]>(blockedFile(), []));
  loadedStore.set(true);
}

export async function saveSettings(next: Settings) {
  settingsStore.set(next);
  await SecureStore.setItemAsync(SETTINGS_KEY, JSON.stringify(next));
}

export async function saveSafeWords(next: SafeWord[]) {
  safeWordsStore.set(next);
  await SecureStore.setItemAsync(SAFE_WORDS_KEY, JSON.stringify(next));
}

export function addHistory(entry: HistoryEntry) {
  historyStore.set((prev) => [entry, ...prev.filter((h) => h.callId !== entry.callId)].slice(0, 200));
  writeJsonFile(historyFile(), historyStore.get());
}

export function markHistoryBlocked(callId: string) {
  historyStore.set((prev) => prev.map((h) => (h.callId === callId ? { ...h, blocked: true } : h)));
  writeJsonFile(historyFile(), historyStore.get());
}

export function clearHistory() {
  historyStore.set([]);
  writeJsonFile(historyFile(), []);
}

export function addBlocked(number: string) {
  if (!number || blockedStore.get().includes(number)) return;
  blockedStore.set((prev) => [number, ...prev]);
  writeJsonFile(blockedFile(), blockedStore.get());
}

export function removeBlocked(number: string) {
  blockedStore.set((prev) => prev.filter((n) => n !== number));
  writeJsonFile(blockedFile(), blockedStore.get());
}
