/** Injectable clock so analysis/generation timestamps stay deterministic in tests. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
