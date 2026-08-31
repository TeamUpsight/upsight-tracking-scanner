import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, StorefrontAudit, TrackingRequestEvidence } from '../types';
import { detectCMP } from './consent/detect-cmp';
import { EvidenceCollector } from './evidence/evidence-collector';
import { enforceConsistency } from './quality/consistency';
import { replayEvidence } from './quality/replay';
import { sanitizeValue } from './quality/sanitize';
import { reviewAudit } from './quality/audit-reviewer';
import { buildDebugPackageFiles } from './quality/debug-package';
import { buildQualityMetrics } from './quality/metrics';
import { buildLatestReviewQueue } from './quality/review-queue';
import { calculateQaPriority, generateFailureFingerprints, qaPrioritySignals } from './quality/fingerprints';
import { buildBrowserlessCdpUrl, buildRotatingFallbackProxy, getExternalProxyForGeo, rotateDecodoSessionUsername } from './proxy/decodo';
import { buildProxyAttemptPlan, classifyConfirmedTunnelFailure, shouldUseBrowserlessResidentialFallback } from './proxy/provider';
import { decideAccessTransition } from './access-state-machine';
import { FinalizeOnce } from './resolver/lifecycle';
import { resolveProductPayloadStatus } from './resolver/status-resolver';
import { classifyCollection, findStrictDuplicates } from './server-side/classify-collection';
import { parseGA4DataLayerEntry, parseGA4Request } from './tracking/ga4';
import { hasMetaBootstrapInText, parseMetaPixelIdsFromText, parseMetaRequest } from './tracking/meta';
import {
  assessPdpCandidate, classifyBrowserConnectionError, classifyNavigationError, consentChoiceSelectors, isEvidenceBackedExternalRedirect,
  canKeepTimedOutPdp, isStrongProductPath, isViewItemForPdp, parseEgressCountry, pdpCandidateRejectionReason,
  pdpReadinessSatisfied, prioritizePdpCandidatePool, productPatternPdpCandidate, trustArcPreferenceControls, twoLevelPdpCandidate
} from './audit-runner';
import { parseRetryAfterMs, resolveAccessDecision, resolveHostnameEvidence, resolveHostnameStatus } from './navigation';
import { OrderedAuditUpdates } from './persistence/ordered-updates';
import { browserGeoProfile } from './browser-session';
import { createBrowserQlHandoff } from './browserless-bql';
import { verifyConsentAcceptance, verifyConsentRejection } from './consent/consent-state';
import { AUDIT_MODULE_ORDER, normalizeAuditModules } from '../audit-modules';

function baseEvidence(name = 'example.com'): EvidenceBundle {
  return new EvidenceCollector({ auditId: name, domain: name, geo: 'USA', mode: 'normal', startedAt: '2026-08-27T00:00:00.000Z' }).bundle;
}

