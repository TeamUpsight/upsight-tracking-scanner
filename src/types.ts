export type ScanStatus = 'completed' | 'partial' | 'failed' | 'cancelled' | 'pending' | 'scanning';

export type ErrorCategory =
  | 'none'
  | 'navigation_timeout'
  | 'scan_timeout'
  | 'rate_limited'
  | 'access_blocked'
  | 'bot_protection'
  | 'dns_error'
  | 'ssl_error'
  | 'proxy_error'
  | 'browser_error'
  | 'database_error'
  | 'cancelled'
  | 'unknown_error';

export type Confidence = 'high' | 'medium' | 'low';
export type ScanMode = 'normal' | 'diagnostic';
export type AuditModule = 'consent' | 'tracking' | 'server_side';

export type ConsentStatus =
  | 'pass'
  | 'missing'
  | 'prior_consent_violation'
  | 'consent_leakage'
  | 'not_detected'
  | 'inconclusive'
  | 'not_tested';

export type ProductPayloadStatus =
  | 'pass'
  | 'missing_view_item'
  | 'incomplete_view_item'
  | 'ga4_not_detected'
  | 'pdp_not_found'
  | 'not_tested'
  | 'inconclusive';

export type ServerSideStatus =
  | 'not_tested'
  | 'not_detected'
  | 'first_party_collection_detected'
  | 'likely_server_side'
  | 'strong_server_side_evidence'
  | 'partial_or_misconfigured'
  | 'inconclusive';

export type CollectionType =
  | 'not_tested'
  | 'first_party'
  | 'same_origin'
  | 'third_party'
  | 'mixed'
  | 'not_detected'
  | 'inconclusive';

export type CmpProvider =
  | 'OneTrust'
  | 'Cookiebot'
  | 'Didomi'
  | 'Usercentrics'
  | 'CookieYes'
  | 'Osano'
  | 'Iubenda'
  | 'TrustArc'
  | 'Fides'
  | 'Quantcast'
  | 'IAB TCF'
  | 'Shopify Privacy'
  | 'Custom'
  | 'Not Found'
  | 'Unknown';

export type CmsPlatform = 'Shopify' | 'WooCommerce' | 'Magento' | 'BigCommerce' | 'Webflow' | 'Custom' | 'Unknown';

export interface FindingConfidence {
  detected?: boolean | null;
  status?: string;
  confidence: Confidence;
  evidence: string[];
  reason_code: string;
}

export interface TrackingRequestEvidence {
  vendor: 'ga4' | 'meta' | 'google_ads' | 'unknown';
  kind: 'script' | 'collection' | 'data_layer';
  collector: 'third_party' | 'first_party' | 'same_origin';
  host: string;
  path: string;
  method: string;
  phase: string;
  timestamp: number;
  event?: string;
  measurement_id?: string;
  pixel_id?: string;
  page_url?: string;
  client_id?: string;
  session_id?: string;
  fbp?: string;
  fbc?: string;
  has_product?: boolean;
  product_id?: string;
  product_name?: string;
  brand?: string;
  category?: string;
  value?: number;
  source?: 'page' | 'service_worker' | 'performance_timing' | 'data_layer' | 'unknown';
}

export interface ScreenshotEvidence {
  name: string;
  mime_type: 'image/png' | 'image/jpeg';
  content_base64: string;
}

