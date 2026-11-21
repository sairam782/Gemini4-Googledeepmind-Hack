export type ScreeningDecisionName =
  | 'ALLOW_CONTACT'
  | 'ALLOW_NO_PERMISSION'
  | 'AGENT_UNKNOWN'
  | 'AGENT_WITHHELD'
  | 'AGENT_SPOOFED';

export type ScreeningDecision = {
  number: string;
  decision: ScreeningDecisionName;
  /** Epoch milliseconds. */
  at: number;
};
