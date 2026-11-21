/**
 * Feature switches. Flip one to true to bring a feature back; its code is kept in place.
 */
export const FEATURES = {
  /**
   * Family safe words (Setup section, upload to the server, the agent asking for them).
   * Off for now: optional, the agent relies on scam signs and "call you back on your usual number".
   * TODO: add safe words back after the core call flow works. See README → "Later".
   */
  safeWords: false,
} as const;
