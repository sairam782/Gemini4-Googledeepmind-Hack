/** Digits only, keeping a leading +. */
export function cleanNumber(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** 10-digit US national number, or null if it isn't one. */
export function usNational(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return null;
}

/** "+15550132244" -> "(555) 013-2244". Leaves anything non-US as-is. */
export function formatNumber(input: string): string {
  if (!input) return 'Unknown number';
  const n = usNational(input);
  return n ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : input;
}
