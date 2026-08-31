import type {
  ErrorCategory,
  EvidenceBundle,
  AuditModule,
  ScanMode,
  ScreenshotEvidence,
  TrackingRequestEvidence
} from '../../types';
import { parseGA4DataLayerEntry, parseGA4Request, toGA4Evidence } from '../tracking/ga4';
import { parseMetaRequest, toMetaEvidence } from '../tracking/meta';
import { RULE_PACK_VERSION } from '../version';
import { buildMetadata } from '../../build-metadata';

const KNOWN_TRACKING_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'facebook.com',
  'connect.facebook.net'
];

function isKnownTrackingEndpoint(host: string, path: string) {
  if (KNOWN_TRACKING_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) return true;
  return (host === 'google.com' || host === 'www.google.com') && path.replace(/\/+$/, '') === '/ccm/collect';
}

function safeHostPath(raw: string) {
  try {
    const url = new URL(raw);
    return { host: url.hostname.toLowerCase(), path: url.pathname.slice(0, 240) || '/' };
  } catch {
    return { host: 'invalid', path: '/' };
  }
}

function baseDomain(host: string) {
  return host.toLowerCase().replace(/^www\./, '');
}

function collectorFor(host: string, domain: string): TrackingRequestEvidence['collector'] {
  const normalizedHost = baseDomain(host);
  const normalizedDomain = baseDomain(domain);
  if (normalizedHost === normalizedDomain) return 'same_origin';
  if (normalizedHost.endsWith(`.${normalizedDomain}`)) return 'first_party';
  return 'third_party';
}

function looksLikeUnknownCollector(path: string, body: string) {
  return /\/(g\/collect|collect|events?|metrics|measure|tr)\/?$/i.test(path) &&
    /(?:^|[?&])(tid=G-|en=|ev=|event=|id=\d+)/i.test(body);
}

export class EvidenceCollector {
  readonly bundle: EvidenceBundle;
  private collectionDomain: string;
  private readonly maxRelevantRequests: number;
  private readonly maxResponses: number;

  constructor(input: {
    auditId: string | number;
    domain: string;
    geo: 'USA' | 'EU' | 'UK';
  mode?: ScanMode;
    selectedModules?: AuditModule[];
    startedAt?: string;
  }) {
    const mode = input.mode || 'normal';
    this.maxRelevantRequests = mode === 'diagnostic' ? 500 : 200;
    this.maxResponses = mode === 'diagnostic' ? 100 : 30;
    this.collectionDomain = input.domain;
    this.bundle = {
      audit_id: String(input.auditId),
      ...buildMetadata,
      rule_pack_version: RULE_PACK_VERSION,
      domain: input.domain,
      geo: input.geo,
      mode,
      selected_modules: input.selectedModules,
      page: {
        homepage_attempted: false,
        dns_resolution_status: 'not_tested',
        valid: null,
        status_code: null,
        final_url: null,
        observed_domain: null,
        cross_domain_redirect_accepted: false,
        access_category: 'none',
        dns_sources: {},
        retry_after_ms: null,
        bot_provider: null,
        bot_signals: [],
        challenge_cleared: false,
        redirect_chain: [],
        cms_signals: []
      },
      network: {
        total_requests: 0,
        relevant_requests: [],
        relevant_requests_truncated: false,
        installation_signals: [],
        response_statuses: [],
        novel_endpoints: []
      },
      consent: {
        executed: false,
        dom_selectors: [],
        script_hosts: [],
        network_signals: [],
        cookie_names: [],
        window_globals: [],
        iframe_hosts: [],
        provider_evidence: [],
        banner_visible: null,
        interaction_attempted: false,
        rejection_verified: false,
        acceptance_attempted: false,
        acceptance_verified: false,
        post_reject_observation_completed: false
      },
      product: {
        executed: false,
        discovery_executed: false,
        pdp_candidates: [],
        pdp_url: null,
        navigation_succeeded: false,
        observation_ms: 0,
        ga4_view_item_hits: [],
        data_layer_view_item_hits: [],
        meta_view_content_hits: []
      },
      server_side: {
        executed: false,
        first_party_collection_count: 0,
        same_origin_collection_count: 0,
        third_party_collection_count: 0,
        collector_cookie_names: [],
        collector_cookie_persistence_checked: false,
        collector_cookie_persisted: false,
        strict_duplicate_count: 0
      },
      runtime: {
        started_at: input.startedAt || new Date().toISOString(),
        completed_at: null,
        total_duration_ms: null,
        browserless_connect_ms: null,
        browserless_session_ms: null,
        browserless_host: null,
        browserless_session_timeout_ms: null,
        browser_connection_failure_code: null,
        proxy_retry_count: 0,
        proxy_port: null,
        proxy_country: null,
        proxy_country_verified: false,
        proxy_egress_reachable: false,
        proxy_ip_hash: null,
        proxy_retry_recovered: false,
        proxy_initial_provider: 'decodo',
        proxy_final_provider: 'decodo',
        proxy_fallback_used: false,
        proxy_fallback_recovered: false,
        proxy_fallback_candidate: false,
        proxy_attempts: [],
        browser_locale: null,
        browser_timezone: null,
        captcha_attempted: false,
        captcha_found: false,
        captcha_solved: false,
        bql_escalation_attempted: false,
        bql_escalation_succeeded: false,
        authorized_access_applied: false,
        last_successful_phase: 'initialization',
        failed_phase: null,
        product_consent_snapshot: {
          attempted: false,
          succeeded: null,
          failure_code: null,
          elapsed_ms: null
        },
        module_durations_ms: {},
        evidence_size_bytes: 0,
        screenshots: []
      }
    };
  }

