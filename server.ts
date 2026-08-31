import { ZipArchive } from 'archiver';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { AuditDatabase } from './src/db';
import {
  activeScansRegistry,
  getProxyMetricsReport,
  hydrateProxyHealth,
  normalizeAuditDomain,
  runStorefrontAudit,
  validateProxyConfiguration
} from './src/scanner';
import { buildDebugPackageFiles } from './src/scanner/quality/debug-package';
import { reviewAudit } from './src/scanner/quality/audit-reviewer';
import { buildQualityMetrics } from './src/scanner/quality/metrics';
import { qaPrioritySignals } from './src/scanner/quality/fingerprints';
import { compareReplay, replayEvidence } from './src/scanner/quality/replay';
import { buildLatestReviewQueue } from './src/scanner/quality/review-queue';
import type { EvidenceBundle, QaFeedback, ScanMode, StorefrontAudit } from './src/types';
import { normalizeAuditModules } from './src/audit-modules';
import { isRecoverableStaleAudit, queueJobForAudit, rerunAuditOptions, shouldEnqueueAudit, type AuditQueueJob } from './src/audit-lifecycle';
import { boundedInteger, bulkProxyRetryLimit, globalScanTimeoutMs } from './src/shared/config';
import { buildMetadata } from './src/build-metadata';

dotenv.config();

const app = express();
const db = new AuditDatabase();
const port = boundedInteger(process.env.PORT, 3000, 1, 65_535);
const maxBatchDomains = boundedInteger(process.env.MAX_BATCH_SIZE, 5_000, 1, 5_000);
const maxCsvBytes = boundedInteger(process.env.MAX_CSV_BYTES, 5_242_880, 10_000, 10_000_000);
const scanConcurrency = boundedInteger(process.env.SCAN_CONCURRENCY, 3, 1, 10);
const scanTimeoutMs = globalScanTimeoutMs();
const staleScanMinutes = boundedInteger(process.env.STALE_SCAN_MINUTES, 10, 3, 1_440);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxCsvBytes, files: 1 } });

function auditsWithCurrentQa(audits: StorefrontAudit[], feedback: QaFeedback[]) {
  const feedbackByAudit = new Map<string, QaFeedback[]>();
  for (const item of feedback) {
    const items = feedbackByAudit.get(String(item.audit_id)) || [];
    items.push(item);
    feedbackByAudit.set(String(item.audit_id), items);
  }
  return audits.map((audit) => {
    if (!audit.evidence_bundle || audit.qa_review_status === 'correct') {
      return { ...audit, qa_priority: audit.qa_review_status === 'correct' ? 0 : audit.qa_priority, qa_priority_signals: [] };
    }
    const auditFeedback = feedbackByAudit.get(String(audit.audit_id)) || audit.qa_feedback || [];
    const signals = qaPrioritySignals(audit, audit.evidence_bundle, audit.consistency_violations || []);
    if (auditFeedback.some((item) => item.verdict === 'incorrect')) {
      signals.unshift({ code: 'QA_FEEDBACK_INCORRECT', label: 'A reviewer reported an incorrect finding', points: 50, severity: 'critical' });
    }
    return {
      ...audit,
      qa_feedback: auditFeedback,
      qa_priority_signals: signals,
      qa_priority: Math.min(signals.reduce((total, signal) => total + signal.points, 0), 100)
    };
  });
}

class InMemoryAuditQueue {
  private readonly pending: AuditQueueJob[] = [];
  private readonly active = new Set<string>();
  private readonly activeDomains = new Set<string>();
  private readonly domainCooldowns = new Map<string, { until: number; reason: string }>();
  private drainTimer: NodeJS.Timeout | null = null;

  add(job: AuditQueueJob) {
    if (!shouldEnqueueAudit(this.has(job.audit_id))) return;
    const jitterMax = job.is_bulk ? boundedInteger(process.env.BULK_DOMAIN_JITTER_MS, 2_500, 0, 30_000) : 0;
    this.pending.push({ ...job, available_at: Date.now() + (jitterMax ? Math.floor(Math.random() * jitterMax) : 0) });
    this.drain();
  }

  has(id: string | number) {
    const key = String(id);
    return this.active.has(key) || this.pending.some((job) => String(job.audit_id) === key);
  }

