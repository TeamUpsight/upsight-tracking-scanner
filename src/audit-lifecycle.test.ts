import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyAuditTermination, isRecoverableStaleAudit, queueJobForAudit, rerunAuditOptions, shouldEnqueueAudit } from './audit-lifecycle';
import { AuditDatabase } from './db';
import { decideAccessTransition } from './scanner/access-state-machine';
import { EvidenceCollector } from './scanner/evidence/evidence-collector';
import { replayEvidence } from './scanner/quality/replay';
import type { StorefrontAudit } from './types';

function audit(overrides: Partial<StorefrontAudit> = {}): StorefrontAudit {
  return {
    audit_id: 'audit-1',
    domain: 'example.com',
    group_label: 'batch-a',
    scan_started_at: '2026-08-31T00:00:00.000Z',
    scan_completed_at: null,
    scan_status: 'pending',
    scan_mode: 'normal',
    selected_modules: ['tracking', 'server_side'],
    error_category: 'none',
    tested_geos: 'EU',
    cms_platform_detected: 'Unknown',
    overall_status: null,
    overall_confidence: null,
    consent_status: null,
    cmp_provider: null,
    product_payload_status: null,
    pdp_url_tested: null,
    server_side_status: null,
    ss_collection_type: null,
    trace_steps: '[]',
    ...overrides
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('API queue lifecycle contracts', () => {
  it('keeps a queue timeout distinct from manual cancellation', () => {
    expect(classifyAuditTermination(false, true)).toEqual({ category: 'scan_timeout', scanStatus: 'failed' });
    expect(classifyAuditTermination(true, true)).toEqual({ category: 'cancelled', scanStatus: 'cancelled' });
  });

  it('propagates stored scan mode and selected modules to single and bulk jobs', () => {
    const source = audit({
      scan_mode: 'diagnostic', selected_modules: ['server_side', 'tracking'],
      queue_options: { enable_captcha_solving: false, is_bulk: false, proxy_provider: 'decodo' }
    });
    expect(queueJobForAudit(source)).toMatchObject({
      scan_mode: 'diagnostic', selected_modules: ['tracking', 'server_side'], is_bulk: false, proxy_provider: 'decodo'
    });
    expect(queueJobForAudit(source, { is_bulk: true })).toMatchObject({
      scan_mode: 'diagnostic', selected_modules: ['tracking', 'server_side'], is_bulk: true, proxy_provider: 'decodo'
    });
  });

  it('does not enqueue a second job for an audit that is already queued or active', () => {
    expect(shouldEnqueueAudit(false)).toBe(true);
    expect(shouldEnqueueAudit(true)).toBe(false);
  });

  it('preserves source options for reruns while changing only their explicit execution override', () => {
    const source = audit({
      scan_mode: 'diagnostic', selected_modules: ['tracking'],
      queue_options: { enable_captcha_solving: true, is_bulk: true, proxy_provider: 'decodo' }
    });
    expect(rerunAuditOptions(source)).toMatchObject({
      domain: 'example.com', tested_geos: 'EU', group_label: 'batch-a', scan_mode: 'diagnostic', selected_modules: ['tracking'],
      queue_options: { enable_captcha_solving: true, is_bulk: true, proxy_provider: 'decodo' }
    });
    expect(rerunAuditOptions(source, 'normal')).toMatchObject({ scan_mode: 'normal', selected_modules: ['tracking'] });
    expect(queueJobForAudit({ ...source, ...rerunAuditOptions(source, undefined, { is_bulk: false, proxy_provider: 'browserless_residential' }) })).toMatchObject({
      is_bulk: false, enable_captcha_solving: true, proxy_provider: 'browserless_residential'
    });
  });

  it('recovers only orphaned, unfinished audits', () => {
    expect(isRecoverableStaleAudit(audit({ scan_status: 'scanning' }), false, [])).toBe(true);
    expect(isRecoverableStaleAudit(audit(), true, [])).toBe(false);
    expect(isRecoverableStaleAudit(audit({ scan_status: 'failed' }), false, [])).toBe(false);
    expect(isRecoverableStaleAudit(audit(), false, [{ step: 'scan_finalized' }])).toBe(false);
  });

  it('never automatically upgrades bulk Decodo exhaustion to Browserless Residential', () => {
    expect(decideAccessTransition({
      event: 'proxy_failure', isBulk: true, decodoAttempts: 1, maxDecodoRetries: 1, fallbackEnabled: true, challengeSolvingEnabled: false
    })).toBe('finalize');
  });
});

describe('audit persistence contracts', () => {
  it('does not fall back to memory storage unless explicitly enabled', async () => {
    vi.stubEnv('USE_MEMORY_DB', 'false');
    vi.stubEnv('DB_HOST', '');
    vi.stubEnv('DB_NAME', '');
    vi.stubEnv('DB_USER', '');
    await expect(new AuditDatabase().createAudit('example.com')).rejects.toThrow('memory storage is not enabled');
  });

  it('does not overwrite finalized records during stale recovery', async () => {
    vi.stubEnv('USE_MEMORY_DB', 'true');
    vi.stubEnv('DB_HOST', '');
    vi.stubEnv('DB_NAME', '');
    vi.stubEnv('DB_USER', '');
    const db = new AuditDatabase();
    const finalized = await db.createAudit('finalized.example', 'USA');
    await db.updateAudit(finalized.audit_id, { scan_status: 'failed', error_category: 'scan_timeout' });
    await expect(db.recoverStaleAudit(finalized.audit_id, { scan_status: 'failed', error_category: 'unknown_error' })).resolves.toBeNull();
    await expect(db.getAudit(finalized.audit_id)).resolves.toMatchObject({ error_category: 'scan_timeout' });

    const stale = await db.createAudit('stale.example', 'USA');
    await db.updateAudit(stale.audit_id, { scan_started_at: '2026-08-01T00:00:00.000Z' });
    await expect(db.claimPendingAudit(stale.audit_id)).resolves.toMatchObject({ scan_status: 'scanning' });
    await expect(db.getAudit(stale.audit_id)).resolves.not.toMatchObject({ scan_started_at: '2026-08-01T00:00:00.000Z' });
    await expect(db.claimPendingAudit(stale.audit_id)).resolves.toBeNull();
    await expect(db.requeueStaleAudit(stale.audit_id, '[]')).resolves.toMatchObject({ scan_status: 'pending' });
    await expect(db.claimPendingAudit(stale.audit_id)).resolves.toMatchObject({ scan_status: 'scanning' });
  });

  it('persists PDP, tracking-enablement, and safe proxy fallback evidence through the existing evidence model', () => {
    const evidence = new EvidenceCollector({ auditId: 'evidence', domain: 'example.com', geo: 'USA', selectedModules: ['tracking'] }).bundle;
    evidence.page.valid = true;
    evidence.consent.tracking_enablement = 'accepted';
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    evidence.product.candidate_url = 'https://example.com/products/candidate';
    evidence.product.final_pdp_url = 'https://example.com/products/final';
    evidence.product.pdp_url = evidence.product.final_pdp_url;
    evidence.product.navigation_succeeded = true;
    evidence.runtime.proxy_fallback_candidate = true;
    evidence.runtime.proxy_attempts = [{ provider: 'decodo', attempt: 1, configured_port: 10001, failure_reason: 'PROXY_TUNNEL_FAILED' }];

    const persisted = replayEvidence(evidence);
    expect(persisted.pdp_url_tested).toBe('https://example.com/products/final');
    expect(persisted.evidence_bundle?.consent.tracking_enablement).toBe('accepted');
    expect(persisted.runtime_metrics?.proxy_fallback_candidate).toBe(true);
    expect(persisted.runtime_metrics?.proxy_attempts).toEqual(evidence.runtime.proxy_attempts);
    expect(persisted.evidence_bundle?.access.proxy_attempts).toEqual(evidence.access.proxy_attempts);
    expect(persisted.evidence_bundle?.scanner_version).toBeTruthy();
    expect(persisted.evidence_bundle?.build_commit).toBeDefined();
    expect(JSON.stringify(persisted.evidence_bundle)).not.toMatch(/proxy.*(?:password|credential)|browserless.*token/i);
  });
});
