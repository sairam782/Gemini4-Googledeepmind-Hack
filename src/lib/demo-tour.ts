/**
 * Hands-free demo tour for recording the pitch video (~60 s), in Demo mode.
 * Runs only when the dev server is started with EXPO_PUBLIC_DEMO_TOUR=1:
 *   EXPO_PUBLIC_DEMO_TOUR=1 npx expo start --localhost --dev-client
 * Home → scam call → SCAM verdict → Block → real call → REAL verdict → End → History → Setup.
 * It only changes settings in memory (nothing is saved), and clears this device's call history first.
 */
import { router } from 'expo-router';

import { block, end } from '@/lib/actions';
import { callStore, dismissCall } from '@/lib/call';
import { startDemo, stopDemo } from '@/lib/demo';
import { blockedStore, clearHistory, removeBlocked, settingsStore } from '@/lib/store';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;

export async function runDemoTour() {
  if (running) return;
  running = true;
  try {
    // Never show a real phone number in the video.
    settingsStore.set((s) => ({ ...s, mode: 'demo', myPhone: '' }));
    stopDemo();
    callStore.set(null);
    clearHistory();
    blockedStore.get().forEach(removeBlocked);
    router.navigate('/');
    console.log('TOUR_START');

    await wait(4000); // home screen: logo, DEMO badge
    startDemo('scam');
    await wait(19000); // transcript, warning signs, SCAM verdict
    await block();
    await wait(3000); // "Blocked · call ended"
    dismissCall();
    await wait(1500);

    startDemo('real');
    await wait(18500); // transcript, REAL verdict
    await end();
    await wait(2500);
    dismissCall();

    router.navigate('/history');
    await wait(6000); // both calls with verdicts, blocked number
    router.navigate('/setup');
    await wait(3000); // modes, forwarding
    router.navigate('/');
    console.log('TOUR_END');
  } finally {
    running = false;
  }
}
