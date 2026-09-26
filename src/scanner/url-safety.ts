import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Reject destinations that a remote browser must never be asked to visit. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && c === 0) ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower.includes('.')) return false; // IPv4-mapped and embedded forms.
    const first = Number.parseInt(lower.split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !lower.startsWith('2001:db8:') && !lower.startsWith('2001:10:');
  }
  return false;
}

export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return Boolean(host) && host.length <= 253 && !/\s/.test(host) &&
    !/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) &&
    (isIP(host) ? isPublicAddress(host) : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host));
}

export function isPublicWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username && !url.password && isPublicHostname(url.hostname);
  } catch {
    return false;
  }
}

/** DNS is checked at the browser request boundary, including redirect requests. */
export async function resolvesOnlyToPublicAddresses(
  hostname: string,
  lookupAddresses: typeof lookup = lookup
): Promise<boolean> {
  if (!isPublicHostname(hostname)) return false;
  if (isIP(hostname)) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      lookupAddresses(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS safety lookup timed out')), 3_000); })
    ]);
    return addresses.length > 0 && addresses.every((item) => isPublicAddress(item.address));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