describe('audit module selection', () => {
  it('defaults historical evidence, rejects invalid selections, and canonicalizes order', () => {
    expect(normalizeAuditModules(undefined)).toEqual(AUDIT_MODULE_ORDER);
    expect(normalizeAuditModules([])).toBeNull();
    expect(normalizeAuditModules(['tracking', 'invalid'])).toBeNull();
    expect(normalizeAuditModules(['server_side', 'tracking', 'tracking'])).toEqual(['tracking', 'server_side']);
  });

  it.each([
    ['consent'], ['tracking'], ['server_side'], ['consent', 'tracking'], ['consent', 'server_side'], ['tracking', 'server_side'], AUDIT_MODULE_ORDER
  ])('keeps unselected modules not_tested for %o', (selected_modules) => {
    const evidence = baseEvidence('modules.example');
    evidence.selected_modules = selected_modules as any;
    evidence.page.valid = true;
    evidence.consent.executed = selected_modules.includes('consent');
    evidence.product.executed = selected_modules.includes('tracking');
    evidence.server_side.executed = selected_modules.includes('server_side');
    const result = replayEvidence(evidence);
    if (!selected_modules.includes('consent')) expect(result.consent_status).toBe('not_tested');
    if (!selected_modules.includes('tracking')) expect(result.product_payload_status).toBe('not_tested');
    if (!selected_modules.includes('server_side')) expect(result.server_side_status).toBe('not_tested');
  });

  it('does not let skipped modules affect replay, consistency, QA, or fingerprints', () => {
    const evidence = baseEvidence('tracking-only.example');
    evidence.selected_modules = ['tracking'];
    evidence.page.valid = true;
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://tracking-only.example/products/item'];
    evidence.product.navigation_succeeded = true;
    evidence.server_side.executed = false;
    evidence.server_side.first_party_collection_count = 1;
    evidence.consent.executed = false;
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({ scan_status: 'completed', consent_status: 'not_tested', server_side_status: 'not_tested', overall_status: 'warning' });
    expect(result.consistency_violations).toEqual([]);
    expect(result.failure_fingerprints).not.toContain('SERVER_FP_COLLECTOR');
    expect(qaPrioritySignals(result, evidence, result.consistency_violations || []).map((signal) => signal.code)).not.toContain('MODULE_RESULT_INCOMPLETE');
  });

  it('uses a normalized replay copy, defaults legacy module selections, and leaves evidence untouched', () => {
    const evidence = baseEvidence('legacy-replay.example');
    evidence.selected_modules = undefined;
    evidence.page.valid = true;
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://legacy-replay.example/products/item'];
    evidence.product.navigation_succeeded = true;
    const result = replayEvidence(evidence);
    expect(result.selected_modules).toEqual(AUDIT_MODULE_ORDER);
    expect(evidence.selected_modules).toBeUndefined();

    evidence.selected_modules = ['server_side'];
    evidence.server_side.collector_cookie_persistence_checked = true;
    const before = structuredClone(evidence);
    expect(replayEvidence(evidence).consistency_violations).toContain('COLLECTOR_COOKIE_CHECK_WITHOUT_COLLECTOR');
    expect(evidence).toEqual(before);
  });

  it('preserves recorded access observations and flags conflicting access facts during replay', () => {
    const evidence = baseEvidence('access-replay.example');
    evidence.selected_modules = ['tracking'];
    evidence.page.valid = false;
    evidence.page.status_code = 403;
    evidence.page.final_url = 'https://access-replay.example/challenge';
    evidence.page.access_category = 'bot_protection';
    evidence.access.valid_storefront = true;
    evidence.access.http_status = 200;
    evidence.access.final_url = 'https://access-replay.example/';
    const result = replayEvidence(evidence);
    expect(result.evidence_bundle).toMatchObject({
      selected_modules: ['tracking'],
      page: { valid: false, status_code: 403 },
      access: { valid_storefront: true, http_status: 200 }
    });
    expect(result.consistency_violations).toEqual(expect.arrayContaining([
      'ACCESS_VALIDITY_CONTRADICTION', 'ACCESS_HTTP_STATUS_CONTRADICTION', 'ACCESS_FINAL_URL_CONTRADICTION', 'ACCESS_SUCCESS_CATEGORY_CONTRADICTION'
    ]));
    expect(qaPrioritySignals(result, evidence, result.consistency_violations || []).map((signal) => signal.code)).toContain('ACCESS_STATE_CONTRADICTION');
    const review = reviewAudit({ audit: result, trace: [{ step: 'scan_finalized' }], evidence: result.evidence_bundle! });
    expect(review.violations).toContainEqual(expect.objectContaining({ code: 'ACCESS_VALIDITY_CONTRADICTION' }));
    expect(review.patch_plan.join(' ')).toMatch(/Do not auto-fix runtime state/);
  });

  it('preserves tracking without a Consent audit and server-side without PDP discovery', () => {
    const tracking = baseEvidence('tracking-alone.example');
    tracking.selected_modules = ['tracking'];
    tracking.page.valid = true;
    tracking.product.executed = true;
    tracking.product.discovery_executed = true;
    tracking.product.pdp_candidates = ['https://tracking-alone.example/products/item'];
    tracking.product.pdp_url = 'https://tracking-alone.example/products/item';
    tracking.product.navigation_succeeded = true;
    tracking.product.ga4_view_item_hits = [{ vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect', method: 'POST', phase: 'product_pdp_load', timestamp: 1, event: 'view_item', has_product: true }];
    expect(replayEvidence(tracking).product_payload_status).toBe('pass');

    const server = baseEvidence('server-alone.example');
    server.selected_modules = ['server_side'];
    server.page.valid = true;
    server.server_side.executed = true;
    expect(replayEvidence(server)).toMatchObject({ product_payload_status: 'not_tested', server_side_status: 'not_detected' });
  });

  it('records Tracking-only CMP enablement without executing the Consent module', () => {
    const evidence = baseEvidence('tracking-cmp.example');
    evidence.selected_modules = ['tracking'];
    evidence.page.valid = true;
    evidence.consent.executed = false;
    evidence.consent.tracking_enablement = 'accepted';
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://tracking-cmp.example/product/model'];
    evidence.product.final_pdp_url = 'https://tracking-cmp.example/product/model';
    evidence.product.navigation_succeeded = true;
    const result = replayEvidence(evidence);
    expect(result.consent_status).toBe('not_tested');
    expect(result.reason_codes).not.toContain('CMP_NOT_TESTED');
    expect(evidence.consent.executed).toBe(false);
  });

  it('keeps GA4 installation separate from collection and view_item semantics', () => {
    const evidence = baseEvidence('ga4-script.example');
    evidence.selected_modules = ['tracking'];
    evidence.page.valid = true;
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://ga4-script.example/product/model'];
    evidence.product.final_pdp_url = 'https://ga4-script.example/product/model';
    evidence.product.navigation_succeeded = true;
    evidence.network.relevant_requests = [{
      vendor: 'ga4', kind: 'script', collector: 'third_party', host: 'www.googletagmanager.com', path: '/gtag/js',
      method: 'GET', phase: 'consent_initial_load', timestamp: 1, measurement_id: 'G-TEST'
    }];
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({ site_ga4_detected: true, site_ga4_collection_hit_detected: false, product_payload_status: 'missing_view_item' });
    expect(result.finding_confidence?.ga4.reason_code).toBe('GA4_SCRIPT_ONLY');
  });
});

describe('centralized tracking parsers', () => {
  it('parses the exact Laird Superfood GA4 request fixture', () => {
    const url = readFileSync(path.join(process.cwd(), 'tests/fixtures/laird-ga4-view-item-url.txt'), 'utf8').trim();
    const parsed = parseGA4Request(url);
    expect(parsed).toMatchObject({
      measurement_id: 'G-EQKQBN73B3',
      event: 'view_item',
      has_product: true,
      product_id: 'shopify_US_7239461077027_42668183912483',
      product_name: 'Original - Protein Matcha',
      brand: 'Laird Superfood',
      category: 'Protein Coffee',
      value: 18
    });
    expect(parsed?.page_url).toContain('/products/protein-matcha');
  });

  it('keeps GA4 collection and ecommerce parameter parsing shared for delayed PDP evidence', () => {
    const parsed = parseGA4Request('https://analytics.google.com/g/collect?v=2&tid=G-TEST123&en=view_item&dl=https%3A%2F%2Fexample.com%2Fproduct%2Fcanonical&pr1=idSKU-1~nmExample&pr2=idSKU-2~nmSecond&ep.ecomm_prodid=SKU-1&ep.ecomm_pagetype=product&epn.ecomm_totalvalue=42');
    expect(parsed).toMatchObject({ kind: 'collection', event: 'view_item', has_product: true, product_id: 'SKU-1', value: 42 });
  });

  it('does not identify GTM or a generic collect URL as GA4', () => {
    expect(parseGA4Request('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123')).toBeNull();
    expect(parseGA4Request('https://example.com/collect?event=page_view')).toBeNull();
  });

  it('recognizes valid first-party GA4 collection', () => {
    const parsed = parseGA4Request('https://data.example.com/g/collect?v=2&tid=G-ABC123&en=page_view&dl=https%3A%2F%2Fexample.com');
    expect(parsed?.kind).toBe('collection');
    expect(parsed?.endpoint_type).toBe('first_party');
  });

  it('uses one strict Meta parser for scripts and collection', () => {
    expect(parseMetaRequest('https://connect.facebook.net/en_US/fbevents.js')?.kind).toBe('script');
    expect(parseMetaRequest(readFileSync(path.join(process.cwd(), 'tests/fixtures/morphe-meta-config-url.txt'), 'utf8').trim())).toMatchObject({
      kind: 'script', pixel_id: '2137020719856697'
    });
    expect(parseMetaRequest('https://www.facebook.com/tr/?id=123456&ev=ViewContent&dl=https%3A%2F%2Fexample.com%2Fp')).toMatchObject({
      kind: 'collection', event: 'ViewContent', pixel_id: '123456'
    });
    expect(parseMetaRequest('https://example.com/tr/?ev=ViewContent')).toBeNull();
    expect(parseMetaPixelIdsFromText("fbq('init', '540863870609660');")).toEqual(['540863870609660']);
    const shopifyMetaConfig = readFileSync(path.join(process.cwd(), 'tests/fixtures/morphe-shopify-meta-pixel-config.txt'), 'utf8');
    expect(parseMetaPixelIdsFromText(shopifyMetaConfig)).toEqual(['2137020719856697']);
    expect(hasMetaBootstrapInText(shopifyMetaConfig)).toBe(true);
    expect(hasMetaBootstrapInText('<script type="text/plain" data-src="https://connect.facebook.net/en_US/fbevents.js"></script>')).toBe(true);
    expect(hasMetaBootstrapInText('<script src="https://example.com/events.js"></script>')).toBe(false);
  });

  it('parses the sanitized Lakanto delayed view_item fixture without binding it to another measurement ID', () => {
    const parsed = parseGA4Request(readFileSync(path.join(process.cwd(), 'tests/fixtures/lakanto-ga4-view-item-url.txt'), 'utf8').trim());
    expect(parsed).toMatchObject({
      measurement_id: 'G-F6SB9KYWT4', event: 'view_item', has_product: true,
      product_id: 'shopify_US_10559890639_12122285539404', product_name: 'Classic Monkfruit and Erythritol Sweetener - White Sugar Replacement',
      brand: 'Lakanto', category: 'Sweetener', value: 14.59
    });
  });

  it('parses the QA-confirmed Jabra Enhance and Peloton view_item payloads', () => {
    const jabra = parseGA4Request(readFileSync(path.join(process.cwd(), 'tests/fixtures/jabra-enhance-view-item-url.txt'), 'utf8').trim());
    expect(jabra).toMatchObject({
      measurement_id: 'G-8VW0JF1BY1', event: 'view_item', has_product: true,
      product_id: 'listen-lively-OTC_M3_SparklingSilver', product_name: 'Enhance Select M3 (rechargeable)'
    });
    const listenLivelyM2 = parseGA4Request(readFileSync(path.join(process.cwd(), 'tests/fixtures/listenlively-m2-view-item-url.txt'), 'utf8').trim());
    expect(listenLivelyM2).toMatchObject({
      measurement_id: 'G-8VW0JF1BY1', event: 'view_item', has_product: true,
      product_id: 'listen-lively-OTC_M2_SparklingSilver', product_name: 'Enhance Select M2 (rechargeable)',
      category: 'hearing_aid', value: 1695
    });
    const listenLivelyM1 = parseGA4Request(readFileSync(path.join(process.cwd(), 'tests/fixtures/listenlively-m1-view-item-url.txt'), 'utf8').trim());
    expect(listenLivelyM1).toMatchObject({
      measurement_id: 'G-8VW0JF1BY1', event: 'view_item', has_product: true,
      product_id: 'listen-lively-OTC_M1_SparklingSilver', product_name: 'Enhance Select M1 (rechargeable)',
      category: 'hearing_aid', value: 1195
    });
    const peloton = parseGA4Request(readFileSync(path.join(process.cwd(), 'tests/fixtures/peloton-view-item-url.txt'), 'utf8').trim());
    expect(peloton).toMatchObject({
      measurement_id: 'G-QXQMS1JJBG', event: 'view_item', has_product: true,
      product_id: 'cebeb1f697fb41ba852e8cf6ed1bdbc4', product_name: 'Cross Training Bike+'
    });
  });

  it('parses arguments-style and object-style GA4 dataLayer view_item entries', () => {
    const argumentsStyle = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/listenlively-m2-datalayer.json'), 'utf8'));
    expect(parseGA4DataLayerEntry(argumentsStyle)).toMatchObject({
      kind: 'data_layer', event: 'view_item', has_product: true,
      product_id: 'listen-lively-OTC_M2_SparklingSilver', product_name: 'Enhance Select M2 (rechargeable)',
      category: 'hearing_aid', value: 1695
    });
    expect(parseGA4DataLayerEntry({
      event: 'view_item',
      ecommerce: { items: [{ item_id: 'SKU-1', item_name: 'Example Product', price: 12.5 }] }
    })).toMatchObject({ event: 'view_item', has_product: true, product_id: 'SKU-1', value: 12.5 });
    expect(parseGA4DataLayerEntry({ event: 'view_item', ecommerce: { items: [] } })).toBeNull();
    expect(parseGA4DataLayerEntry({ event: 'page_view', items: [{ item_id: 'SKU-1' }] })).toBeNull();
  });
});

describe('PDP candidate selection', () => {
  it('accepts safe two-level paths and rejects one-level, deeper, external, and obvious non-product paths', () => {
    expect(twoLevelPdpCandidate('https://example.com/catalog/item-one?variant=1#details', 'example.com')).toBe('https://example.com/catalog/item-one');
    expect(twoLevelPdpCandidate('https://example.com/item-one', 'example.com')).toBeNull();
    expect(twoLevelPdpCandidate('https://example.com/catalog/sale/item-one', 'example.com')).toBeNull();
    expect(twoLevelPdpCandidate('https://other.example/catalog/item-one', 'example.com')).toBeNull();
    expect(twoLevelPdpCandidate('https://example.com/blogs/news', 'example.com')).toBeNull();
  });

  it('ranks established product-path candidates first but retains generic fallback candidates', () => {
    expect(productPatternPdpCandidate('https://example.com/store/products/item-one', 'example.com')).toBe('https://example.com/store/products/item-one');
    expect(prioritizePdpCandidatePool(['product-one', 'product-two'], ['fallback-one', 'product-one'])).toEqual(['product-one', 'product-two', 'fallback-one']);
    expect(prioritizePdpCandidatePool([], ['fallback-one'])).toEqual(['fallback-one']);
  });

  it('rejects comparison URLs when the second path level contains -vs- or compare', () => {
    expect(productPatternPdpCandidate('https://example.com/product/model-a-vs-model-b', 'example.com')).toBeNull();
    expect(productPatternPdpCandidate('https://example.com/product/compare-models', 'example.com')).toBeNull();
    expect(twoLevelPdpCandidate('https://example.com/catalog/compare-products', 'example.com')).toBeNull();
    expect(productPatternPdpCandidate('https://example.com/product/model-a', 'example.com')).toBe('https://example.com/product/model-a');
  });

  it('keeps PDP candidate ordering deterministic so an explicit failure can reach fallback', () => {
    const candidates = prioritizePdpCandidatePool(['https://example.com/product/unavailable'], ['https://example.com/catalog/working']);
    expect(candidates).toEqual(['https://example.com/product/unavailable', 'https://example.com/catalog/working']);
  });

  it('rejects an out-of-stock product and accepts a product with a usable cart action', () => {
    const unavailable = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/mizzen-out-of-stock-pdp.json'), 'utf8'));
    expect(assessPdpCandidate(unavailable.signals)).toEqual({ is_product: true, out_of_stock: true });
    expect(assessPdpCandidate({ ...unavailable.signals, enabled_add_to_cart: true })).toEqual({ is_product: true, out_of_stock: false });
    expect(pdpCandidateRejectionReason({ is_product: true, out_of_stock: true }, false)).toBe('PDP_OUT_OF_STOCK');
    expect(pdpCandidateRejectionReason({ is_product: true, out_of_stock: true }, true)).toBeNull();
    expect(pdpCandidateRejectionReason({ is_product: false, out_of_stock: false }, true)).toBeNull();
    expect(isStrongProductPath('https://example.com/product/model-a')).toBe(true);
    expect(isStrongProductPath('https://example.com/shop/replacement-parts')).toBe(false);
  });

  it('accepts hydrated product content and scopes a view_item to the candidate PDP', () => {
    const weakSignals = {
      json_ld_product: false, og_product: false, product_form: false, enabled_add_to_cart: false,
      visible_product_heading: true, visible_price: true, structured_in_stock: false,
      structured_out_of_stock: false, unavailable_message: false, disabled_sold_out_control: false
    };
    expect(assessPdpCandidate(weakSignals)).toEqual({ is_product: true, out_of_stock: false });
    const hit = {
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'www.google-analytics.com',
      path: '/g/collect', method: 'POST', phase: 'product_pdp_load', timestamp: 1,
      event: 'view_item', measurement_id: 'G-TEST', has_product: true,
      page_url: 'https://example.com/product/model-a'
    } satisfies TrackingRequestEvidence;
    expect(isViewItemForPdp(hit, 'https://www.example.com/product/model-a')).toBe(true);
    expect(isViewItemForPdp(hit, 'https://example.com/product/model-b')).toBe(false);
    expect(isViewItemForPdp({ ...hit, page_url: 'https://example.com/products/model-a' }, 'https://example.com/product/model-a', 'https://example.com/products/model-a')).toBe(true);
    expect(pdpReadinessSatisfied(null, false)).toBe(false);
    expect(pdpReadinessSatisfied({ is_product: true }, false)).toBe(true);
    expect(canKeepTimedOutPdp({ navigationTimedOut: true, finalPdpUrlValid: false, assessment: null, hasValidViewItem: true })).toBe(true);
    expect(canKeepTimedOutPdp({ navigationTimedOut: true, finalPdpUrlValid: false, assessment: null, hasValidViewItem: false })).toBe(false);
  });
});

describe('review priority scoring', () => {
  it('scores actionable findings and exposes a transparent point breakdown', () => {
    const evidence = baseEvidence('priority.example');
    evidence.page.valid = true;
    const audit: Partial<StorefrontAudit> = {
      scan_status: 'completed', error_category: 'none', cms_platform_detected: 'Unknown', cmp_provider: 'TrustArc',
      consent_status: 'pass', product_payload_status: 'inconclusive', server_side_status: 'not_detected'
    };
    expect(qaPrioritySignals(audit, evidence, [])).toEqual([
      expect.objectContaining({ code: 'MODULE_RESULT_INCOMPLETE', points: 20 }),
      expect.objectContaining({ code: 'CMS_UNKNOWN', points: 5 })
    ]);
    expect(calculateQaPriority(audit, evidence, [])).toBe(25);
  });

  it('does not treat a recovered rate limit or the known Google CCM endpoint as a QA failure', () => {
    const collector = new EvidenceCollector({ auditId: 'recovered', domain: 'example.com', geo: 'USA' });
    collector.setPage({ valid: false, accessCategory: 'rate_limited', statusCode: 429 });
    collector.setPage({ valid: true, accessCategory: 'none', statusCode: 200, retryAfterMs: null, botProvider: null, botSignals: [] });
    collector.captureRequest({
      url: 'https://www.google.com/ccm/collect?tid=G-TEST123&en=page_view', method: 'GET', phase: 'consent_initial_load', timestamp: 1
    });
    expect(collector.bundle.page.access_category).toBe('none');
    expect(collector.bundle.network.novel_endpoints).toEqual([]);
    const audit: Partial<StorefrontAudit> = {
      scan_status: 'completed', error_category: 'none', cms_platform_detected: 'Shopify', cmp_provider: 'Shopify Privacy',
      consent_status: 'pass', product_payload_status: 'pass', server_side_status: 'not_detected',
      site_ga4_detected: true, site_ga4_collection_hit_detected: true
    };
    expect(calculateQaPriority(audit, collector.bundle, [])).toBe(0);
  });

  it('keeps infrastructure failures operational instead of scanner-rule QA defects', () => {
    const evidence = baseEvidence('proxy-only.example');
    evidence.page.valid = false;
    evidence.page.access_category = 'proxy_error';
    const result = replayEvidence(evidence);
    expect(qaPrioritySignals(result, evidence, result.consistency_violations || []).map((signal) => signal.code))
      .not.toContain('SCAN_EXECUTION_FAILED');
  });
});

describe('CMP confidence rules', () => {
  it('does not treat eupubconsent-v2 as OneTrust', () => {
    const result = detectCMP({
      dom_selectors: [], script_urls: [], network_hosts: [], cookie_names: ['eupubconsent-v2'],
      window_globals: [], iframe_urls: [], banner_visible: false
    });
    expect(result.provider).toBe('IAB TCF');
  });

  it('does not identify Shopify Privacy from the trackingConsent global alone', () => {
    const result = detectCMP({
      dom_selectors: [], script_urls: [], network_hosts: [], cookie_names: [],
      window_globals: ['Shopify.trackingConsent'], iframe_urls: [], banner_visible: false
    });
    expect(result.provider).toBe('Not Found');
  });

  it('identifies combined OneTrust evidence', () => {
    const result = detectCMP({
      dom_selectors: ['#onetrust-banner-sdk'], script_urls: ['https://cdn.cookielaw.org/otSDKStub.js'],
      network_hosts: [], cookie_names: ['OptanonConsent'], window_globals: ['OneTrust'], iframe_urls: [], banner_visible: true
    });
    expect(result.provider).toBe('OneTrust');
    expect(result.confidence).toBe('high');
  });

  it('prefers concrete Fides evidence over a compatibility Optanon global', () => {
    const result = detectCMP({
      dom_selectors: ['#fides-banner-container'], script_urls: ['https://cmp.example.com/fides.js'], network_hosts: [],
      cookie_names: ['fides_consent'], window_globals: ['Fides', 'OptanonWrapper'], iframe_urls: [], banner_visible: true
    });
    expect(result).toMatchObject({ provider: 'Fides', confidence: 'high', reason_code: 'CMP_FIDES_DETECTED' });
  });

  it('uses the real Shopify Privacy accept and decline controls', () => {
    const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/lakanto-shopify-consent.json'), 'utf8'));
    expect(consentChoiceSelectors('accept')).toContain(fixture.controls.accept);
    expect(consentChoiceSelectors('reject')).toContain(fixture.controls.reject);
  });

  it('uses documented TrustArc accept and required-only controls', () => {
    expect(consentChoiceSelectors('accept')).toContain('#truste-consent-button');
    expect(consentChoiceSelectors('reject')).toContain('#truste-consent-required');
    expect(consentChoiceSelectors('accept')).toContain('.trustarc-acceptall-btn');
    expect(consentChoiceSelectors('reject')).toContain('.trustarc-declineall-btn');
    expect(trustArcPreferenceControls('accept')).toEqual({ optionPrefix: 'YES', submitLabel: 'Submit All Preferences' });
    expect(trustArcPreferenceControls('reject')).toEqual({ optionPrefix: 'NO', submitLabel: 'Submit All Preferences' });
  });

  it('verifies a Shopify rejection from Customer Privacy API state', () => {
    const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/lakanto-shopify-consent.json'), 'utf8'));
    expect(verifyConsentRejection('Shopify Privacy', fixture.before, fixture.after)).toMatchObject({
      verified: true,
      evidence: expect.arrayContaining(['provider_state_denied'])
    });
  });

  it('verifies consent enablement only from affirmative provider state', () => {
    const before = { cookie_values: { consent: 'rejected' }, banner_visible: false, provider_state: { onetrust_denied: true } };
    const after = { cookie_values: { consent: 'accepted' }, banner_visible: false, provider_state: { onetrust_denied: false } };
    expect(verifyConsentAcceptance('OneTrust', before, after)).toMatchObject({
      verified: true, evidence: expect.arrayContaining(['provider_state_allowed'])
    });
  });

  it('does not treat an unrelated cookie mutation as consent acceptance without an action', () => {
    const before = { cookie_values: {}, banner_visible: false, provider_state: { trustarc_advertising_denied: null } };
    const after = { cookie_values: { notice_behavior: 'implied|na' }, banner_visible: false, provider_state: { trustarc_advertising_denied: null } };
    expect(verifyConsentAcceptance('TrustArc', before, after, false)).toMatchObject({ verified: false });
  });
});

describe('lifecycle, proxy, and evidence guardrails', () => {
  it('uses one adaptive access policy for retries, residential fallback, challenges, and bulk finalization', () => {
    const common = { decodoAttempts: 0, maxDecodoRetries: 1, fallbackEnabled: true, challengeSolvingEnabled: false };
    expect(decideAccessTransition({ ...common, event: 'proxy_failure' })).toBe('retry_decodo');
    expect(decideAccessTransition({ ...common, event: 'proxy_failure', decodoAttempts: 1 })).toBe('fallback_browserless_residential');
    expect(decideAccessTransition({ ...common, event: 'proxy_failure', decodoAttempts: 1, isBulk: true })).toBe('finalize');
    expect(decideAccessTransition({ ...common, event: 'rate_limited' })).toBe('retry_decodo');
    expect(decideAccessTransition({ ...common, event: 'challenge', challengeSolvingEnabled: true })).toBe('solve_challenge');
    expect(decideAccessTransition({ ...common, event: 'challenge' })).toBe('fallback_browserless_residential');
  });

  it('allows exactly one finalization action', async () => {
    const lifecycle = new FinalizeOnce();
    let finalizations = 0;
    expect(await lifecycle.run(async () => { finalizations += 1; })).toBe(true);
    expect(await lifecycle.run(async () => { finalizations += 1; })).toBe(false);
    expect(finalizations).toBe(1);
    expect(lifecycle.isFinalized).toBe(true);
  });

  it('always persists the terminal update after queued progress updates', async () => {
    const writes: string[] = [];
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve; });
    const updates = new OrderedAuditUpdates<{ scan_status: string }>(async (update) => {
      if (update.scan_status === 'scanning') await progressGate;
      writes.push(update.scan_status);
    });
    expect(updates.enqueue({ scan_status: 'scanning' })).toBe(true);
    const finalWrite = updates.finalize({ scan_status: 'failed' });
    expect(updates.enqueue({ scan_status: 'scanning' })).toBe(false);
    releaseProgress();
    await finalWrite;
    expect(writes).toEqual(['scanning', 'failed']);
  });

  it('separates confirmed DNS absence from an inconclusive resolver failure', async () => {
    const notFound = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    const temporary = Object.assign(new Error('temporary resolver failure'), { code: 'EAI_AGAIN' });
    expect(await resolveHostnameStatus('missing.example', {
      lookupFn: async () => { throw notFound; }
    })).toBe('not_resolved');
    expect(await resolveHostnameStatus('temporary.example', {
      lookupFn: async () => { throw temporary; },
      fetchFn: async () => { throw temporary; }
    })).toBe('inconclusive');
    expect(await resolveHostnameStatus('valid.example', {
      lookupFn: async () => [{ address: '192.0.2.1', family: 4 }] as any
    })).toBe('resolved');
  });

  it('confirms DNS resolution failure through independent HTTPS resolvers', async () => {
    const temporary = Object.assign(new Error('temporary resolver failure'), { code: 'EAI_AGAIN' });
    const fetchFn = async () => new Response(JSON.stringify({ Status: 3 }), {
      status: 200,
      headers: { 'content-type': 'application/dns-json' }
    });
    expect(await resolveHostnameStatus('broken.example', {
      lookupFn: async () => { throw temporary; },
      fetchFn: fetchFn as typeof fetch
    })).toBe('not_resolved');
  });

  it('keeps DNS SERVFAIL and resolver disagreement inconclusive', async () => {
    const temporary = Object.assign(new Error('temporary resolver failure'), { code: 'EAI_AGAIN' });
    const fetchFn = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const status = url.hostname === 'cloudflare-dns.com' ? 2 : 3;
      return new Response(JSON.stringify({ Status: status }), { status: 200 });
    };
    const result = await resolveHostnameEvidence('uncertain.example', {
      lookupFn: async () => { throw temporary; },
      fetchFn: fetchFn as typeof fetch
    });
    expect(result.status).toBe('inconclusive');
    expect(result.sources).toMatchObject({ local: 'inconclusive', cloudflare: 'inconclusive', google: 'not_resolved' });
  });

  it('orders rate limits, bot challenges, and ordinary access blocks safely', () => {
    expect(resolveAccessDecision({
      status: 429,
      headers: { server: 'cloudflare', 'cf-ray': 'safe-test', 'retry-after': '12' },
      title: 'Just a moment'
    })).toMatchObject({ category: 'rate_limited', reasonCode: 'RATE_LIMITED', challengeType: 'rate_limit', retryAfterMs: 12_000 });
    expect(resolveAccessDecision({
      status: 403,
      headers: { server: 'cloudflare', 'cf-ray': 'safe-test', 'cf-mitigated': 'challenge' },
      domSignals: ['.cf-turnstile']
    })).toMatchObject({ category: 'bot_protection', botProvider: 'Cloudflare' });
    expect(resolveAccessDecision({ status: 403, title: 'Forbidden', bodyText: 'Access denied' }))
      .toMatchObject({ category: 'access_blocked', reasonCode: 'HTTP_403' });
    expect(resolveAccessDecision({ status: 200, title: 'Verify you are human' }))
      .toMatchObject({ category: 'bot_protection' });
  });

  it('normalizes bounded access fixtures and never treats a challenge page as a storefront', () => {
    const fixture = <T>(name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', name), 'utf8')) as T;
    for (const name of ['access-cloudflare-200-challenge.json', 'access-403-waf.json', 'access-429.json']) {
      const testCase = fixture<{ signals: Parameters<typeof resolveAccessDecision>[0]; expected: Record<string, unknown> }>(name);
      expect(resolveAccessDecision(testCase.signals)).toMatchObject(testCase.expected);
    }
    const cloudflare = fixture<{ signals: Parameters<typeof resolveAccessDecision>[0] }>('access-cloudflare-200-challenge.json');
    expect(resolveAccessDecision(cloudflare.signals).category).not.toBe('none');
  });

  it('replays normalized proxy, fallback, and solver access evidence without absence findings', () => {
    const fixture = <T>(name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures', name), 'utf8')) as T;
    const targetFailure = fixture<{ attempt: EvidenceBundle['access']['proxy_attempts'][number] }>('access-target-tunnel-failure.json');
    const recovery = fixture<{ access: Partial<EvidenceBundle['access']> }>('access-browserless-fallback-recovery.json');
    const solverRecovery = fixture<{ access: Partial<EvidenceBundle['access']> }>('access-challenge-solver-recovery.json');
    const solverFailure = fixture<{ access: Partial<EvidenceBundle['access']> }>('access-challenge-solver-failure.json');
    const evidence = baseEvidence('access-fixture.example');
    evidence.access = { ...evidence.access, ...recovery.access, proxy_attempts: [targetFailure.attempt] };
    expect(evidence.access).toMatchObject({ final_provider: 'browserless_residential', proxy_fallback_recovered: true, proxy_attempts: [targetFailure.attempt] });
    expect({ ...evidence.access, ...solverRecovery.access }).toMatchObject({ challenge_solver_result: 'succeeded' });
    evidence.access = { ...evidence.access, ...solverFailure.access };
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({
      scan_status: 'failed', consent_status: 'inconclusive', product_payload_status: 'not_tested',
      site_ga4_detected: null, site_meta_detected: null
    });
  });

  it('accepts only an evidence-backed HTTPS cross-domain redirect chain', () => {
    const validChain = [
      { status: 301, host: 'listenlively.com', path: '/' },
      { status: 200, host: 'www.jabraenhance.com', path: '/' }
    ];
    expect(isEvidenceBackedExternalRedirect('listenlively.com', 'https://www.jabraenhance.com/', 200, validChain)).toBe(true);
    expect(isEvidenceBackedExternalRedirect('listenlively.com', 'https://www.jabraenhance.com/account/login', 200, validChain)).toBe(false);
    expect(isEvidenceBackedExternalRedirect('listenlively.com', 'http://www.jabraenhance.com/', 200, validChain)).toBe(false);
    expect(isEvidenceBackedExternalRedirect('listenlively.com', 'https://www.jabraenhance.com/', 200, [
      { status: 200, host: 'listenlively.com', path: '/' },
      { status: 200, host: 'www.jabraenhance.com', path: '/' }
    ])).toBe(false);
  });

  it('parses bounded Retry-After values', () => {
    expect(parseRetryAfterMs('3')).toBe(3_000);
    expect(parseRetryAfterMs('999999')).toBe(86_400_000);
    expect(parseRetryAfterMs('invalid')).toBeNull();
  });

  it('aligns browser locale/timezone and Browserless session configuration with geo', () => {
    expect(browserGeoProfile('gb')).toMatchObject({ locale: 'en-GB', timezoneId: 'Europe/London' });
    const cdp = new URL(buildBrowserlessCdpUrl({
      host: 'production-lon.browserless.io',
      token: 'secret-test-token',
      route: 'stealth',
      timeoutMs: 120_000,
      browserLocale: 'en-GB',
      builtInProxy: 'residential',
      proxyCountry: 'gb',
      proxySticky: true,
      proxyLocaleMatch: true
    }));
    expect(cdp.pathname).toBe('/stealth');
    expect(cdp.searchParams.get('timeout')).toBe('120000');
    expect(cdp.searchParams.get('proxy')).toBe('residential');
    expect(cdp.searchParams.get('proxyCountry')).toBe('gb');
    expect(cdp.searchParams.get('proxyLocaleMatch')).toBe('true');
    expect(JSON.parse(cdp.searchParams.get('launch') || '{}').args).toContain('--lang=en-GB');
  });

  it('builds a sanitized Decodo attempt and a fresh Browserless Residential fallback without an external proxy', () => {
    const previous = process.env.DECODO_PROXY_UK;
    const ports = process.env.DECODO_PROXY_UK_PORTS;
    try {
      process.env.DECODO_PROXY_UK = 'http://opaque-user:opaque-password@uk.decodo.com:10001';
      process.env.DECODO_PROXY_UK_PORTS = '10001,10002';
      const decodo = buildProxyAttemptPlan({ provider: 'decodo', geo: 'UK', attempt: 1, browserlessHost: 'host.example', browserlessToken: 'secret', sessionTimeoutMs: 120000 });
      expect(decodo).toMatchObject({ provider: 'decodo', country: 'gb', port: 10002 });
      expect(new URL(decodo.cdpUrl).searchParams.get('externalProxyServer')).toContain('opaque-user');
      const fallback = buildProxyAttemptPlan({ provider: 'browserless_residential', geo: 'UK', attempt: 2, browserlessHost: 'host.example', browserlessToken: 'secret', sessionTimeoutMs: 120000 });
      const url = new URL(fallback.cdpUrl);
      expect(fallback).toMatchObject({ provider: 'browserless_residential', country: 'gb', port: null });
      expect(url.pathname).toBe('/stealth');
      expect(url.searchParams.get('proxy')).toBe('residential');
      expect(url.searchParams.get('proxyCountry')).toBe('gb');
      expect(url.searchParams.get('proxySticky')).toBe('true');
      expect(url.searchParams.get('proxyLocaleMatch')).toBe('true');
      expect(url.searchParams.has('externalProxyServer')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DECODO_PROXY_UK; else process.env.DECODO_PROXY_UK = previous;
      if (ports === undefined) delete process.env.DECODO_PROXY_UK_PORTS; else process.env.DECODO_PROXY_UK_PORTS = ports;
    }
  });

  it('classifies confirmed tunnel failures without turning them into access findings and suppresses bulk fallback', () => {
    expect(classifyConfirmedTunnelFailure('connect')).toBe('PROXY_PROVIDER_UNREACHABLE');
    expect(classifyConfirmedTunnelFailure('target', false)).toBe('PROXY_EXTERNAL_TUNNEL_FAILED');
    expect(classifyConfirmedTunnelFailure('target', true)).toBe('PROXY_TARGET_TUNNEL_FAILED');
    expect(shouldUseBrowserlessResidentialFallback({ isBulk: true, enabled: true })).toBe(false);
    expect(shouldUseBrowserlessResidentialFallback({ isBulk: false, enabled: true })).toBe(true);
    const proxyEvidence = baseEvidence();
    proxyEvidence.page.valid = false;
    proxyEvidence.page.access_category = 'proxy_error';
    const failed = replayEvidence(proxyEvidence);
    expect(failed.error_category).not.toMatch(/access_blocked|bot_protection|rate_limited/);
  });

  it('parses flat and nested proxy egress countries without retaining the IP', () => {
    expect(parseEgressCountry({ country_code: 'US', ip: '192.0.2.1' })).toBe('us');
    expect(parseEgressCountry({ country: { code: 'GB', name: 'United Kingdom' }, ip: '192.0.2.2' })).toBe('gb');
    expect(parseEgressCountry({ country: { name: 'United States' } })).toBeNull();
  });

  it('uses the tracking-safe BrowserQL handoff and authenticates the returned CDP endpoint', async () => {
    let requestBody = '';
    let requestUrl = '';
    const result = await createBrowserQlHandoff({
      host: 'production-sfo.browserless.io',
      token: 'test-token',
      route: 'standard',
      url: 'https://example.com',
      sessionTimeoutMs: 120_000,
      solveChallenge: true,
      fetchFn: (async (input, init) => {
        requestUrl = String(input);
        requestBody = String(init?.body || '');
        return new Response(JSON.stringify({
          data: {
            goto: { status: 200 },
            solve: { found: true, solved: true, time: 500 },
            reconnect: { browserWSEndpoint: 'wss://production-sfo.browserless.io/chromium/session-id' }
          }
        }), { status: 200 });
      }) as typeof fetch
    });
    expect(new URL(requestUrl).pathname).toBe('/chromium/bql');
    expect(requestBody).toContain('solve');
    expect(requestBody).toContain('reconnect');
    expect(new URL(result.browserWSEndpoint).searchParams.get('token')).toBe('test-token');
    expect(result).toMatchObject({ captchaFound: true, captchaSolved: true, navigationStatus: 200 });
  });

  it('rotates Decodo country and session without losing other username parameters', () => {
    const rotated = rotateDecodoSessionUsername(
      'user-customer-country-us-session-old-streaming-1-sessionduration-30',
      'de',
      'newsession'
    );
    expect(rotated).toBe('user-customer-country-de-session-newsession-streaming-1-sessionduration-30');
    expect(rotateDecodoSessionUsername('user-customer', 'us', 'newsession')).toMatch(/-sessionduration-60$/);
    const normalizedInvalidDuration = rotateDecodoSessionUsername('user-customer-sessionduration-60m', 'us', 'newsession');
    expect(normalizedInvalidDuration).toContain('-sessionduration-60');
    expect(normalizedInvalidDuration).not.toContain('-sessionduration-60m');
  });

  it('rotates country-endpoint ports without rewriting valid opaque credentials', () => {
    const beforeProxy = process.env.DECODO_PROXY_EU;
    const beforePorts = process.env.DECODO_PROXY_EU_PORTS;
    try {
      process.env.DECODO_PROXY_EU = 'http://opaque-proxy-user:password@eu.decodo.com:10001';
      process.env.DECODO_PROXY_EU_PORTS = '10001,10002,invalid,70000';
      const first = new URL(getExternalProxyForGeo('EU', 0));
      const second = new URL(getExternalProxyForGeo('EU', 1));
      const offsetInitial = new URL(getExternalProxyForGeo('EU', 0, 1));
      expect(first.port).toBe('10001');
      expect(second.port).toBe('10002');
      expect(offsetInitial.port).toBe('10002');
      expect(decodeURIComponent(first.username)).toBe('opaque-proxy-user');
      expect(decodeURIComponent(second.username)).toBe('opaque-proxy-user');
    } finally {
      if (beforeProxy === undefined) delete process.env.DECODO_PROXY_EU;
      else process.env.DECODO_PROXY_EU = beforeProxy;
      if (beforePorts === undefined) delete process.env.DECODO_PROXY_EU_PORTS;
      else process.env.DECODO_PROXY_EU_PORTS = beforePorts;
    }
  });

  it('uses real EU countries and valid integer duration on backconnect gateways', () => {
    const beforeProxy = process.env.DECODO_PROXY_EU;
    const beforePorts = process.env.DECODO_PROXY_EU_PORTS;
    try {
      process.env.DECODO_PROXY_EU = 'http://proxy-user:password@gate.decodo.com:7000';
      process.env.DECODO_PROXY_EU_PORTS = '7000';
      const proxy = new URL(getExternalProxyForGeo('EU', 0));
      expect(decodeURIComponent(proxy.username)).toMatch(/^user-proxy-user-country-de-session-[a-z0-9]+-sessionduration-60$/i);
    } finally {
      if (beforeProxy === undefined) delete process.env.DECODO_PROXY_EU;
      else process.env.DECODO_PROXY_EU = beforeProxy;
      if (beforePorts === undefined) delete process.env.DECODO_PROXY_EU_PORTS;
      else process.env.DECODO_PROXY_EU_PORTS = beforePorts;
    }
  });

  it('keeps the rotating gateway fallback disabled by default', () => {
    const before = process.env.DECODO_ENABLE_ROTATING_GATEWAY_FALLBACK;
    try {
      delete process.env.DECODO_ENABLE_ROTATING_GATEWAY_FALLBACK;
      expect(buildRotatingFallbackProxy('http://user:pass@gate.example:10001', 'USA')).toBe('');
    } finally {
      if (before !== undefined) process.env.DECODO_ENABLE_ROTATING_GATEWAY_FALLBACK = before;
    }
  });

  it('redacts credentials but preserves non-secret proxy and Browserless metrics', () => {
    expect(sanitizeValue({
      proxy_retry_count: 1,
      proxy_port: 10001,
      browserless_connect_ms: 250,
      proxy_url: 'http://user:pass@gate.example:10001',
      has_token: true,
      scan_started_at: new Date('2026-08-27T18:30:02.657Z'),
      cookie_names: ['OptanonConsent'],
      cookie_values: { OptanonConsent: 'sensitive' }
    })).toEqual({
      proxy_retry_count: 1,
      proxy_port: 10001,
      browserless_connect_ms: 250,
      proxy_url: '[REDACTED_SENSITIVE_VALUE]',
      has_token: true,
      scan_started_at: '2026-08-27T18:30:02.657Z',
      cookie_names: ['OptanonConsent'],
      cookie_values: '[REDACTED_COOKIE]'
    });
  });

  it('redacts credential-bearing Browserless errors defensively', () => {
    const sanitized = sanitizeValue({
      reason: 'WebSocket wss://chrome.browserless.io/stealth?token=secret-token&externalProxyServer=http%3A%2F%2Fproxy-user%3Aproxy-pass%40us.decodo.com%3A10001 disconnected'
    }) as { reason: string };
    expect(sanitized.reason).not.toContain('secret-token');
    expect(sanitized.reason).not.toContain('proxy-user');
    expect(sanitized.reason).not.toContain('proxy-pass');
    expect(sanitized.reason).toContain('token=[REDACTED]');
    expect(sanitized.reason).toContain('externalProxyServer=[REDACTED]');
  });

  it('distinguishes a Browserless plan restriction from proxy transport failures', () => {
    expect(classifyBrowserConnectionError(new Error(
      '401 Unauthorized: Only paid cloud-unit plans can utilize a third-party proxy. disconnected'
    ))).toBe('BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED');
    expect(classifyBrowserConnectionError(new Error('401 Unauthorized'))).toBe('BROWSERLESS_AUTH_REJECTED');
    expect(classifyBrowserConnectionError(new Error('ERR_TUNNEL_CONNECTION_FAILED'))).toBe('PROXY_TUNNEL_FAILED');
    expect(classifyNavigationError(new Error('page.goto: net::ERR_ABORTED'))).toBe('NAVIGATION_ABORTED');
    expect(classifyNavigationError(new Error('Target page, context or browser has been closed'))).toBe('NAVIGATION_TARGET_CLOSED');
  });

  it('keeps the Audit Reviewer deterministic and flags missing finalization', () => {
    const evidence = baseEvidence();
    const review = reviewAudit({
      audit: { audit_id: 'review', domain: 'example.com' },
      evidence,
      trace: '{"step":"consent_navigation_completed"}\n'
    });
    expect(review.violations).toContainEqual(expect.objectContaining({ code: 'SCAN_FINALIZATION_MISSING' }));
    expect(review.patch_plan.join(' ')).not.toMatch(/write|modify source/i);
    expect(review).not.toHaveProperty('sanitized_trace');
  });

  it('flags stale recovery only when it occurs after finalization', () => {
    const evidence = baseEvidence('stale-after-finalization.example');
    const review = reviewAudit({
      audit: { audit_id: 'review-stale', domain: 'example.com', scan_status: 'failed', trace_steps: '[]' },
      evidence,
      trace: [
        { step: 'scan_finalized' },
        { step: 'stale_scan_recovered' }
      ]
    });
    expect(review.violations).toContainEqual(expect.objectContaining({ code: 'STALE_RECOVERY_AFTER_FINALIZATION' }));
    expect(review.patch_plan.join(' ')).not.toMatch(/gemini|outreach|modify source/i);
  });

  it('builds chart-ready quality metrics and actionable failure clusters', () => {
    const evidence = baseEvidence();
    evidence.page.valid = true;
    evidence.runtime.total_duration_ms = 12_000;
    const audit: StorefrontAudit = {
      audit_id: 'quality', domain: 'example.com', group_label: null,
      scan_started_at: '2026-08-27T00:00:00.000Z', scan_completed_at: '2026-08-27T00:00:12.000Z',
      scan_status: 'completed', scan_mode: 'normal', error_category: 'none', tested_geos: 'USA',
      cms_platform_detected: 'Shopify', overall_status: 'warning', overall_confidence: 'medium',
      consent_status: 'not_detected', cmp_provider: 'Not Found', product_payload_status: 'missing_view_item',
      pdp_url_tested: 'https://example.com/products/test', server_side_status: 'not_detected',
      ss_collection_type: 'third_party', trace_steps: '[]', site_ga4_detected: true,
      evidence_bundle: evidence, failure_fingerprints: ['GA4_NO_VIEW_ITEM'], qa_priority: 35
    };
    const metrics = buildQualityMetrics([audit], [{
      audit_id: 'quality', verdict: 'correct', category: 'GA4', expected_value: 'detected', notes: null,
      created_at: '2026-08-27T01:00:00.000Z'
    }]);
    expect(metrics.trend).toContainEqual(expect.objectContaining({ date: '2026-08-27', audits: 1 }));
    expect(metrics.distributions.cms).toEqual({ Shopify: 1 });
    expect(metrics.failure_clusters[0]).toMatchObject({ code: 'GA4_NO_VIEW_ITEM', count: 1, domains: ['example.com'] });
    expect(metrics.failure_clusters[0].recommendation).toContain('PDP');
    expect(metrics.verified.category_summaries[0]).toMatchObject({ category: 'GA4', true_positive: 1 });
    expect(metrics.operational).toMatchObject({ total_audits: 1, unique_websites: 1 });
  });

  it('reports access reliability rates from bounded access evidence', () => {
    const makeAudit = (id: string, geo: 'USA' | 'EU' | 'UK', overrides: Partial<EvidenceBundle['access']>, error: StorefrontAudit['error_category'] = 'none') => {
      const evidence = baseEvidence(`${id}.example`);
      evidence.geo = geo;
      evidence.page.valid = overrides.valid_storefront ?? false;
      evidence.page.status_code = overrides.http_status ?? null;
      evidence.page.access_category = error;
      evidence.access = { ...evidence.access, ...overrides, proxy_attempts: overrides.proxy_attempts || [] };
      return {
        audit_id: id, domain: `${id}.example`, group_label: null, scan_started_at: '2026-08-27T00:00:00.000Z', scan_completed_at: null,
        scan_status: evidence.access.valid_storefront ? 'completed' : 'failed', error_category: error, tested_geos: geo,
        cms_platform_detected: 'Unknown', overall_status: evidence.access.valid_storefront ? 'pass' : 'inconclusive', overall_confidence: evidence.access.valid_storefront ? 'high' : 'low',
        consent_status: 'not_tested', cmp_provider: null, product_payload_status: 'not_tested', pdp_url_tested: null, server_side_status: 'not_tested', ss_collection_type: 'not_tested', trace_steps: '[]', evidence_bundle: evidence
      } satisfies StorefrontAudit;
    };
    const audits = [
      makeAudit('first', 'USA', { valid_storefront: true, http_status: 200, time_to_valid_storefront_ms: 100, proxy_attempts: [{ provider: 'decodo', geo: 'USA', port: 10001, attempt: 1, connect_duration_ms: 50, egress_result: 'reachable', neutral_https_result: 'reachable', target_result: 'valid_storefront', failure_classification: null }] }),
      makeAudit('retry', 'EU', { valid_storefront: false, http_status: null, proxy_attempts: [
        { provider: 'decodo', geo: 'EU', port: 10002, attempt: 1, connect_duration_ms: null, egress_result: 'reachable', neutral_https_result: 'reachable', target_result: 'failed', failure_classification: 'PROXY_TARGET_TUNNEL_FAILED' },
        { provider: 'decodo', geo: 'EU', port: 10002, attempt: 2, connect_duration_ms: null, egress_result: 'reachable', neutral_https_result: 'reachable', target_result: 'failed', failure_classification: 'PROXY_TARGET_TUNNEL_FAILED' }
      ] }, 'proxy_error'),
      makeAudit('fallback', 'UK', { valid_storefront: true, http_status: 200, time_to_valid_storefront_ms: 200, final_provider: 'browserless_residential', proxy_fallback_used: true, proxy_fallback_recovered: true, challenge_detected: true, challenge_type: 'cloudflare', challenge_solver_used: true, challenge_solver_result: 'succeeded', proxy_attempts: [
        { provider: 'decodo', geo: 'UK', port: 10003, attempt: 1, connect_duration_ms: 80, egress_result: 'reachable', neutral_https_result: 'reachable', target_result: 'failed', failure_classification: 'PROXY_EXTERNAL_TUNNEL_FAILED' },
        { provider: 'browserless_residential', geo: 'UK', port: null, attempt: 2, connect_duration_ms: 90, egress_result: 'not_tested', neutral_https_result: 'not_tested', target_result: 'valid_storefront', failure_classification: null }
      ] }),
      makeAudit('waf', 'USA', { valid_storefront: false, http_status: 403, challenge_detected: true, challenge_type: 'unknown_challenge', challenge_solver_used: true, challenge_solver_result: 'failed' }, 'bot_protection'),
      makeAudit('limit', 'EU', { valid_storefront: false, http_status: 429 }, 'rate_limited')
    ];
    const metrics = buildQualityMetrics(audits, []).operational;
    expect(metrics).toMatchObject({
      valid_storefront_rate: 0.4,
      first_attempt_decodo_success_rate: 1 / 3,
      decodo_retry_recovery_rate: 0,
      browserless_residential_fallback_recovery_rate: 1,
      challenge_detection_rate: 0.4,
      challenge_solver_recovery_rate: 0.5,
      proxy_failure_rate: 0.2,
      http_403_rate: 0.2,
      http_429_rate: 0.2,
      bot_waf_failure_rate: 0.2,
      median_access_time_ms: 100,
      p95_access_time_ms: 200,
      access_success_by_provider: {
        decodo: { attempts: 4, successes: 1, success_rate: 0.25 },
        browserless_residential: { attempts: 1, successes: 1, success_rate: 1 }
      },
      decodo_error_rate_by_port: {
        10002: { attempts: 2, errors: 2, error_rate: 1 }
      }
    });
    expect(metrics.access_success_by_geo).toMatchObject({ USA: { attempts: 2, successes: 1 }, EU: { attempts: 2, successes: 0 }, UK: { attempts: 1, successes: 1 } });
  });

  it('scores human ground truth across positive and negative accuracy outcomes', () => {
    const evidence = baseEvidence('ground-truth.example');
    evidence.page.valid = true;
    const absent: StorefrontAudit = {
      audit_id: 'absent', domain: 'absent.example', group_label: null, scan_started_at: '2026-08-27T00:00:00.000Z', scan_completed_at: null,
      scan_status: 'completed', error_category: 'none', tested_geos: 'USA', cms_platform_detected: 'Unknown', overall_status: 'warning', overall_confidence: 'medium',
      consent_status: 'pass', cmp_provider: 'Not Found', product_payload_status: 'ga4_not_detected', pdp_url_tested: null, server_side_status: 'not_detected', ss_collection_type: 'not_detected', trace_steps: '[]',
      site_ga4_detected: false, evidence_bundle: evidence
    };
    const present = { ...absent, audit_id: 'present', domain: 'present.example', site_ga4_detected: true };
    const metrics = buildQualityMetrics([absent, present], [
      { audit_id: 'absent', verdict: 'correct', category: 'GA4', expected_value: 'not_detected', notes: null, created_at: '2026-08-27T01:00:00.000Z' },
      { audit_id: 'present', verdict: 'incorrect', category: 'GA4', expected_value: 'not_detected', notes: null, created_at: '2026-08-27T01:00:00.000Z' }
    ]);
    expect(metrics.verified.category_summaries).toContainEqual(expect.objectContaining({ category: 'GA4', true_negative: 1, false_positive: 1 }));
  });

  it('builds one review row per website with feedback only from its latest audit', () => {
    const audit = (auditId: string, domain: string, startedAt: string, ga4: boolean): StorefrontAudit => ({
      audit_id: auditId, domain, group_label: null, scan_started_at: startedAt, scan_completed_at: startedAt,
      scan_status: 'completed', scan_mode: 'normal', error_category: 'none', tested_geos: 'USA',
      cms_platform_detected: 'Shopify', overall_status: 'warning', overall_confidence: 'medium',
      consent_status: 'pass', cmp_provider: 'Shopify Privacy', product_payload_status: 'pass',
      pdp_url_tested: `https://${domain}/products/test`, server_side_status: 'not_detected',
      ss_collection_type: 'third_party', trace_steps: '[]', site_ga4_detected: ga4,
      site_meta_detected: true, failure_fingerprints: ['GA4_NO_VIEW_ITEM'], qa_priority: 35
    });
    const older = audit('old', 'www.example.com', '2026-08-26T00:00:00.000Z', false);
    const latest = audit('latest', 'example.com', '2026-08-27T00:00:00.000Z', true);
    const queue = buildLatestReviewQueue([older, latest], [
      {
        audit_id: 'old', verdict: 'incorrect', category: 'GA4', expected_value: 'detected', notes: 'Old audit feedback.',
        created_at: '2026-08-27T01:00:00.000Z'
      },
      {
        audit_id: 'latest', verdict: 'correct', category: 'GA4', expected_value: 'detected', notes: 'Latest audit feedback.',
        created_at: '2026-08-27T02:00:00.000Z'
      }
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ audit_id: 'latest', site_ga4_detected: true });
    expect(queue[0].qa_feedback).toEqual([
      expect.objectContaining({ audit_id: 'latest', category: 'GA4', notes: 'Latest audit feedback.' })
    ]);

    latest.qa_review_status = 'correct';
    latest.qa_reviewed_at = '2026-08-27T03:00:00.000Z';
    expect(buildLatestReviewQueue([older, latest], [])).toEqual([]);
  });

  it('uses only each website latest audit for quality findings and resolves marked-correct priorities', () => {
    const makeAudit = (auditId: string, startedAt: string, status: StorefrontAudit['overall_status']): StorefrontAudit => ({
      audit_id: auditId, domain: auditId === 'older' ? 'www.example.com' : 'example.com', group_label: null,
      scan_started_at: startedAt, scan_completed_at: startedAt, scan_status: 'completed', scan_mode: 'normal',
      error_category: 'none', tested_geos: 'USA', cms_platform_detected: 'Shopify', overall_status: status,
      overall_confidence: 'medium', consent_status: 'pass', cmp_provider: 'Shopify Privacy',
      product_payload_status: status === 'pass' ? 'pass' : 'missing_view_item',
      pdp_url_tested: 'https://example.com/products/test', server_side_status: 'not_detected',
      ss_collection_type: 'third_party', trace_steps: '[]', site_ga4_detected: true,
      failure_fingerprints: ['GA4_NO_VIEW_ITEM'], qa_priority: 35
    });
    const older = makeAudit('older', '2026-08-26T00:00:00.000Z', 'warning');
    const latest = makeAudit('latest', '2026-08-27T00:00:00.000Z', 'pass');
    latest.qa_review_status = 'correct';
    latest.qa_reviewed_at = '2026-08-27T01:00:00.000Z';

    const metrics = buildQualityMetrics([older, latest], []);
    expect(metrics.operational).toMatchObject({
      total_audits: 2,
      unique_websites: 1,
      reviewed_correct_websites: 1,
      review_candidates: 0,
      findings_basis: 'latest_unique_website_audits'
    });
    expect(metrics.distributions.overall_status).toEqual({ pass: 1 });
    expect(metrics.failure_clusters).toEqual([]);
  });

  it('replays bounded Meta inline/global installation evidence when no network request fired', () => {
    const evidence = baseEvidence('meta-inline.example');
    evidence.page.valid = true;
    evidence.page.access_category = 'none';
    evidence.network.installation_signals = [{
      vendor: 'meta', source: 'inline_script', identifiers: ['540863870609660'], phase: 'consent_initial_load'
    }];
    const result = replayEvidence(evidence);
    expect(result.site_meta_detected).toBe(true);
    expect(result.site_meta_collection_hit_detected).toBe(false);
    expect(result.finding_confidence?.meta).toMatchObject({ detected: true, confidence: 'medium', reason_code: 'META_SCRIPT_ONLY' });
  });

  it('does not turn unverified consent enablement into confident tracker absence', () => {
    const evidence = baseEvidence('consent-gated.example');
    evidence.page.valid = true;
    evidence.consent.executed = true;
    evidence.consent.acceptance_attempted = true;
    evidence.consent.acceptance_verified = false;
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://consent-gated.example/products/item'];
    evidence.product.navigation_succeeded = true;
    const result = replayEvidence(evidence);
    expect(result.site_ga4_detected).toBeNull();
    expect(result.site_meta_detected).toBeNull();
    expect(result.product_payload_status).toBe('inconclusive');
    expect(result.finding_confidence?.meta.reason_code).toBe('META_NOT_TESTED');
  });

  it('keeps redirect and TrustArc evidence while a product runtime failure is inconclusive', () => {
    const evidence = baseEvidence('runtime-failure.example');
    evidence.page.valid = true;
    evidence.page.cross_domain_redirect_accepted = true;
    evidence.consent.executed = true;
    evidence.consent.window_globals = ['truste'];
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://runtime-failure.example/products/item'];
    evidence.product.navigation_succeeded = true;
    evidence.network.relevant_requests = [{
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect',
      method: 'POST', phase: 'product_pdp_load', timestamp: 1, event: 'page_view', measurement_id: 'G-TEST', has_product: false
    }];
    evidence.runtime.last_successful_phase = 'product_discovery';
    evidence.runtime.failed_phase = 'product_consent_state_capture';
    evidence.runtime.product_consent_snapshot = {
      attempted: true, succeeded: false, failure_code: 'PRODUCT_CONSENT_STATE_CAPTURE_FAILED', elapsed_ms: 250
    };
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({ cmp_provider: 'TrustArc', product_payload_status: 'inconclusive' });
    expect(result.finding_confidence?.product.reason_code).toBe('PRODUCT_RUNTIME_FAILED');
    expect(evidence.page.cross_domain_redirect_accepted).toBe(true);
  });

  it('treats matching PDP GA4 collection as a valid product test even when consent enablement was not verified', () => {
    const evidence = baseEvidence('pdp-collection.example');
    evidence.page.valid = true;
    evidence.consent.executed = true;
    evidence.consent.acceptance_attempted = true;
    evidence.consent.acceptance_verified = false;
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://pdp-collection.example/product/model'];
    evidence.product.pdp_url = 'https://pdp-collection.example/product/model';
    evidence.product.navigation_succeeded = true;
    evidence.network.relevant_requests = [{
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect',
      method: 'POST', phase: 'product_pdp_load', timestamp: 1, event: 'page_view', measurement_id: 'G-TEST',
      page_url: 'https://pdp-collection.example/product/model', has_product: false
    }];
    const result = replayEvidence(evidence);
    expect(result.site_ga4_detected).toBe(true);
    expect(result.product_payload_status).toBe('missing_view_item');
    expect(result.finding_confidence?.product.reason_code).toBe('GA4_NO_VIEW_ITEM');
  });

  it('builds the complete sanitized debug package manifest', () => {
    const evidence = baseEvidence();
    evidence.runtime.screenshots.push({ name: 'home page.jpg', mime_type: 'image/jpeg', content_base64: 'aGVsbG8=' });
    const files = buildDebugPackageFiles({
      audit_id: 'debug', domain: 'example.com', group_label: null, scan_started_at: evidence.runtime.started_at,
      scan_completed_at: null, scan_status: 'completed', scan_mode: 'diagnostic', error_category: 'none',
      tested_geos: 'USA', cms_platform_detected: 'Unknown', overall_status: 'pass', overall_confidence: 'high',
      consent_status: 'not_detected', cmp_provider: 'Not Found', product_payload_status: 'pass', pdp_url_tested: null,
      server_side_status: 'not_detected', ss_collection_type: 'third_party', trace_steps: '[]', evidence_bundle: evidence
    });
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      'audit-result.json', 'trace.jsonl', 'evidence.json', 'network-summary.json', 'cmp-evidence.json',
      'product-evidence.json', 'normalized-evidence.json', 'quality-summary.json', 'access-summary.json', 'proxy-attempt-summary.json',
      'build-metadata.json', 'screenshots/home_page.jpg'
    ]));
    expect(JSON.parse(String(files['quality-summary.json']))).toMatchObject({
      selected_modules: ['consent', 'tracking', 'server_side'],
      candidate_pdp_url: null,
      final_pdp_url: null
    });
    expect(JSON.parse(String(files['access-summary.json']))).toMatchObject({ page: { valid: null, access_category: 'none' } });
  });
});

