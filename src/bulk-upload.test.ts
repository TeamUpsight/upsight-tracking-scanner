import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBulkUploadRouter } from './bulk-upload';
import { isRecoverableStaleAudit, queueJobForAudit, type AuditQueueJob } from './audit-lifecycle';
import { AuditDatabase } from './db';

let server: Server;
let db: AuditDatabase;
let add = vi.fn<(job: AuditQueueJob) => void>();
let create: ReturnType<typeof vi.spyOn>;
let url: string;
beforeEach(async () => {
  vi.stubEnv('USE_MEMORY_DB', 'true');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('DB_HOST', '');
  db = new AuditDatabase();
  create = vi.spyOn(db, 'createAudit');
  add = vi.fn<(job: AuditQueueJob) => void>(); // No queue worker or scanner is started by these API tests.
  const app = express();
  app.use('/api/v1/scan/bulk', createBulkUploadRouter({ db, queue: { add }, maxBatchDomains: 25, maxCsvBytes: 10_000 }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/scan/bulk`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
});

async function upload(csv?: string, overrides: Record<string, string> = {}) {
  const body = new FormData();
  if (csv !== undefined) body.append('file', new Blob([csv], { type: 'text/csv' }), 'domains.csv');
  for (const [field, value] of Object.entries({
    tested_geos: 'USA', tested_country: 'US', mode: 'diagnostic', group_label: 'default-group',
    selected_modules: '["consent","tracking"]', ...overrides
  })) body.append(field, value);
  const response = await fetch(url, { method: 'POST', body });
  return { status: response.status, body: await response.json() };
}

describe('bulk CSV API with memory persistence and a mocked queue', () => {
  it('keeps the legacy response and domain-only UI inheritance', async () => {
    const result = await upload('domain\nexample.com\nexample.org\nEXAMPLE.COM');
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ count: 2, duplicates_removed: 1 });
    expect(result.body.audits[0]).toMatchObject({
      domain: 'example.com', tested_geos: 'USA', scan_mode: 'diagnostic', group_label: 'default-group',
      selected_modules: ['consent', 'tracking'], queue_options: { tested_country: 'US', is_bulk: true, enable_captcha_solving: false, proxy_provider: 'decodo' }
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(2);
    expect(result.body).not.toHaveProperty('csv');
  });
  it('persists and queues mixed row configurations, including a full override of incompatible UI defaults', async () => {
    const result = await upload('domain,region,exact_country,mode,group_label,modules\nsite1.com,USA,US,diagnostic,us,"consent,tracking"\nsite2.com,UK,GB,normal,uk,consent\nsite3.com,EU,DE,diagnostic,de,"consent,serverside"\nsite4.com,EU,FR,normal,fr,"consent,tracking,serverside"', {
      selected_modules: '["tracking"]', mode: 'normal'
    });
    expect(result.status).toBe(202);
    expect(result.body.count).toBe(4);
    expect(result.body.audits.map((audit) => [audit.tested_geos, audit.queue_options.tested_country, audit.scan_mode, audit.group_label, audit.selected_modules])).toEqual([
      ['USA', 'US', 'diagnostic', 'us', ['consent', 'tracking']],
      ['UK', 'GB', 'normal', 'uk', ['consent']],
      ['EU', 'DE', 'diagnostic', 'de', ['consent', 'server_side']],
      ['EU', 'FR', 'normal', 'fr', ['consent', 'tracking', 'server_side']]
    ]);
    for (const audit of result.body.audits) {
      expect(add).toHaveBeenCalledWith(queueJobForAudit(audit));
      expect(await db.getAudit(audit.audit_id)).toMatchObject(audit);
    }
  });
  it.each([
    ['region', 'APAC', {}], ['region,exact_country', 'EU,US', {}],
    ['mode', 'fast', {}], ['modules', '"consent,foobar"', {}],
    ['modules', '"tracking,serverside"', {}], ['modules', '', { selected_modules: '[]' }]
  ])('rejects invalid %s atomically after 20 valid rows', async (columns, invalid, overrides) => {
    const csv = `domain,${columns}\n${Array.from({ length: 20 }, (_, index) => `site${index}.com,${columns === 'modules' ? 'consent' : columns === 'region,exact_country' ? 'USA,US' : columns === 'region' ? 'USA' : 'normal'}`).join('\n')}\ninvalid.example,${invalid}`;
    const result = await upload(csv, overrides);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'CSV validation failed.', error_count: 1, errors_returned: 1, errors_truncated: false });
    expect(result.body.rows[0].row).toBe(22);
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(await db.getPendingAudits()).toEqual([]);
  });
  it('keeps the first duplicate configuration and disables challenge solving despite arbitrary request/CSV flags', async () => {
    const result = await upload('domain,region,exact_country,enable_captcha_solving,proxy_provider\nexample.com,USA,US,true,browserless_residential\nexample.com,EU,DE,true,browserless_residential', {
      enable_captcha_solving: 'true', proxy_provider: 'browserless_residential'
    });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ count: 1, duplicates_removed: 1 });
    expect(result.body.audits[0]).toMatchObject({ tested_geos: 'USA', queue_options: { tested_country: 'US', enable_captcha_solving: false, is_bulk: true, proxy_provider: 'decodo' } });
    expect(add.mock.calls[0][0]).toMatchObject({ tested_country: 'US', enable_captcha_solving: false, is_bulk: true, proxy_provider: 'decodo' });
  });
  it('rejects the entire batch above the configured unique-domain limit', async () => {
    const result = await upload(`domain\n${Array.from({ length: 26 }, (_, index) => `site${index}.com`).join('\n')}`);
    expect(result.status).toBe(413);
    expect(result.body.error).toMatch(/26 unique domains; maximum is 25/);
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it('preserves in-memory file-size protection before parsing or audit creation', async () => {
    const result = await upload(`domain\n${'a'.repeat(10_001)}`);
    expect(result.status).toBe(413);
    expect(result.body.error).toBe('CSV exceeds the 10000-byte limit.');
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it('requires a file and rejects malformed quoting without creating audits', async () => {
    expect((await upload()).status).toBe(400);
    expect((await upload('domain,modules\nexample.com,"consent')).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it('bounds row errors without reflecting CSV content', async () => {
    const result = await upload(`domain,mode\n${Array.from({ length: 60 }, (_, index) => `site${index}.com,private-token`).join('\n')}`);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error_count: 60, errors_returned: 50, errors_truncated: true });
    expect(JSON.stringify(result.body)).not.toContain('private-token');
    expect(create).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
  it('restores pending and stale row-specific configuration through normal recovery helpers', async () => {
    const result = await upload('domain,region,exact_country,mode,group_label,modules\nexample.com,EU,DE,diagnostic,eu-canary,"consent,serverside"');
    expect(result.status).toBe(202);
    const original = result.body.audits[0];
    const originalJob: AuditQueueJob = add.mock.calls[0][0];
    // Fresh persisted snapshots simulate the queue being rebuilt after process restart.
    const pending = JSON.parse(JSON.stringify((await db.getPendingAudits())[0]));
    expect(queueJobForAudit(pending)).toEqual(originalJob);
    expect(pending).toMatchObject({ tested_geos: 'EU', group_label: 'eu-canary' });
    await db.claimPendingAudit(original.audit_id);
    await db.updateAudit(original.audit_id, { scan_started_at: '2020-01-01T00:00:00.000Z' });
    const stale = (await db.getRecoverableStaleAudits(10))[0];
    expect(isRecoverableStaleAudit(stale, false, [])).toBe(true);
    const requeued = await db.requeueStaleAudit(stale.audit_id, '[]');
    expect(queueJobForAudit(requeued)).toEqual(originalJob);
    expect(requeued).toMatchObject({
      tested_geos: 'EU', group_label: 'eu-canary', scan_mode: 'diagnostic', selected_modules: ['consent', 'server_side'],
      queue_options: { tested_country: 'DE', is_bulk: true, enable_captcha_solving: false }
    });
    const claimed = await db.claimPendingAudit(original.audit_id);
    // Queue execution reads region/group from this claim and country/mode/modules from the reconstructed job.
    expect({ region: claimed.tested_geos, group: claimed.group_label, ...queueJobForAudit(requeued) }).toMatchObject({
      region: 'EU', group: 'eu-canary', tested_country: 'DE', scan_mode: 'diagnostic', selected_modules: ['consent', 'server_side']
    });
  });
});