export interface EvidenceBundle {
  audit_id: string;
  scanner_version: string;
  build_commit: string | null;
  build_timestamp: string;
  rule_pack_version: string;
  domain: string;
  geo: 'USA' | 'EU' | 'UK';
  mode: ScanMode;
  selected_modules?: AuditModule[];
  page: {
    homepage_attempted: boolean;
    dns_resolution_status: 'resolved' | 'not_resolved' | 'inconclusive' | 'not_tested';
    valid: boolean | null;
    status_code: number | null;
    final_url: string | null;
    observed_domain: string | null;
    cross_domain_redirect_accepted: boolean;
    access_category: ErrorCategory | 'none';
    dns_sources: Record<string, 'resolved' | 'not_resolved' | 'inconclusive'>;
    retry_after_ms: number | null;
    bot_provider: string | null;
    bot_signals: string[];
    challenge_cleared: boolean;
    redirect_chain: Array<{ status: number | null; host: string; path: string }>;
    cms_signals: string[];
  };
  network: {
    total_requests: number;
    relevant_requests: TrackingRequestEvidence[];
    relevant_requests_truncated: boolean;
    installation_signals?: Array<{
      vendor: 'ga4' | 'meta';
      source: 'inline_script' | 'window_global' | 'script_content';
      identifiers: string[];
      phase: string;
    }>;
    response_statuses: Array<{ host: string; path: string; status: number; phase: string }>;
    novel_endpoints: Array<{ host: string; path: string }>;
  };
  consent: {
    executed: boolean;
    dom_selectors: string[];
    script_hosts: string[];
    network_signals: string[];
    cookie_names: string[];
    window_globals: string[];
    iframe_hosts: string[];
    provider_evidence: string[];
    banner_visible: boolean | null;
    interaction_attempted: boolean;
    rejection_verified: boolean;
    acceptance_attempted?: boolean;
    acceptance_verified?: boolean;
    // This records the minimal CMP action used to enable Tracking. It is
    // deliberately separate from the Consent module's reject audit.
    tracking_enablement?: 'not_needed' | 'already_enabled' | 'accepted' | 'failed' | 'inconclusive';
    post_reject_observation_completed: boolean;
  };
  product: {
    executed: boolean;
    discovery_executed: boolean;
    pdp_candidates: string[];
    candidate_url?: string | null;
    final_pdp_url?: string | null;
    pdp_url: string | null;
    navigation_succeeded: boolean;
    observation_ms: number;
    ga4_view_item_hits: TrackingRequestEvidence[];
    data_layer_view_item_hits?: TrackingRequestEvidence[];
    meta_view_content_hits: TrackingRequestEvidence[];
  };
  server_side: {
    executed: boolean;
    first_party_collection_count: number;
    same_origin_collection_count: number;
    third_party_collection_count: number;
    collector_cookie_names: string[];
    collector_cookie_persistence_checked: boolean;
    collector_cookie_persisted: boolean;
    strict_duplicate_count: number;
  };
  runtime: {
    started_at: string;
    completed_at: string | null;
    total_duration_ms: number | null;
    browserless_connect_ms: number | null;
    browserless_session_ms: number | null;
    browserless_host: string | null;
    browserless_session_timeout_ms: number | null;
    browser_connection_failure_code: string | null;
    proxy_retry_count: number;
    proxy_port: number | null;
    proxy_country: string | null;
    proxy_country_verified: boolean;
    proxy_egress_reachable: boolean;
    proxy_ip_hash: string | null;
    proxy_retry_recovered: boolean;
    proxy_initial_provider?: 'decodo' | 'browserless_residential';
    proxy_final_provider?: 'decodo' | 'browserless_residential';
    proxy_fallback_used?: boolean;
    proxy_fallback_recovered?: boolean;
    proxy_fallback_candidate?: boolean;
    proxy_attempts?: Array<{ provider: 'decodo' | 'browserless_residential'; attempt: number; configured_port: number | null; connection_ms?: number; failure_reason?: string; egress_reachable?: boolean; target_result?: string }>;
    browser_locale: string | null;
    browser_timezone: string | null;
    captcha_attempted: boolean;
    captcha_found: boolean;
    captcha_solved: boolean;
    bql_escalation_attempted: boolean;
    bql_escalation_succeeded: boolean;
    authorized_access_applied: boolean;
    last_successful_phase: string | null;
    failed_phase: string | null;
    product_consent_snapshot: {
      attempted: boolean;
      succeeded: boolean | null;
      failure_code: string | null;
      elapsed_ms: number | null;
    };
    module_durations_ms: Record<string, number>;
    evidence_size_bytes: number;
    screenshots: ScreenshotEvidence[];
  };
}

export interface QaFeedback {
  audit_id: string;
  verdict: 'correct' | 'incorrect';
  category: 'CMP' | 'Consent' | 'GA4' | 'Meta' | 'view_item' | 'PDP discovery' | 'server-side' | 'CMS' | 'bot/access' | 'other';
  expected_value: string | null;
  notes: string | null;
  created_at: string;
}

export interface QaPrioritySignal {
  code: string;
  label: string;
  points: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface StorefrontAudit {
  audit_id: string | number;
  domain: string;
  group_label: string | null;
  scan_started_at: string;
  scan_completed_at: string | null;
  scan_status: ScanStatus;
  scan_mode?: ScanMode;
  selected_modules?: AuditModule[];
  error_category: ErrorCategory;
  terminal_runtime_phase?: string | null;
  terminal_reason_code?: string | null;
  tested_geos: 'USA' | 'EU' | 'UK' | null;
  cms_platform_detected: CmsPlatform;
  overall_status: 'pass' | 'warning' | 'fail' | 'inconclusive' | null;
  overall_confidence: Confidence | null;
  consent_status: ConsentStatus | null;
  cmp_provider: CmpProvider | null;
  product_payload_status: ProductPayloadStatus | null;
  pdp_url_tested: string | null;
  server_side_status: ServerSideStatus | null;
  ss_collection_type: CollectionType | null;
  trace_steps: string | null;
  site_ga4_detected?: boolean | null;
  site_ga4_measurement_ids?: string[] | null;
  site_ga4_collection_hit_detected?: boolean | null;
  site_google_ads_detected?: boolean | null;
  site_meta_detected?: boolean | null;
  site_meta_collection_hit_detected?: boolean | null;
  evidence_bundle?: EvidenceBundle | null;
  finding_confidence?: Record<string, FindingConfidence> | null;
  reason_codes?: string[] | null;
  failure_fingerprints?: string[] | null;
  consistency_violations?: string[] | null;
  qa_priority?: number | null;
  qa_priority_signals?: QaPrioritySignal[] | null;
  qa_review_status?: 'correct' | null;
  qa_reviewed_at?: string | null;
  qa_feedback?: QaFeedback[] | null;
  runtime_metrics?: EvidenceBundle['runtime'] | null;
}

export interface ScanRequest {
  domain: string;
  tested_geos: 'USA' | 'EU' | 'UK';
  mode?: ScanMode;
  selected_modules?: AuditModule[];
}
