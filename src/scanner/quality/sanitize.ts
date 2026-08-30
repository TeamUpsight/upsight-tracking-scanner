const SENSITIVE_KEY_PARTS = [
  'authorization', 'password', 'secret', 'token', 'api_key', 'apikey',
  'credential', 'set-cookie', 'cookie_values', 'cookie_value'
];

const SENSITIVE_EXACT_KEYS = new Set([
  'cookie', 'cookies', 'proxy_url', 'proxy_server', 'proxy_username', 'proxy_password',
  'browserless_url', 'browserless_token', 'decodo_proxy_usa', 'decodo_proxy_uk', 'decodo_proxy_eu'
]);

const SAFE_PRESENCE_KEYS = new Set(['has_token', 'token_present', 'has_external_proxy']);

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase();
  return SENSITIVE_EXACT_KEYS.has(normalized) ||
    SENSITIVE_KEY_PARTS.some((sensitive) => normalized.includes(sensitive));
}

function sanitizeString(value: string) {
  let result = value
    .replace(/(?:https?|wss?):\/\/[^\s:@/]+:[^\s:@/]+@/gi, 'https://[REDACTED_CREDENTIALS]@')
    .replace(/\bey[A-Za-z0-9_-]+\.ey[A-Za-z0-9_-]+\.?[A-Za-z0-9_.+/=-]*/g, '[REDACTED_JWT]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
  for (const key of ['token', 'access_token', 'externalProxyServer', 'proxy', 'session', 'checkout', 'customer', 'auth', 'password', 'username']) {
    result = result.replace(new RegExp(`([?&]${key}=)[^&#\\s]+`, 'gi'), `$1[REDACTED]`);
  }
  return result;
}

export function sanitizeValue(value: unknown, parentKey = ''): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, parentKey));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (SAFE_PRESENCE_KEYS.has(normalized) && typeof child === 'boolean') {
        output[key] = child;
      } else if (isSensitiveKey(normalized)) {
        output[key] = normalized.includes('cookie') ? '[REDACTED_COOKIE]' : '[REDACTED_SENSITIVE_VALUE]';
      } else {
        output[key] = sanitizeValue(child, key);
      }
    }
    return output;
  }
  if (typeof value === 'string') {
    if (isSensitiveKey(parentKey)) return '[REDACTED_SENSITIVE_VALUE]';
    return sanitizeString(value);
  }
  return value;
}

export function sanitizeTrace(trace: unknown[]) {
  return sanitizeValue(trace) as unknown[];
}