  stats() {
    this.expireCooldowns();
    const now = Date.now();
    return {
      implementation: 'in_memory_domain_aware',
      active: this.active.size,
      active_domains: this.activeDomains.size,
      pending: this.pending.length,
      delayed: this.pending.filter((job) => (job.available_at || 0) > now || (this.domainCooldowns.get(job.domain)?.until || 0) > now).length,
      concurrency: scanConcurrency,
      domain_circuits: [...this.domainCooldowns.entries()].map(([domain, value]) => ({
        domain,
        reason: value.reason,
        resumes_at: new Date(value.until).toISOString()
      }))
    };
  }

  private drain() {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.expireCooldowns();
    const now = Date.now();
    while (this.active.size < scanConcurrency && this.pending.length > 0) {
      const index = this.pending.findIndex((candidate) =>
        !this.activeDomains.has(candidate.domain) &&
        (candidate.available_at || 0) <= now &&
        (this.domainCooldowns.get(candidate.domain)?.until || 0) <= now
      );
      if (index < 0) break;
      const [job] = this.pending.splice(index, 1);
      this.active.add(String(job.audit_id));
      this.activeDomains.add(job.domain);
      void this.execute(job);
    }
    this.scheduleNextDrain();
  }

  private expireCooldowns() {
    const now = Date.now();
    for (const [domain, cooldown] of this.domainCooldowns) {
      if (cooldown.until <= now) this.domainCooldowns.delete(domain);
    }
  }

  private scheduleNextDrain() {
    if (!this.pending.length || this.active.size >= scanConcurrency) return;
    const now = Date.now();
    const nextAt = Math.min(...this.pending
      .filter((job) => !this.activeDomains.has(job.domain))
      .map((job) => Math.max(job.available_at || now, this.domainCooldowns.get(job.domain)?.until || now)));
    if (!Number.isFinite(nextAt)) return;
    this.drainTimer = setTimeout(() => this.drain(), Math.max(25, Math.min(nextAt - now, 60_000)));
    this.drainTimer.unref();
  }

  private applyDomainCircuit(audit: StorefrontAudit) {
    const domain = normalizeAuditDomain(audit.domain);
    if (!domain) return;
    let duration = 0;
    let reason = audit.error_category;
    if (audit.error_category === 'rate_limited') {
      const retryAfter = audit.evidence_bundle?.page.retry_after_ms || 0;
      duration = Math.max(retryAfter, boundedInteger(process.env.DOMAIN_RATE_LIMIT_COOLDOWN_MS, 300_000, 10_000, 3_600_000));
    } else if (audit.error_category === 'bot_protection') {
      duration = boundedInteger(process.env.DOMAIN_BOT_COOLDOWN_MS, 600_000, 10_000, 3_600_000);
    } else if (audit.error_category === 'access_blocked') {
      duration = boundedInteger(process.env.DOMAIN_ACCESS_COOLDOWN_MS, 120_000, 10_000, 3_600_000);
    }
    if (duration > 0) this.domainCooldowns.set(domain, { until: Date.now() + duration, reason });
    else if (audit.scan_status === 'completed' || audit.scan_status === 'partial') this.domainCooldowns.delete(domain);
  }

  private async execute(job: AuditQueueJob) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), scanTimeoutMs);
    try {
      const audit = await db.getAudit(job.audit_id);
      if (!audit || !audit.domain) throw new Error('Queued audit row is missing or invalid.');
      await runStorefrontAudit({
        audit_id: audit.audit_id,
        domain: audit.domain,
        tested_geos: audit.tested_geos,
        group_label: audit.group_label,
        enable_captcha_solving: job.enable_captcha_solving,
        is_bulk: job.is_bulk,
        scan_mode: job.scan_mode,
        selected_modules: job.selected_modules,
        abortSignal: controller.signal,
        onProxyMetric: (event) => db.recordProxyMetric(event)
      }, (updates) => db.updateAudit(audit.audit_id, updates).then(() => undefined));
      const completed = await db.getAudit(job.audit_id);
      if (completed) this.applyDomainCircuit(completed);
    } catch (error) {
      console.error(`[Queue] Audit ${job.audit_id} failed outside the standard runner finalizer:`, error);
      try {
        const current = await db.getAudit(job.audit_id);
        if (current && (current.scan_status === 'pending' || current.scan_status === 'scanning')) {
          const trace = parseStoredTrace(current.trace_steps);
          if (!trace.some((step) => step.step === 'scan_finalized')) {
            trace.push({ step: 'scan_failed', error_category: 'database_error', reason: 'Runner finalization or persistence failed', timestamp: new Date().toISOString() });
            trace.push({ step: 'scan_finalized', scan_status: 'failed', error_category: 'database_error', timestamp: new Date().toISOString() });
          }
          await db.updateAudit(job.audit_id, {
            scan_status: 'failed',
            scan_completed_at: new Date().toISOString(),
            error_category: 'database_error',
            terminal_runtime_phase: current.runtime_metrics?.failed_phase || current.runtime_metrics?.last_successful_phase || 'runner_finalization',
            terminal_reason_code: 'RUNNER_FINALIZATION_FAILED',
            overall_status: 'inconclusive',
            overall_confidence: 'low',
            trace_steps: JSON.stringify(trace)
          });
        }
      } catch (persistenceError) {
        console.error(`[Queue] Unable to persist terminal state for audit ${job.audit_id}:`, persistenceError);
      }
    } finally {
      clearTimeout(timeout);
      this.active.delete(String(job.audit_id));
      this.activeDomains.delete(job.domain);
      activeScansRegistry.cleanup(job.audit_id);
      this.drain();
    }
  }
}