  captureRequest(input: {
    url: string;
    body?: string;
    method?: string;
    phase: string;
    timestamp?: number;
    source?: TrackingRequestEvidence['source'];
  }): TrackingRequestEvidence | null {
    this.bundle.network.total_requests += 1;
    const { host, path } = safeHostPath(input.url);
    const collector = collectorFor(host, this.collectionDomain);
    const common = {
      host,
      path,
      method: input.method || 'GET',
      phase: input.phase,
      timestamp: input.timestamp || Date.now(),
      collector,
      source: input.source || 'page'
    };
    const ga4 = parseGA4Request(input.url, input.body || '');
    const meta = ga4 ? null : parseMetaRequest(input.url, input.body || '');
    const evidence = ga4 ? toGA4Evidence(ga4, common) : meta ? toMetaEvidence(meta, common) : null;

    if (evidence) {
      if (this.bundle.network.relevant_requests.length < this.maxRelevantRequests) {
        this.bundle.network.relevant_requests.push(evidence);
      } else {
        this.bundle.network.relevant_requests_truncated = true;
      }
      if (evidence.vendor === 'ga4' && evidence.kind === 'collection' && evidence.event === 'view_item') {
        if (this.bundle.product.ga4_view_item_hits.length < 20) this.bundle.product.ga4_view_item_hits.push(evidence);
      }
      if (evidence.vendor === 'meta' && evidence.kind === 'collection' && evidence.event?.toLowerCase() === 'viewcontent') {
        if (this.bundle.product.meta_view_content_hits.length < 20) this.bundle.product.meta_view_content_hits.push(evidence);
      }
      return evidence;
    }

    if (!isKnownTrackingEndpoint(host, path) && looksLikeUnknownCollector(path, `${input.url}?${input.body || ''}`)) {
      const key = `${host}${path}`;
      if (!this.bundle.network.novel_endpoints.some((endpoint) => `${endpoint.host}${endpoint.path}` === key) &&
        this.bundle.network.novel_endpoints.length < 20) {
        this.bundle.network.novel_endpoints.push({ host, path });
      }
    }
    return null;
  }

  captureDataLayerViewItem(input: {
    entry: unknown;
    pageUrl: string;
    phase: string;
    timestamp?: number;
  }): TrackingRequestEvidence | null {
    const parsed = parseGA4DataLayerEntry(input.entry);
    if (!parsed) return null;
    const { host, path } = safeHostPath(input.pageUrl);
    const evidence: TrackingRequestEvidence = {
      vendor: 'ga4',
      kind: 'data_layer',
      collector: collectorFor(host, this.collectionDomain),
      host,
      path,
      method: 'PUSH',
      phase: input.phase,
      timestamp: input.timestamp || Date.now(),
      source: 'data_layer',
      event: parsed.event,
      measurement_id: parsed.measurement_id || undefined,
      page_url: input.pageUrl,
      has_product: parsed.has_product,
      product_id: parsed.product_id,
      product_name: parsed.product_name,
      brand: parsed.brand,
      category: parsed.category,
      value: parsed.value
    };
    const hits = this.bundle.product.data_layer_view_item_hits ||= [];
    const duplicate = hits.some((hit) => hit.event === evidence.event && hit.page_url === evidence.page_url &&
      hit.product_id === evidence.product_id && hit.product_name === evidence.product_name);
    if (!duplicate && hits.length < 20) hits.push(evidence);
    return duplicate ? null : evidence;
  }

