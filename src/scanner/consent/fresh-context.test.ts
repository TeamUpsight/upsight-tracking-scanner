import { describe, expect, it, vi } from 'vitest';
import {
  consentNavigationReadiness,
  createConsentGeoEvidence,
  createFreshConsentContext,
  navigateFreshConsentContext
} from './fresh-context';

function fakeContext() {
  const page = {
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined)
  };
  const cdp = {
    send: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined)
  };
  return {
    page,
    cdp,
    context: {
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      newCDPSession: vi.fn().mockResolvedValue(cdp),
      newPage: vi.fn().mockResolvedValue(page)
    }
  };
}

describe('fresh Consent V2 context', () => {
  it('always creates a separate clean context with service workers blocked', async () => {
    const first = fakeContext();
    const second = fakeContext();
    const browser = { newContext: vi.fn().mockResolvedValueOnce(first.context).mockResolvedValueOnce(second.context) };

    const firstSession = await createFreshConsentContext(browser as any, { requestedGeo: 'USA', proxyRegion: 'us' });
    const secondSession = await createFreshConsentContext(browser as any, { requestedGeo: 'USA', proxyRegion: 'us' });

    expect(firstSession.context).not.toBe(secondSession.context);
    expect(browser.newContext).toHaveBeenCalledTimes(2);
    expect(browser.newContext).toHaveBeenNthCalledWith(1, expect.objectContaining({ serviceWorkers: 'block' }));
    expect(browser.newContext).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ storageState: expect.anything() }));
    expect(browser.newContext).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ proxy: expect.anything() }));
    expect(first.context.newPage).toHaveBeenCalledTimes(1);
  });

  it('uses commit, DOMContentLoaded, and a bounded observation rather than networkidle', async () => {
    const { page } = fakeContext();
    await navigateFreshConsentContext(page as any, 'https://storefront.example.test', {
      navigationTimeoutMs: 8_000,
      timings: { initialObservationMs: 500, providerReadinessMs: 300, postActionSettleMs: 300, reloadSettleMs: 500 }
    });

    expect(page.goto).toHaveBeenCalledWith('https://storefront.example.test', { waitUntil: 'commit', timeout: 8_000 });
    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 300 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('records unverified geo and preserves blocked access without a no-CMP conclusion', () => {
    expect(createConsentGeoEvidence({ requestedGeo: 'EU', proxyRegion: 'de' })).toMatchObject({
      verified: null, verification_method: 'proxy_metadata', reason_codes: ['GEO_UNVERIFIED']
    });
    expect(consentNavigationReadiness({ category: 'bot_protection' })).toEqual({
      status: 'blocked_or_challenged', reason_codes: ['BLOCKED_OR_CHALLENGED']
    });
  });

  it('records EU Bulgaria egress as verified only when the egress probe independently confirms it', () => {
    expect(createConsentGeoEvidence({ requestedGeo: 'EU', proxyRegion: 'bg' })).toMatchObject({
      requested_geo: 'EU', proxy_region: 'bg', verified: null, verification_method: 'proxy_metadata', confidence: 'low', reason_codes: ['GEO_UNVERIFIED']
    });
    expect(createConsentGeoEvidence({ requestedGeo: 'EU', proxyRegion: 'bg', independentlyVerified: true })).toMatchObject({
      requested_geo: 'EU', proxy_region: 'bg', verified: true, verification_method: 'egress_probe', confidence: 'high', reason_codes: []
    });
  });

  it('applies the confirmed Bulgarian profile to the fresh Consent context', async () => {
    const { context, page, cdp } = fakeContext();
    const browser = { newContext: vi.fn().mockResolvedValue(context) };
    const session = await createFreshConsentContext(browser as any, { requestedGeo: 'EU', proxyRegion: 'bg', independentlyVerified: true });

    expect(session.geo).toMatchObject({ requested_geo: 'EU', proxy_region: 'bg', verified: true, verification_method: 'egress_probe', confidence: 'high' });
    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({ 'Accept-Language': expect.stringMatching(/^bg-BG,bg/) });
    expect(cdp.send).toHaveBeenCalledWith('Emulation.setLocaleOverride', { locale: 'bg-BG' });
    expect(cdp.send).toHaveBeenCalledWith('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Sofia' });
  });
});
