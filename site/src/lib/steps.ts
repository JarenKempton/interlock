export const LOOP = 20;
export const BOUNDS = [0, 3.5, 5.5, 10, 16, 19.5];
export const HOLD = 0.85;

export const pct = (s: number) => (s / LOOP) * 100;
export const holdAt = (k: number) => BOUNDS[k]! + (BOUNDS[k + 1]! - BOUNDS[k]!) * HOLD;
export const remap = (old: number) => {
  const k = Math.min(4, Math.floor(old / 20));
  const f = (old - k * 20) / 20;
  return Math.round(pct(BOUNDS[k]! + f * (BOUNDS[k + 1]! - BOUNDS[k]!)) * 100) / 100;
};
