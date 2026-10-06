const FIRST_MS = 250;
const MAX_MS = 5000;

/** Delay before reconnect attempt `attempt` (1-based). */
export const reconnectDelay = (attempt: number): number => Math.min(MAX_MS, FIRST_MS * 2 ** Math.max(0, attempt - 1));
