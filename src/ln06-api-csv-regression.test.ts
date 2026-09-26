import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditDatabase } from './db';
import { csvCell } from './csv-cell';
import { EvidenceCollector } from './scanner/evidence/evidence-collector';

afterEach(() => vi.unstubAllEnvs());

function memoryDatabase() {
  vi.stubEnv('USE_MEMORY_DB', 'true');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('DB_HOST', '');
  return new AuditDatabase();
}

describe('LN-06 API and CSV projection closure', () => {
  it('keeps list and export light, bounded and equal to persisted canonical fields', async () => {
    const db = memoryDatabase();
    const audit = await db.createAudit('=unsafe.example', 'USA', 'ln06', 'normal', ['tracking']);
    const evidence = new EvidenceCollector({ auditId: audit.audit_id, domain: 'unsafe.example', geo: 'USA' }).bundle;
    evidence.network.relevant_requests.push({
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'www.google-analytics.com', path: '/g/collect',
      method: 'GET', phase: 'homepage', timestamp: 1, event: 'page_view', measurement_id: 'G-TEST', client_id: 'raw-private-client',
      page_url: 'https://unsafe.example/'
    } as typeof evidence.network.relevant_requests[number]);
    await db.updateAudit(audit.audit_id, {
      scan_status: 'completed', overall_status: 'warning', overall_confidence: 'medium', consent_status: 'not_tested',
      product_payload_status: 'ga4_not_detected', server_side_status: 'not_tested', reason_codes: ['GA4_NOT_DETECTED'],
      evidence_bundle: evidence, trace_steps: 'private-heavy-trace'
    });
    const detail = await db.getAudit(audit.audit_id);
    const page = await db.getAuditPage({ page_size: 1000 });
    const row = page.items[0];
    const exported = (await db.getAuditsForExportByGroup('ln06'))[0];
    expect(page.pagination.page_size).toBe(100);
    expect(page.items).toHaveLength(1);
    expect(detail?.evidence_bundle).toEqual(evidence);
    for (const field of ['overall_status', 'overall_confidence', 'consent_status', 'product_payload_status', 'server_side_status'] as const) {
      expect(row[field]).toEqual(detail?.[field]);
      expect(exported[field]).toEqual(detail?.[field]);
    }
    for (const projected of [row, exported]) {
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain('raw-private-client');
      expect(serialized).not.toContain('private-heavy-trace');
      expect(projected).not.toHaveProperty('evidence_bundle');
      expect(projected).not.toHaveProperty('trace_steps');
      expect(projected).not.toHaveProperty('finding_confidence');
    }
    expect(row).not.toHaveProperty('reason_codes');
    expect(exported.reason_codes).toEqual(detail?.reason_codes);
    expect(csvCell(exported.domain)).toBe("\"'=unsafe.example\"");
    expect(csvCell(' +SUM(1,1)')).toBe("\"' +SUM(1,1)\"");
  });

  it('caps memory-mode CSV projection at the SQL export limit', async () => {
    const db = memoryDatabase();
    for (let index = 0; index < 5001; index++) await db.createAudit(`site-${index}.example`, 'USA', 'ln06');
    expect((await db.getAuditsForExportByGroup('ln06'))).toHaveLength(5000);
    expect((await db.getAuditPage({ page_size: 5001 })).items).toHaveLength(100);
  });
});
