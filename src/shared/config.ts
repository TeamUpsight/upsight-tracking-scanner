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

