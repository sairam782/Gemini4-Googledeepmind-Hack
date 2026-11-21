import { Platform } from 'react-native';

import type { Verdict } from '@/lib/protocol';

/**
 * Uno ReVoice brand (assets/brand): navy ink, red "Re" and phone, on warm cream with white cards.
 * Green isn't in the logo; it's kept only to mean "safe / real / connected".
 */
export const Brand = {
  navy: '#141A33',
  red: '#C8372D',
  cream: '#FFF4E8',
  white: '#FFFFFF',
  green: '#1E7A57',
} as const;

export const Colors = {
  light: {
    text: Brand.navy,
    textSecondary: '#585D73',
    background: Brand.cream,
    card: Brand.white,
    cardStrong: '#F6E6D4',
    border: '#E7D6C3',
    tint: Brand.navy,
    onTint: Brand.cream,
    callerBubble: Brand.white,
    agentBubble: '#E4E7F2',
  },
  dark: {
    text: Brand.cream,
    textSecondary: '#B7BACB',
    background: '#0E1226',
    card: '#1A2040',
    cardStrong: '#242B4E',
    border: '#323A63',
    tint: Brand.cream,
    onTint: Brand.navy,
    callerBubble: '#1A2040',
    agentBubble: '#2B3462',
  },
} as const;

export type Theme = { [K in keyof typeof Colors.light]: string };

/**
 * Status colours with white text readable on them (≥ 4.5:1).
 * The same in light and dark mode so the meaning never shifts.
 */
export const Danger = Brand.red;
export const Success = Brand.green;
export const Caution = '#B05E00';

export const VerdictStyle: Record<Verdict | 'pending', { bg: string; fg: string; label: string; hint: string }> = {
  scam: { bg: Danger, fg: '#FFFFFF', label: 'SCAM', hint: 'Do not join. Block this caller.' },
  real: { bg: Success, fg: '#FFFFFF', label: 'REAL', hint: 'Looks genuine. Join if you want to talk.' },
  unsure: { bg: Caution, fg: '#FFFFFF', label: 'UNSURE', hint: 'Be careful. Keep listening.' },
  pending: { bg: Brand.navy, fg: '#FFFFFF', label: 'CHECKING…', hint: 'The agent is talking to the caller.' },
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const Radius = {
  md: 14,
  lg: 22,
} as const;

/** Native tabs float over the content: leave room so the last item isn't hidden. */
export const BottomTabInset = Platform.select({ ios: 96, android: 84 }) ?? 0;
