/** In-memory blocklist for numbers Alex explicitly approves blocking after a call. */

export interface BlockedEntry {
  number: string;
  blockedAt: number;
  reason?: string;
}

const blocked = new Map<string, BlockedEntry>();

/** Canonical key so "+1 (800) 555-0177" and "800-555-0177" match consistently. */
function normalize(number: string): string {
  const digits = number.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits || number.trim().toLowerCase();
}

export function blockNumber(number: string, reason?: string): boolean {
  const trimmed = number.trim();
  const key = normalize(trimmed);
  if (!key) return false;
  if (!blocked.has(key)) {
    blocked.set(key, { number: trimmed, blockedAt: Date.now(), ...(reason ? { reason } : {}) });
  }
  return true;
}

export function isBlocked(number: string): boolean {
  const key = normalize(number.trim());
  return !!key && blocked.has(key);
}

export function listBlocked(): BlockedEntry[] {
  return [...blocked.values()];
}
