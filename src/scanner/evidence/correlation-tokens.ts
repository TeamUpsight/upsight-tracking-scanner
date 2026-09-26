import { randomBytes } from 'node:crypto';
import type { TrackingRequestEvidence } from '../../types';
import { safeObservedPageUrl } from '../tracking/page-provenance';

type CorrelationKind = keyof NonNullable<TrackingRequestEvidence['correlation']>;

/** Ephemeral per-audit or per-replay equality tokens. Raw values never leave this map. */
export class CorrelationTokens {
  private readonly prefix = randomBytes(12).toString('base64url');
  private readonly values = new Map<string, string>();

  token(kind: CorrelationKind, raw: string | undefined): string | undefined {
    if (!raw || raw.length > 512) return undefined;
    const key = `${kind}\0${raw}`;
    const existing = this.values.get(key);
    if (existing) return existing;
    if (this.values.size >= 2_000) return undefined;
    const token = `${this.prefix}.${this.values.size.toString(36)}`;
    this.values.set(key, token);
    return token;
  }
}

type LegacyRequest = TrackingRequestEvidence & {
  client_id?: string;
  session_id?: string;
  fbp?: string;
  fbc?: string;
};

/** Copies historical evidence into the current contract without retaining raw IDs. */
export function normalizeRequestCorrelation(request: TrackingRequestEvidence, tokens: CorrelationTokens): TrackingRequestEvidence {
  const { client_id, session_id, fbp, fbc, ...safe } = request as LegacyRequest;
  const correlation = {
    ...safe.correlation,
    ga4_client: safe.correlation?.ga4_client || tokens.token('ga4_client', client_id),
    ga4_session: safe.correlation?.ga4_session || tokens.token('ga4_session', session_id),
    meta_browser: safe.correlation?.meta_browser || tokens.token('meta_browser', fbp),
    meta_click: safe.correlation?.meta_click || tokens.token('meta_click', fbc)
  };
  return {
    ...safe,
    page_url: safe.page_url ? safeObservedPageUrl(safe.page_url) : undefined,
    correlation: Object.values(correlation).some(Boolean) ? correlation : undefined
  };
}
