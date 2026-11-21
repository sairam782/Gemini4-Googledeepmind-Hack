import { usNational } from '@/lib/phone';
import type { Carrier } from '@/lib/store';

export const CARRIERS: { id: Carrier; label: string }[] = [
  { id: 'verizon', label: 'Verizon' },
  { id: 'att_tmobile', label: 'AT&T / T-Mobile' },
];

/**
 * Conditional call forwarding (busy / no answer / declined) to the Twilio number.
 * Declined calls (Android call check) and silenced calls (iPhone) then reach the agent.
 */
export function forwardingCodes(carrier: Carrier, agentNumber: string) {
  const national = usNational(agentNumber);
  if (carrier === 'verizon') {
    return { on: national ? `*71${national}` : null, off: '*73' };
  }
  return { on: national ? `**004*1${national}#` : null, off: '##004#' };
}

/** tel: URL with the code filled in. `#` must be encoded or the dialer drops everything after it. */
export function dialerUrl(code: string) {
  return `tel:${encodeURIComponent(code)}`;
}
