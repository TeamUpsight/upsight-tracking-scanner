import { describe, expect, it } from 'vitest';
import browserError from '../../tests/fixtures/access-browser-error-page.json';
import { detectBrowserErrorPage, isValidStorefrontStatus, resolveAccessDecision } from './navigation';

describe('browser error page access classification', () => {
  it.each([
    'chrome-error://chromewebdata/', 'chrome://chromewebdata/',
    'chrome://network-error/', 'edge-error://chromewebdata/', 'about:neterror?e=dnsNotFound'
  ])('rejects internal error URL %s despite HTTP 200', (url) => {
    expect(resolveAccessDecision({ status: 200, url })).toMatchObject({ category: 'access_blocked', reasonCode: 'BROWSER_ERROR_PAGE' });
  });

  it('rejects the Audit-632-shaped document despite a valid HTTP status', () => {
    expect(isValidStorefrontStatus(browserError.status)).toBe(true);
    expect(resolveAccessDecision(browserError)).toMatchObject({
      category: 'access_blocked', reasonCode: 'BROWSER_ERROR_PAGE', botProvider: null, botSignals: [], challengeType: null
    });
  });

  it.each(['ERR_CONNECTION_RESET', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_TIMED_OUT',
    'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_CLOSED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_NETWORK_CHANGED', 'ERR_HTTP2_PROTOCOL_ERROR'])
  ('rejects canonical reachability presentation plus %s with a hostname title', (code) => {
    expect(resolveAccessDecision({ status: 200, url: 'https://fixture.example/', title: 'fixture.example',
      bodyText: `This site can’t be reached\nfixture.example unexpectedly closed the connection.\n${code}\nReload` }))
      .toMatchObject({ category: 'access_blocked', reasonCode: 'BROWSER_ERROR_PAGE' });
  });

  it('recognizes the canonical title and standard explanatory body without a code', () => {
    expect(detectBrowserErrorPage({ ...browserError, bodyText: browserError.bodyText.replace('ERR_HTTP2_PROTOCOL_ERROR', ''), domSignals: [] })).toBe(true);
  });

  it('recognizes browser DOM structure and heading without a code or canonical title', () => {
    expect(detectBrowserErrorPage({ status: 200, title: 'fixture.example', bodyText: "This page couldn't load\nReload",
      domSignals: ['body.neterror', '#main-frame-error'] })).toBe(true);
  });

  it('recognizes the legacy Chromium unavailable presentation', () => {
    expect(detectBrowserErrorPage({ status: 200, title: 'This webpage is not available',
      bodyText: 'This webpage is not available\nERR_CONNECTION_CLOSED' })).toBe(true);
  });

  it.each([
    ['Check if there is a typo in fixture.example.', 'ERR_NAME_NOT_RESOLVED'],
    ['The connection was reset. Try: Checking the connection Checking the proxy and the firewall', 'ERR_CONNECTION_RESET']
  ])('recognizes hostname-title Chromium presentation: %s', (detail, code) => {
    expect(resolveAccessDecision({ status: 200, title: 'fixture.example',
      bodyText: `This site can't be reached\n${detail}\n${code}\nReload` }))
      .toMatchObject({ category: 'access_blocked', reasonCode: 'BROWSER_ERROR_PAGE' });
  });

  it.each([
    { title: 'Fixture shop', bodyText: "Welcome to our store. Browse hundreds of products and add them to your cart. If this page couldn't load previously, please contact our support team." },
    { title: 'Fixture shop', bodyText: 'Welcome to our store. Help article: This site can\'t be reached ERR_CONNECTION_RESET. Continue shopping.' },
    { title: 'Fixture shop', bodyText: "This page couldn't load. Our app is having trouble. Please try again." },
    { title: "This page couldn't load", bodyText: "This page couldn't load" },
    { title: 'Branded maintenance', bodyText: "This page couldn't load. Our store is undergoing maintenance. Please return later." },
    { title: 'Fixture app', bodyText: "This page couldn't load. Request error: ERR_CONNECTION_RESET. Return to our store." },
    { title: 'Support', bodyText: 'ERR_NAME_NOT_RESOLVED' },
    { title: 'Fixture shop', bodyText: "This page couldn't load\nERR_UNKNOWN_APPLICATION_CODE" },
    { title: 'Fixture shop', bodyText: 'Shop' },
    { title: 'Fixture shop', bodyText: '', url: 'https://fixture.example/chromewebdata/?next=chrome-error://chromewebdata/' },
    { status: 404, title: 'Product not found', bodyText: 'This product is unavailable. Browse our catalog.' }
  ])('preserves existing behavior for legitimate or weak-signature content %#', (facts) => {
    expect(detectBrowserErrorPage({ status: 200, url: 'https://fixture.example/', ...facts })).toBe(false);
    expect(resolveAccessDecision({ status: 200, url: 'https://fixture.example/', ...facts }))
      .toMatchObject({ category: 'none', reasonCode: 'STOREFRONT_VALID' });
  });

  it.each([
    { status: 200, title: 'Just a moment', bodyText: 'Checking your browser', headers: { 'cf-ray': 'fixture' }, category: 'bot_protection', reasonCode: 'CLOUDFLARE_CHALLENGE' },
    { status: 403, category: 'access_blocked', reasonCode: 'HTTP_403' },
    { status: 429, category: 'rate_limited', reasonCode: 'RATE_LIMITED' },
    { status: 407, category: 'proxy_error', reasonCode: 'PROXY_PROVIDER_UNREACHABLE' }
  ])('preserves existing $reasonCode classification', ({ category, reasonCode, ...facts }) => {
    expect(resolveAccessDecision(facts)).toMatchObject({ category, reasonCode });
  });

  it.each([
    { status: 407, category: 'proxy_error', reasonCode: 'PROXY_PROVIDER_UNREACHABLE' },
    { status: 429, category: 'rate_limited', reasonCode: 'RATE_LIMITED' },
    { status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'fixture' }, category: 'bot_protection', reasonCode: 'CLOUDFLARE_CHALLENGE' }
  ])('preserves $reasonCode precedence over browser presentation', ({ category, reasonCode, ...facts }) => {
    expect(resolveAccessDecision({ ...browserError, ...facts })).toMatchObject({ category, reasonCode });
  });
});