describe('server-side collection classifier', () => {
  const event = (overrides: Partial<TrackingRequestEvidence>): TrackingRequestEvidence => ({
    vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect',
    method: 'GET', phase: 'product_pdp_load', timestamp: 1000, event: 'view_item', measurement_id: 'G-TEST',
    page_url: 'https://example.com/products/one', ...overrides
  });

  it('does not infer collection from a first-party script', () => {
    const result = classifyCollection({
      executed: true, page_valid: true,
      requests: [event({ kind: 'script', collector: 'first_party', event: undefined, measurement_id: undefined })]
    });
    expect(result.status).toBe('not_detected');
  });

  it('requires strict event identity for duplicate detection', () => {
    const third = event({ collector: 'third_party', timestamp: 1000, client_id: 'one', session_id: 'session' });
    const firstMismatch = event({ collector: 'first_party', host: 'data.example.com', timestamp: 1100, client_id: 'two', session_id: 'session' });
    expect(findStrictDuplicates([third, firstMismatch])).toHaveLength(0);
    expect(findStrictDuplicates([third, { ...firstMismatch, client_id: 'one' }])).toHaveLength(1);
  });

  it('does not call mixed collection misconfigured without a strict duplicate', () => {
    const result = classifyCollection({
      executed: true, page_valid: true,
      requests: [event({ collector: 'third_party' }), event({ collector: 'first_party', host: 'data.example.com', timestamp: 4000, event: 'purchase' })]
    });
    expect(result.collection_type).toBe('mixed');
    expect(result.status).not.toBe('partial_or_misconfigured');
  });
});