  captureResponse(input: { url: string; status: number; phase: string }) {
    if (this.bundle.network.response_statuses.length >= this.maxResponses) return;
    if (this.bundle.mode === 'normal' && input.status < 400) return;
    const { host, path } = safeHostPath(input.url);
    this.bundle.network.response_statuses.push({ host, path, status: input.status, phase: input.phase });
  }

  addInstallationSignal(input: {
    vendor: 'ga4' | 'meta';
    source: 'inline_script' | 'window_global' | 'script_content';
    identifiers?: string[];
    phase: string;
  }) {
    const signals = this.bundle.network.installation_signals ||= [];
    const identifiers = [...new Set(input.identifiers || [])].slice(0, 20);
    const key = `${input.vendor}:${input.source}:${identifiers.join(',')}`;
    if (signals.some((signal) => `${signal.vendor}:${signal.source}:${signal.identifiers.join(',')}` === key) || signals.length >= 30) return;
    signals.push({ ...input, identifiers });
  }

  setPage(input: {
    attempted?: boolean;
    dnsResolutionStatus?: EvidenceBundle['page']['dns_resolution_status'];
    valid?: boolean | null;
    statusCode?: number | null;
    finalUrl?: string | null;
    observedDomain?: string | null;
    crossDomainRedirectAccepted?: boolean;
    accessCategory?: ErrorCategory | 'none';
    dnsSources?: EvidenceBundle['page']['dns_sources'];
    retryAfterMs?: number | null;
    botProvider?: string | null;
    botSignals?: string[];
    challengeCleared?: boolean;
    redirectChain?: EvidenceBundle['page']['redirect_chain'];
    cmsSignals?: string[];
  }) {
    if (input.attempted !== undefined) this.bundle.page.homepage_attempted = input.attempted;
    if (input.dnsResolutionStatus !== undefined) this.bundle.page.dns_resolution_status = input.dnsResolutionStatus;
    if (input.valid !== undefined) this.bundle.page.valid = input.valid;
    if (input.statusCode !== undefined) this.bundle.page.status_code = input.statusCode;
    if (input.finalUrl !== undefined) this.bundle.page.final_url = input.finalUrl;
    if (input.observedDomain !== undefined) this.bundle.page.observed_domain = input.observedDomain;
    if (input.crossDomainRedirectAccepted !== undefined) this.bundle.page.cross_domain_redirect_accepted = input.crossDomainRedirectAccepted;
    if (input.accessCategory) this.bundle.page.access_category = input.accessCategory;
    if (input.dnsSources) this.bundle.page.dns_sources = { ...input.dnsSources };
    if (input.retryAfterMs !== undefined) this.bundle.page.retry_after_ms = input.retryAfterMs;
    if (input.botProvider !== undefined) this.bundle.page.bot_provider = input.botProvider;
    if (input.botSignals) this.bundle.page.bot_signals = [...new Set(input.botSignals)].slice(0, 30);
    if (input.challengeCleared !== undefined) this.bundle.page.challenge_cleared = input.challengeCleared;
    if (input.redirectChain) this.bundle.page.redirect_chain = input.redirectChain.slice(0, 20);
    if (input.cmsSignals) this.bundle.page.cms_signals = [...new Set(input.cmsSignals)].slice(0, 20);
  }

  setObservedDomain(domain: string) {
    const normalized = domain.toLowerCase().replace(/^www\./, '');
    if (!normalized) return;
    this.collectionDomain = normalized;
    this.bundle.page.observed_domain = domain.toLowerCase();
    for (const request of this.bundle.network.relevant_requests) {
      request.collector = collectorFor(request.host, normalized);
    }
  }

  addScreenshot(screenshot: ScreenshotEvidence) {
    if (this.bundle.mode !== 'diagnostic' || this.bundle.runtime.screenshots.length >= 3) return;
    this.bundle.runtime.screenshots.push(screenshot);
  }

  complete(startMs: number) {
    this.bundle.runtime.completed_at = new Date().toISOString();
    this.bundle.runtime.total_duration_ms = Date.now() - startMs;
    let serialized = JSON.stringify(this.bundle);
    this.bundle.runtime.evidence_size_bytes = Buffer.byteLength(serialized, 'utf8');
    serialized = JSON.stringify(this.bundle);
    if (Buffer.byteLength(serialized, 'utf8') > 2_000_000) {
      this.bundle.runtime.screenshots = [];
      this.bundle.network.relevant_requests = this.bundle.network.relevant_requests.slice(0, 100);
      this.bundle.network.relevant_requests_truncated = true;
      this.bundle.runtime.evidence_size_bytes = Buffer.byteLength(JSON.stringify(this.bundle), 'utf8');
    }
    return this.bundle;
  }
}
