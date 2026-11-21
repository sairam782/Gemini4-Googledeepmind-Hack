import { Platform } from 'react-native';

import type { Verdict } from '@/lib/protocol';

/** Uno ReVoice brand, from the logo: coral "Uno", ink "Re", green "Voice", on cream. */
export const Brand = {
  coral: '#FF5A4E',
  green: '#19A37F',
  cream: '#FFF4E8',
  ink: '#1F1F1F',
  overlap: '#193927',
} as const;

export const Colors = {
  light: {
    text: Brand.ink,
    textSecondary: '#6B5F55',
    background: Brand.cream,
    card: '#FFFFFF',
    cardStrong: '#F5E4D2',
    border: '#E6D3BF',
    tint: Brand.ink,
    onTint: Brand.cream,
    callerBubble: '#FFFFFF',
    agentBubble: '#D5EFE6',
  },
  dark: {
    text: Brand.cream,
    textSecondary: '#BDB1A5',
    background: '#141414',
    card: '#1F1F1F',
    cardStrong: '#2D2A27',
    border: '#3B3734',
    tint: Brand.cream,
    onTint: Brand.ink,
    callerBubble: '#272421',
    agentBubble: '#14392E',
  },
} as const;

export type Theme = { [K in keyof typeof Colors.light]: string };

/**
 * Deeper versions of the brand coral and green, so white text on them stays readable (≥ 4.5:1).
 * The same in light and dark mode so the meaning never shifts.
 */
export const Danger = '#D63A2F';
export const Success = '#127F63';
export const Caution = '#B05E00';

export const VerdictStyle: Record<Verdict | 'pending', { bg: string; fg: string; label: string; hint: string }> = {
  scam: { bg: Danger, fg: '#FFFFFF', label: 'SCAM', hint: 'Do not join. Block this caller.' },
  real: { bg: Success, fg: '#FFFFFF', label: 'REAL', hint: 'Looks genuine. Join if you want to talk.' },
  unsure: { bg: Caution, fg: '#FFFFFF', label: 'UNSURE', hint: 'Be careful. Keep listening.' },
  pending: { bg: '#3B3734', fg: '#FFFFFF', label: 'CHECKING…', hint: 'The agent is talking to the caller.' },
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
export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