describe('status resolver and consistency', () => {
  it('preserves a valid view_item product pass', () => {
    const hit: TrackingRequestEvidence = {
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect',
      method: 'GET', phase: 'product_pdp_load', timestamp: 1, event: 'view_item', measurement_id: 'G-TEST', has_product: true, product_id: 'sku'
    };
    expect(resolveProductPayloadStatus({
      executed: true, page_valid: true, pdp_found: true, pdp_navigation_succeeded: true,
      consent_status: 'pass', site_ga4_detected: true, site_ga4_collection_hit_detected: true, view_item_hits: [hit]
    }).status).toBe('pass');
  });

  it('resolves a valid dataLayer view_item as a product pass without inventing a collection hit', () => {
    const collector = new EvidenceCollector({ auditId: 'datalayer', domain: 'example.com', geo: 'USA', mode: 'normal' });
    const evidence = collector.bundle;
    evidence.page.valid = true;
    evidence.page.access_category = 'none';
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://example.com/product/model'];
    evidence.product.pdp_url = 'https://example.com/product/model';
    evidence.product.navigation_succeeded = true;
    const entry = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/listenlively-m2-datalayer.json'), 'utf8'));
    collector.captureDataLayerViewItem({ entry, pageUrl: evidence.product.pdp_url, phase: 'product_pdp_load', timestamp: 1 });
    const result = replayEvidence(evidence);
    expect(result.product_payload_status).toBe('pass');
    expect(result.site_ga4_detected).toBe(true);
    expect(result.site_ga4_collection_hit_detected).toBe(false);
    expect(result.finding_confidence?.product.evidence).toContain('data_layer');
  });

  it('keeps the sanitized ListenLively M1 network view_item through collection and shared replay', () => {
    const collector = new EvidenceCollector({ auditId: 'listenlively-m1', domain: 'www.jabraenhance.com', geo: 'USA', mode: 'normal' });
    const evidence = collector.bundle;
    evidence.page.valid = true;
    evidence.page.access_category = 'none';
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://www.jabraenhance.com/product/enhanceselectm1'];
    evidence.product.pdp_url = 'https://www.jabraenhance.com/product/enhanceselectm1';
    evidence.product.navigation_succeeded = true;
    collector.captureRequest({
      url: readFileSync(path.join(process.cwd(), 'tests/fixtures/listenlively-m1-view-item-url.txt'), 'utf8').trim(),
      phase: 'product_pdp_load', timestamp: 1
    });
    expect(replayEvidence(evidence)).toMatchObject({
      site_ga4_detected: true,
      site_ga4_collection_hit_detected: true,
      product_payload_status: 'pass'
    });
  });

  it('accepts a valid GA4 view_item regardless of the site installation ID summary', () => {
    const hit: TrackingRequestEvidence = {
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect',
      method: 'GET', phase: 'product_pdp_load', timestamp: 1, event: 'view_item', measurement_id: 'G-SECONDARY',
      has_product: true, product_id: 'product-1'
    };
    expect(resolveProductPayloadStatus({
      executed: true, page_valid: true, pdp_found: true, pdp_navigation_succeeded: true,
      consent_status: 'pass', site_ga4_detected: false, site_ga4_collection_hit_detected: false, view_item_hits: [hit]
    })).toMatchObject({ status: 'pass', reason_code: 'GA4_VIEW_ITEM_VALID' });
  });

  it('corrects impossible GA4 and invalid-page conclusions', () => {
    const evidence = baseEvidence();
    evidence.page.valid = false;
    const result = enforceConsistency({
      site_ga4_detected: true, product_payload_status: 'ga4_not_detected',
      consent_status: 'not_detected', server_side_status: 'not_detected', ss_collection_type: 'not_detected'
    }, evidence);
    expect(result.audit.product_payload_status).toBe('not_tested');
    expect(result.audit.consent_status).toBe('inconclusive');
    expect(result.violations).toContain('SITE_GA4_PRODUCT_STATUS_CONTRADICTION');
  });

  it('removes confident absence conclusions from an invalid page without touching skipped modules', () => {
    const evidence = baseEvidence('invalid-page.example');
    evidence.selected_modules = ['tracking'];
    evidence.page.valid = false;
    const result = enforceConsistency({
      site_ga4_detected: false,
      site_meta_detected: false,
      finding_confidence: {
        ga4: { detected: false, confidence: 'high', evidence: [], reason_code: 'GA4_NOT_DETECTED' },
        meta: { detected: false, confidence: 'high', evidence: [], reason_code: 'META_NOT_DETECTED' }
      }
    }, evidence);
    expect(result.audit).toMatchObject({ site_ga4_detected: null, site_meta_detected: null });
    expect(result.audit.finding_confidence?.ga4).toMatchObject({ detected: null, reason_code: 'GA4_NOT_TESTED' });
    expect(result.violations).toContain('INVALID_PAGE_ABSENCE_CONCLUSION');
    expect(result.violations).not.toContain('INVALID_PAGE_CONSENT_CONCLUSION');
  });

  it('resolves access failure directly without creating a false contradiction', () => {
    const evidence = baseEvidence('lumee.com');
    evidence.page.valid = false;
    evidence.page.access_category = 'proxy_error';
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({
      scan_status: 'failed',
      error_category: 'proxy_error',
      consent_status: 'inconclusive',
      product_payload_status: 'not_tested',
      server_side_status: 'not_tested',
      site_ga4_detected: null,
      finding_confidence: {
        cmp: { detected: null, reason_code: 'CMP_NOT_TESTED' },
        consent: { status: 'inconclusive', reason_code: 'ACCESS_BLOCKED' },
        ga4: { detected: null, reason_code: 'GA4_NOT_TESTED' }
      },
      consistency_violations: []
    });
    expect(result.failure_fingerprints).toEqual(['PROXY_TUNNEL_FAILED']);
  });

  it('preserves Browserless external-proxy plan restrictions as a stable fingerprint', () => {
    const evidence = baseEvidence('lumee.com');
    evidence.page.valid = false;
    evidence.page.access_category = 'browser_error';
    evidence.runtime.browser_connection_failure_code = 'BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED';
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({
      scan_status: 'failed',
      error_category: 'browser_error',
      consent_status: 'inconclusive',
      product_payload_status: 'not_tested',
      site_ga4_detected: null,
      consistency_violations: []
    });
    expect(result.failure_fingerprints).toContain('BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED');
    expect(result.failure_fingerprints).not.toContain('PROXY_TUNNEL_FAILED');
  });

  it('creates stable quality fingerprints from normalized runtime and resolver evidence', () => {
    const evidence = baseEvidence('fingerprints.example');
    evidence.selected_modules = ['tracking'];
    evidence.page.valid = true;
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.pdp_candidates = ['https://fingerprints.example/products/old'];
    evidence.product.candidate_url = 'https://fingerprints.example/products/old';
    evidence.product.final_pdp_url = 'https://fingerprints.example/products/new';
    evidence.product.pdp_url = evidence.product.final_pdp_url;
    evidence.product.navigation_succeeded = false;
    evidence.runtime.failed_phase = 'product_pdp_load';
    const partial = replayEvidence(evidence);
    partial.scan_status = 'partial';
    partial.failure_fingerprints = undefined;
    const codes = generateFailureFingerprints(partial, evidence);
    expect(codes).toEqual(expect.arrayContaining(['PDP_NAV_TIMEOUT', 'PDP_CANONICAL_REDIRECT', 'PRODUCT_MODULE_BUDGET_EXHAUSTED']));

    const proxyEvidence = baseEvidence('proxy-fingerprints.example');
    proxyEvidence.page.valid = false;
    proxyEvidence.page.access_category = 'proxy_error';
    proxyEvidence.runtime.proxy_attempts = [
      { provider: 'decodo', attempt: 1, configured_port: 10001, failure_reason: 'PROXY_TARGET_TUNNEL_FAILED' },
      { provider: 'decodo', attempt: 2, configured_port: 10002, failure_reason: 'PROXY_EXTERNAL_TUNNEL_FAILED' }
    ];
    expect(replayEvidence(proxyEvidence).failure_fingerprints).toEqual(expect.arrayContaining([
      'PROXY_TUNNEL_FAILED', 'PROXY_TARGET_TUNNEL_FAILED', 'PROXY_EXTERNAL_TUNNEL_FAILED'
    ]));

    const timeoutEvidence = baseEvidence('global-timeout.example');
    timeoutEvidence.page.valid = true;
    timeoutEvidence.page.access_category = 'scan_timeout';
    expect(replayEvidence(timeoutEvidence).failure_fingerprints).toContain('SCAN_GLOBAL_TIMEOUT');
  });

  it('clusters access failure fingerprints and review signals without calling them compliance defects', () => {
    const evidence = baseEvidence('access-fingerprints.example');
    evidence.page.valid = false;
    evidence.page.access_category = 'bot_protection';
    evidence.access = {
      ...evidence.access,
      valid_storefront: false,
      challenge_detected: true,
      challenge_type: 'unknown_challenge',
      challenge_solver_used: true,
      challenge_solver_result: 'failed',
      proxy_fallback_used: true,
      proxy_fallback_recovered: false,
      proxy_attempts: [
        { provider: 'decodo', geo: 'USA', port: 10001, attempt: 1, connect_duration_ms: null, egress_result: 'unreachable', neutral_https_result: 'unreachable', target_result: 'failed', failure_classification: 'PROXY_PROVIDER_UNREACHABLE' },
        { provider: 'decodo', geo: 'USA', port: 10002, attempt: 2, connect_duration_ms: null, egress_result: 'reachable', neutral_https_result: 'reachable', target_result: 'failed', failure_classification: 'PROXY_TARGET_TUNNEL_FAILED' },
        { provider: 'decodo', geo: 'USA', port: 10003, attempt: 3, connect_duration_ms: null, egress_result: 'reachable', neutral_https_result: 'reachable', target_result: 'failed', failure_classification: 'PROXY_TARGET_TUNNEL_FAILED' }
      ]
    };
    const replayed = replayEvidence(evidence);
    expect(replayed.failure_fingerprints).toEqual(expect.arrayContaining([
      'PROXY_PROVIDER_UNREACHABLE', 'PROXY_TARGET_TUNNEL_FAILED', 'PROXY_RETRY_EXHAUSTED', 'BROWSERLESS_FALLBACK_FAILED',
      'GENERIC_WAF_UNRESOLVED', 'VALID_STOREFRONT_NOT_REACHED'
    ]));
    const signals = qaPrioritySignals(replayed, evidence, replayed.consistency_violations || []).map((signal) => signal.code);
    expect(signals).toEqual(expect.arrayContaining(['UNKNOWN_CHALLENGE_TYPE', 'REPEATED_TARGET_TUNNEL_FAILURE', 'BROWSERLESS_FALLBACK_REQUIRED', 'CHALLENGE_SOLVER_FAILED']));
    expect(signals).not.toContain('SCAN_EXECUTION_FAILED');
  });

  it('surfaces missing finalization as a lifecycle fingerprint only when an audit is terminal', () => {
    const evidence = baseEvidence('missing-finalization.example');
    const audit = replayEvidence(evidence);
    audit.scan_status = 'failed';
    audit.trace_steps = '[]';
    expect(generateFailureFingerprints(audit, evidence)).toContain('SCAN_FINALIZATION_MISSING');
  });

  it('classifies a non-resolving storefront without blaming the proxy', () => {
    const evidence = baseEvidence('missing.example');
    evidence.page.valid = false;
    evidence.page.dns_resolution_status = 'not_resolved';
    evidence.page.access_category = 'dns_error';
    const result = replayEvidence(evidence);
    expect(result).toMatchObject({
      scan_status: 'failed',
      error_category: 'dns_error',
      consent_status: 'inconclusive',
      product_payload_status: 'not_tested'
    });
    expect(result.failure_fingerprints).toContain('DNS_RESOLUTION_FAILED');
    expect(result.failure_fingerprints).not.toContain('PROXY_TUNNEL_FAILED');
  });
});

