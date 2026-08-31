export function boundedInteger(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}

export const DEFAULT_GLOBAL_SCAN_TIMEOUT_MS = 90_000;

// This is the one global audit deadline. Both the queue cancellation timer and
// the scanner runtime resolve it through this helper so they cannot drift.
export function globalScanTimeoutMs() {
  return boundedInteger(process.env.AUDIT_TIMEOUT_MS, DEFAULT_GLOBAL_SCAN_TIMEOUT_MS, 30_000, 300_000);
}

export function bulkProxyRetryLimit() {
  return boundedInteger(process.env.DECODO_MAX_RETRIES_BULK, 1, 0, 1);
}

export function singleProxyRetryLimit() {
  return boundedInteger(process.env.DECODO_MAX_RETRIES_SINGLE, 1, 0, 1);
}