const queue = new InMemoryAuditQueue();

function parseStoredTrace(value: string | null) {
  if (!value) return [] as Record<string, unknown>[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validGeo(value: unknown): value is 'USA' | 'EU' | 'UK' {
  return typeof value === 'string' && ['USA', 'EU', 'UK'].includes(value.toUpperCase());
}

function validMode(value: unknown): value is ScanMode {
  return value === 'normal' || value === 'diagnostic';
}

function requestedModules(value: unknown) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const selected = normalizeAuditModules(value);
  return selected ? selected : null;
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function internalAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const configured = process.env.INTERNAL_API_TOKEN;
  if (!configured) return next();
  const authorization = req.header('authorization');
  const received = authorization?.startsWith('Bearer ') ? authorization.slice(7) : req.header('x-internal-api-token');
  if (received !== configured) return res.status(401).json({ error: 'Internal API authentication required.' });
  next();
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

async function recoverStaleAudits() {
  const audits = await db.getRecoverableStaleAudits(staleScanMinutes, 5000);
  for (const audit of audits) {
    const trace = parseStoredTrace(audit.trace_steps);
    if (!isRecoverableStaleAudit(audit, queue.has(audit.audit_id), trace)) continue;
    trace.push({ step: 'stale_scan_recovered', reason: 'No active or queued worker exists after the emergency recovery threshold', timestamp: new Date().toISOString() });
    trace.push({ step: 'scan_finalized', scan_status: 'failed', error_category: 'unknown_error', timestamp: new Date().toISOString() });
    await db.recoverStaleAudit(audit.audit_id, {
      scan_status: 'failed',
      scan_completed_at: new Date().toISOString(),
      error_category: 'unknown_error',
      terminal_runtime_phase: audit.runtime_metrics?.failed_phase || audit.runtime_metrics?.last_successful_phase || 'stale_recovery',
      terminal_reason_code: 'STALE_SCAN_RECOVERED',
      overall_status: 'inconclusive',
      overall_confidence: 'low',
      consent_status: audit.consent_status || 'not_tested',
      product_payload_status: audit.product_payload_status || 'not_tested',
      server_side_status: audit.server_side_status || 'not_tested',
      ss_collection_type: audit.ss_collection_type || 'not_tested',
      failure_fingerprints: [...new Set([...(audit.failure_fingerprints || []), 'SCAN_FINALIZATION_MISSING'])],
      qa_priority: 100,
      trace_steps: JSON.stringify(trace)
    });
  }
}

function csvCell(value: unknown) {
  let normalized = value === undefined || value === null ? '' : Array.isArray(value) ? value.join('|') : String(value);
  if (/^[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replace(/"/g, '""')}"`;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', build: buildMetadata, queue: queue.stats() }));
app.use('/api/v1', internalAuth);

app.post('/api/v1/scan', asyncRoute(async (req, res) => {
  const domain = normalizeAuditDomain(req.body?.domain);
  const geo = String(req.body?.tested_geos || '').toUpperCase();
  const mode = req.body?.mode || 'normal';
  const selectedModules = requestedModules(req.body?.selected_modules);
  if (!domain) return res.status(400).json({ error: 'A valid storefront domain is required.' });
  if (!validGeo(geo)) return res.status(400).json({ error: 'tested_geos must be USA, EU, or UK.' });
  if (!validMode(mode)) return res.status(400).json({ error: 'mode must be normal or diagnostic.' });
  if (!selectedModules) return res.status(400).json({ error: 'selected_modules must be a non-empty array of supported modules.' });
  const groupLabel = req.body?.group_label ? String(req.body.group_label).slice(0, 120) : null;
  const audit = await db.createAudit(domain, geo, groupLabel, mode, selectedModules);
  queue.add(queueJobForAudit(audit, { enable_captcha_solving: req.body?.enable_captcha_solving === true, is_bulk: false }));
  res.status(202).json(audit);
}));

app.post('/api/v1/scan/bulk', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A CSV file is required.' });
  const geo = String(req.body?.tested_geos || '').toUpperCase();
  if (!validGeo(geo)) return res.status(400).json({ error: 'tested_geos must be USA, EU, or UK.' });
  const mode = req.body?.mode || 'normal';
  const selectedModules = requestedModules(req.body?.selected_modules);
  if (!validMode(mode)) return res.status(400).json({ error: 'mode must be normal or diagnostic.' });
  if (!selectedModules) return res.status(400).json({ error: 'selected_modules must be a non-empty array of supported modules.' });
  const lines = req.file.buffer.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'The CSV is empty.' });
  const first = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const domainColumn = first.findIndex((value) => value === 'domain' || value.includes('domain'));
  const start = domainColumn >= 0 ? 1 : 0;
  const column = domainColumn >= 0 ? domainColumn : 0;
  const domains = [...new Set(lines.slice(start).map((line) => normalizeAuditDomain(parseCsvLine(line)[column])).filter(Boolean))] as string[];
  if (!domains.length) return res.status(400).json({ error: 'No valid domains were found.' });
  if (domains.length > maxBatchDomains) {
    return res.status(413).json({ error: `Batch contains ${domains.length} unique domains; maximum is ${maxBatchDomains}.` });
  }
  const groupLabel = req.body?.group_label ? String(req.body.group_label).slice(0, 120) : null;
  const audits: StorefrontAudit[] = [];
  for (const domain of domains) {
    const audit = await db.createAudit(domain, geo, groupLabel, mode, selectedModules);
    audits.push(audit);
    queue.add(queueJobForAudit(audit, { enable_captcha_solving: false, is_bulk: true }));
  }
  res.status(202).json({ count: audits.length, duplicates_removed: lines.length - start - domains.length, audits });
}));

app.post('/api/v1/scans/bulk-rerun', asyncRoute(async (req, res) => {
  const ids: string[] | null = Array.isArray(req.body?.ids)
    ? [...new Set<string>(req.body.ids.map((id: unknown) => String(id)))].slice(0, 1000)
    : null;
  if (!ids?.length) return res.status(400).json({ error: 'ids must be a non-empty array.' });
  const created: StorefrontAudit[] = [];
  for (const id of ids) {
    const source = await db.getAudit(id);
    if (!source) continue;
    if (!source.tested_geos) continue;
    const rerun = rerunAuditOptions(source);
    const audit = await db.createAudit(rerun.domain, rerun.tested_geos, rerun.group_label, rerun.scan_mode, rerun.selected_modules);
    queue.add(queueJobForAudit(audit, { enable_captcha_solving: false, is_bulk: true }));
    created.push(audit);
  }
  if (!created.length) return res.status(404).json({ error: 'No selected audits could be re-run.' });
  res.status(202).json({ count: created.length, audits: created });
}));

app.post('/api/v1/scans/:id/diagnostic-rerun', asyncRoute(async (req, res) => {
  const source = await db.getAudit(req.params.id);
  if (!source) return res.status(404).json({ error: 'Audit not found.' });
  if (!source.tested_geos) return res.status(400).json({ error: 'Source audit has no valid geo.' });
  const rerun = rerunAuditOptions(source, 'diagnostic');
  const audit = await db.createAudit(rerun.domain, rerun.tested_geos, rerun.group_label, rerun.scan_mode, rerun.selected_modules);
  queue.add(queueJobForAudit(audit, { enable_captcha_solving: false, is_bulk: false }));
  res.status(202).json(audit);
}));

app.post('/api/v1/scans/:id/difficult-site-rerun', asyncRoute(async (req, res) => {
  const source = await db.getAudit(req.params.id);
  if (!source) return res.status(404).json({ error: 'Audit not found.' });
  if (!source.tested_geos) return res.status(400).json({ error: 'Source audit has no valid geo.' });
  const rerun = rerunAuditOptions(source, 'diagnostic');
  const audit = await db.createAudit(rerun.domain, rerun.tested_geos, rerun.group_label, rerun.scan_mode, rerun.selected_modules);
  queue.add(queueJobForAudit(audit, { enable_captcha_solving: true, is_bulk: false }));
  res.status(202).json({
    ...audit,
    escalation_enabled: process.env.BROWSERLESS_BQL_ESCALATION === 'true',
    authorized_access_enabled: Boolean(process.env.AUTHORIZED_SCAN_DOMAINS)
  });
}));

app.get('/api/v1/scans', asyncRoute(async (req, res) => {
  const limit = Number(req.query.limit || 1000);
  const [audits, feedback] = await Promise.all([db.getAllAudits(limit), db.getQaFeedback()]);
  res.json(auditsWithCurrentQa(audits, feedback));
}));

app.get('/api/v1/scans/:id', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  res.json(auditsWithCurrentQa([audit], audit.qa_feedback || [])[0]);
}));

app.post('/api/v1/scans/:id/cancel', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  if (!['pending', 'scanning'].includes(audit.scan_status)) return res.status(409).json({ error: 'Audit is already terminal.' });
  activeScansRegistry.abort(audit.audit_id);
  res.status(202).json({ accepted: true, audit_id: audit.audit_id });
}));

app.post('/api/v1/scans/delete', asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 1000) : null;
  if (!ids) return res.status(400).json({ error: 'ids must be an array.' });
  let deleted = 0;
  for (const id of ids) if (await db.deleteAudit(id)) deleted += 1;
  res.json({ deleted });
}));

app.get('/api/v1/audits/export', asyncRoute(async (req, res) => {
  const groupLabel = String(req.query.group_label || '');
  if (!groupLabel) return res.status(400).json({ error: 'group_label is required.' });
  const audits = await db.getAuditsByGroup(groupLabel);
  const headers: Array<keyof StorefrontAudit> = [
    'audit_id', 'domain', 'scan_started_at', 'scan_completed_at', 'scan_status', 'scan_mode', 'selected_modules', 'error_category', 'terminal_runtime_phase', 'terminal_reason_code',
    'tested_geos', 'cms_platform_detected', 'overall_status', 'overall_confidence', 'consent_status', 'cmp_provider',
    'site_ga4_detected', 'site_ga4_measurement_ids', 'site_ga4_collection_hit_detected', 'site_meta_detected',
    'site_meta_collection_hit_detected', 'product_payload_status', 'pdp_url_tested', 'server_side_status',
    'ss_collection_type', 'reason_codes', 'failure_fingerprints', 'qa_priority', 'group_label'
  ];
  const rows = audits.map((audit) => headers.map((header) => csvCell(audit[header])).join(','));
  res.type('text/csv');
  res.attachment(`audit_export_${groupLabel.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.csv`);
  res.send([headers.join(','), ...rows].join('\n'));
}));

app.get('/api/v1/scans/:id/debug-package', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  const files = buildDebugPackageFiles(audit);
  res.attachment(`upsight-debug-${audit.audit_id}.zip`);
  res.type('application/zip');
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (error) => {
    console.error('[DebugPackage] ZIP creation failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to create debug package.' });
    else res.destroy(error);
  });
  archive.pipe(res);
  for (const [name, content] of Object.entries(files)) archive.append(content, { name });
  await archive.finalize();
}));

app.post('/api/v1/scans/:id/qa-feedback', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  const categories: QaFeedback['category'][] = ['CMP', 'Consent', 'GA4', 'Meta', 'view_item', 'PDP discovery', 'server-side', 'CMS', 'bot/access', 'other'];
  const verdict = req.body?.verdict;
  const category = req.body?.category;
  if (!['correct', 'incorrect'].includes(verdict) || !categories.includes(category)) {
    return res.status(400).json({ error: 'A valid verdict and category are required.' });
  }
  const feedback = await db.addQaFeedback({
    audit_id: String(audit.audit_id),
    verdict,
    category,
    expected_value: req.body?.expected_value === undefined ? null : String(req.body.expected_value).slice(0, 500),
    notes: req.body?.notes === undefined ? null : String(req.body.notes).slice(0, 2000)
  });
  res.status(201).json(feedback);
}));

app.post('/api/v1/scans/:id/mark-correct', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  if (['pending', 'scanning'].includes(audit.scan_status)) {
    return res.status(409).json({ error: 'An active audit cannot be marked correct.' });
  }
  if (audit.qa_review_status === 'correct') return res.json(audit);
  const reviewed = await db.updateAudit(audit.audit_id, {
    qa_review_status: 'correct',
    qa_reviewed_at: new Date().toISOString(),
    qa_priority: 0
  });
  res.json(reviewed);
}));

app.get('/api/v1/quality/metrics', asyncRoute(async (_req, res) => {
  const [audits, feedback] = await Promise.all([db.getAllAudits(5000), db.getQaFeedback()]);
  res.json(buildQualityMetrics(auditsWithCurrentQa(audits, feedback), feedback));
}));

app.get('/api/v1/quality/review-candidates', asyncRoute(async (req, res) => {
  const [audits, feedback] = await Promise.all([db.getAllAudits(5000), db.getQaFeedback()]);
  res.json(buildLatestReviewQueue(auditsWithCurrentQa(audits, feedback), feedback, Number(req.query.limit || 100)));
}));

app.post('/api/v1/scans/:id/review', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  if (!audit.evidence_bundle) return res.status(409).json({ error: 'This audit predates normalized evidence capture.' });
  res.json(reviewAudit({ audit, trace: audit.trace_steps || '[]', evidence: audit.evidence_bundle }));
}));

app.post('/api/v1/scans/:id/replay', asyncRoute(async (req, res) => {
  const audit = await db.getAudit(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found.' });
  if (!audit.evidence_bundle) return res.status(409).json({ error: 'This audit has no replayable evidence bundle.' });
  const replayed = replayEvidence(audit.evidence_bundle);
  res.json({ audit_id: audit.audit_id, replayed, comparison: compareReplay(audit, replayed) });
}));

app.post('/api/v1/replay', asyncRoute(async (req, res) => {
  const bundles = Array.isArray(req.body?.evidence) ? req.body.evidence : [req.body?.evidence];
  if (!bundles[0]) return res.status(400).json({ error: 'evidence is required.' });
  if (bundles.length > 5000) return res.status(413).json({ error: 'At most 5000 evidence bundles may be replayed per request.' });
  const results = bundles.map((bundle: EvidenceBundle) => replayEvidence(bundle));
  res.json({ audits_replayed: results.length, results });
}));

app.get('/api/v1/scanner/proxy-metrics', asyncRoute(async (_req, res) => {
  res.json({ live: getProxyMetricsReport(), persistent: await db.getProxyHealth() });
}));
app.get('/api/v1/scanner/access-readiness', (_req, res) => res.json({
  browser_provider: process.env.BROWSER_PROVIDER || 'browserless',
  browserless_host: process.env.BROWSERLESS_HOST || 'chrome.browserless.io',
  browserless_route: process.env.BROWSERLESS_ROUTE === 'standard' ? 'standard' : 'stealth',
  proxy_mode: process.env.BROWSERLESS_PROXY_MODE || 'decodo',
  bql_escalation_enabled: process.env.BROWSERLESS_BQL_ESCALATION === 'true',
  egress_probe_enabled: process.env.PROXY_EGRESS_PROBE === 'true',
  proxy_configuration_issues: validateProxyConfiguration(bulkProxyRetryLimit())
}));
app.get('/api/v1/queue', (_req, res) => res.json(queue.stats()));

async function startServer() {
  await db.initialize();
  hydrateProxyHealth(await db.getProxyHealth());
  const proxyIssues = validateProxyConfiguration(bulkProxyRetryLimit());
  if (proxyIssues.length) console.warn('[Proxy] Configuration readiness issues:', proxyIssues);
  await recoverStaleAudits();
  setInterval(() => void recoverStaleAudits().catch((error) => console.error('[Recovery] Failed:', error)), 60_000).unref();
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `CSV exceeds the ${maxCsvBytes}-byte limit.` });
    }
    console.error('[API] Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error.' });
  });
  app.listen(port, '0.0.0.0', () => console.log(`[Server] Upsight Tracking Scanner V2 listening on http://0.0.0.0:${port}`));
}

startServer().catch((error) => {
  console.error('[Server] Bootstrap failed:', error);
  process.exitCode = 1;
});