describe('offline replay regression corpus', () => {
  const corpus = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/regression-corpus.json'), 'utf8')) as any[];
  for (const fixture of corpus) {
    it(fixture.name, () => {
      const evidence = baseEvidence('example.com');
      evidence.page = { ...evidence.page, valid: true, status_code: 200, access_category: 'none', ...fixture.page };
      evidence.selected_modules = fixture.selected_modules ?? evidence.selected_modules;
      evidence.access = { ...evidence.access, ...fixture.access, proxy_attempts: fixture.access?.proxy_attempts || evidence.access.proxy_attempts };
      evidence.consent = { ...evidence.consent, ...fixture.consent };
      evidence.product = { ...evidence.product, ...fixture.product };
      evidence.server_side = { ...evidence.server_side, ...fixture.server_side };
      evidence.runtime = { ...evidence.runtime, ...fixture.runtime };
      evidence.network.relevant_requests = fixture.requests || [];
      evidence.network.total_requests = evidence.network.relevant_requests.length;
      evidence.product.ga4_view_item_hits = evidence.network.relevant_requests.filter((request: TrackingRequestEvidence) => request.vendor === 'ga4' && request.event === 'view_item');
      const result = replayEvidence(evidence);
      expect(result).toMatchObject(fixture.expected);
    });
  }
});
