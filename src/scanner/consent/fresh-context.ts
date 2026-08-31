import type { Browser, BrowserContext, Page, Response } from 'playwright-core';
import { consentTimingValues, type ConsentTimingValues } from '../../shared/config';
import { configureBrowserGeo } from '../browser-session';
import type { AccessDecision } from '../navigation';
import { ConsentAuditCodes, type ConsentAuditCode } from './domain-types';

export interface ConsentGeoEvidence {
  requested_geo: 'USA' | 'EU' | 'UK';
  proxy_region: string | null;
  verified: boolean | null;
  verification_method: 'proxy_metadata' | 'egress_probe' | 'unavailable';
  confidence: 'high' | 'medium' | 'low';
  reason_codes: ConsentAuditCode[];
}

export interface FreshConsentContext {
  context: BrowserContext;
  page: Page;
  geo: ConsentGeoEvidence;
  service_workers: 'blocked';
}

export interface ConsentNavigationResult {
  response: Response | null;
  dom_content_loaded: boolean;
}

export function createConsentGeoEvidence(input: {
  requestedGeo: 'USA' | 'EU' | 'UK';
  proxyRegion: string | null;
  independentlyVerified?: boolean | null;
}): ConsentGeoEvidence {
  if (input.independentlyVerified === true) {
    return {
      requested_geo: input.requestedGeo,
      proxy_region: input.proxyRegion,
      verified: true,
      verification_method: 'egress_probe',
      confidence: 'high',
      reason_codes: []
    };
  }
  return {
    requested_geo: input.requestedGeo,
    proxy_region: input.proxyRegion,
    verified: input.independentlyVerified === false ? false : null,
    verification_method: input.proxyRegion ? 'proxy_metadata' : 'unavailable',
    confidence: 'low',
    reason_codes: [ConsentAuditCodes.GEO_UNVERIFIED]
  };
}

export function consentNavigationReadiness(access: Pick<AccessDecision, 'category'>) {
  const blocked = access.category !== 'none';
  return blocked
    ? { status: 'blocked_or_challenged' as const, reason_codes: [ConsentAuditCodes.BLOCKED_OR_CHALLENGED] }
    : { status: 'ready' as const, reason_codes: [] as ConsentAuditCode[] };
}

export async function createFreshConsentContext(
  browser: Browser,
  input: {
    requestedGeo: 'USA' | 'EU' | 'UK';
    proxyRegion: string;
    independentlyVerified?: boolean | null;
  }
): Promise<FreshConsentContext> {
  // CDP connection setup owns proxy configuration. A new context inherits that
  // configured browser-session transport but never loads a storage state.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block'
  });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(15_000);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await configureBrowserGeo(context, page, input.proxyRegion);
  return {
    context,
    page,
    geo: createConsentGeoEvidence(input),
    service_workers: 'blocked'
  };
}

export async function navigateFreshConsentContext(
  page: Page,
  url: string,
  options: {
    navigationTimeoutMs?: number;
    timings?: ConsentTimingValues;
  } = {}
): Promise<ConsentNavigationResult> {
  const timings = options.timings || consentTimingValues();
  const response = await page.goto(url, { waitUntil: 'commit', timeout: options.navigationTimeoutMs || 15_000 });
  let domContentLoaded = true;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timings.providerReadinessMs });
  } catch {
    // Main-document commit is still useful evidence; callers retain the bounded
    // observation rather than treating this as a network-idle requirement.
    domContentLoaded = false;
  }
  await page.waitForTimeout(timings.initialObservationMs);
  return { response, dom_content_loaded: domContentLoaded };
}
