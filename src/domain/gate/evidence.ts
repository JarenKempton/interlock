export interface GateEvidence {
  gate: string;
  fact: string;
  source: { system: string; ref: string };
  observed: { value: string | number | boolean | null } | { ref: string };
  observedAt: string;
}
