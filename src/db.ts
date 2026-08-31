import pg from 'pg';
import type { AuditModule, AuditQueueOptions, QaFeedback, ScanMode, StorefrontAudit } from './types';
import { selectedAuditModules } from './audit-modules';
import { normalizeQueueOptions } from './audit-lifecycle';
import { boundedInteger } from './shared/config';
import type { ProxyMetricEvent } from './scanner/proxy/decodo';

const AUDIT_COLUMNS = new Set([
  'domain', 'group_label', 'scan_started_at', 'scan_completed_at', 'scan_status', 'scan_mode', 'selected_modules', 'queue_options',
  'error_category', 'terminal_runtime_phase', 'terminal_reason_code', 'tested_geos', 'cms_platform_detected', 'overall_status', 'overall_confidence',
  'consent_status', 'cmp_provider', 'product_payload_status', 'pdp_url_tested', 'server_side_status',
  'ss_collection_type', 'trace_steps', 'site_ga4_detected', 'site_ga4_measurement_ids',
  'site_ga4_collection_hit_detected', 'site_google_ads_detected', 'site_meta_detected',
  'site_meta_collection_hit_detected', 'evidence_bundle', 'finding_confidence', 'reason_codes',
  'failure_fingerprints', 'consistency_violations', 'qa_priority', 'qa_review_status', 'qa_reviewed_at', 'runtime_metrics'
]);

export class AuditDatabase {
  private pool: pg.Pool | null = null;
  private readonly memoryEnabled = process.env.USE_MEMORY_DB === 'true';
  private readonly memoryDb: StorefrontAudit[] = [];
  private readonly memoryFeedback: QaFeedback[] = [];
  private readonly memoryProxyHealth = new Map<string, Record<string, any>>();
  private nextMemoryId = 1;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const host = process.env.DB_HOST;
    const database = process.env.DB_NAME;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const port = boundedInteger(process.env.DB_PORT, 5432, 1, 65_535);
    if (connectionString || (host && database && user)) {
      this.pool = new pg.Pool({
        ...(connectionString ? { connectionString } : { host, database, user, password, port }),
        ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 5_000,
        max: boundedInteger(process.env.DB_POOL_MAX, 5, 1, 50)
      });
      this.pool.on('error', (error) => console.error('[Database] Idle PostgreSQL client error:', error));
    }
  }

  async initialize() {
    if (!this.pool) {
      if (this.memoryEnabled) {
        console.warn('[Database] Explicit USE_MEMORY_DB=true; audit data is process-local and non-persistent.');
        return;
      }
      throw new Error('Database configuration is missing. Set DATABASE_URL (recommended for Supabase) or DB_HOST, DB_NAME, and DB_USER; alternatively set USE_MEMORY_DB=true for local development.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      await client.query(`
        CREATE TABLE IF NOT EXISTS storefront_audits_v2 (
          audit_id SERIAL PRIMARY KEY,
          domain VARCHAR(255) NOT NULL,
          group_label VARCHAR(255) NULL,
          scan_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          scan_completed_at TIMESTAMPTZ NULL,
          scan_status VARCHAR(50) NOT NULL DEFAULT 'pending',
          scan_mode VARCHAR(20) NOT NULL DEFAULT 'normal',
          selected_modules TEXT[] NOT NULL DEFAULT ARRAY['consent', 'tracking', 'server_side'],
          queue_options JSONB NOT NULL DEFAULT '{"is_bulk":false,"enable_captcha_solving":false,"proxy_provider":"decodo"}'::jsonb,
          error_category VARCHAR(100) NOT NULL DEFAULT 'none',
          terminal_runtime_phase VARCHAR(100) NULL,
          terminal_reason_code VARCHAR(100) NULL,
          tested_geos VARCHAR(50) NULL,
          cms_platform_detected VARCHAR(100) NOT NULL DEFAULT 'Unknown',
          overall_status VARCHAR(50) NULL,
          overall_confidence VARCHAR(50) NULL,
          consent_status VARCHAR(100) NULL,
          cmp_provider VARCHAR(100) NULL,
          product_payload_status VARCHAR(100) NULL,
          pdp_url_tested TEXT NULL,
          server_side_status VARCHAR(100) NULL,
          ss_collection_type VARCHAR(100) NULL,
          trace_steps TEXT NULL,
          site_ga4_detected BOOLEAN NULL,
          site_ga4_measurement_ids TEXT[] NULL,
          site_ga4_collection_hit_detected BOOLEAN NULL,
          site_google_ads_detected BOOLEAN NULL,
          site_meta_detected BOOLEAN NULL,
          site_meta_collection_hit_detected BOOLEAN NULL,
          evidence_bundle JSONB NULL,
          finding_confidence JSONB NULL,
          reason_codes TEXT[] NULL,
          failure_fingerprints TEXT[] NULL,
          consistency_violations TEXT[] NULL,
          qa_priority INTEGER NOT NULL DEFAULT 0,
          qa_review_status VARCHAR(20) NULL,
          qa_reviewed_at TIMESTAMPTZ NULL,
          runtime_metrics JSONB NULL
        )
      `);
      await client.query(`
        DO $migration$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'storefront_audits_v2'
              AND column_name = 'scan_started_at'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE storefront_audits_v2
              ALTER COLUMN scan_started_at TYPE TIMESTAMPTZ
              USING scan_started_at AT TIME ZONE current_setting('TimeZone');
          END IF;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'storefront_audits_v2'
              AND column_name = 'scan_completed_at'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE storefront_audits_v2
              ALTER COLUMN scan_completed_at TYPE TIMESTAMPTZ
              USING scan_completed_at AT TIME ZONE current_setting('TimeZone');
          END IF;
        END
        $migration$;
      `);
      await client.query(`
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS scan_mode VARCHAR(20) NOT NULL DEFAULT 'normal';
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS selected_modules TEXT[] NOT NULL DEFAULT ARRAY['consent', 'tracking', 'server_side'];
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS queue_options JSONB NOT NULL DEFAULT '{"is_bulk":false,"enable_captcha_solving":false,"proxy_provider":"decodo"}'::jsonb;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS terminal_runtime_phase VARCHAR(100) NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS terminal_reason_code VARCHAR(100) NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS site_ga4_detected BOOLEAN NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS site_ga4_measurement_ids TEXT[] NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS site_ga4_collection_hit_detected BOOLEAN NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS site_google_ads_detected BOOLEAN NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS site_meta_detected BOOLEAN NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS site_meta_collection_hit_detected BOOLEAN NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS evidence_bundle JSONB NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS finding_confidence JSONB NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS reason_codes TEXT[] NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS failure_fingerprints TEXT[] NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS consistency_violations TEXT[] NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS qa_priority INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS qa_review_status VARCHAR(20) NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS qa_reviewed_at TIMESTAMPTZ NULL;
        ALTER TABLE storefront_audits_v2 ADD COLUMN IF NOT EXISTS runtime_metrics JSONB NULL
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_qa_feedback (
          feedback_id BIGSERIAL PRIMARY KEY,
          audit_id INTEGER NOT NULL REFERENCES storefront_audits_v2(audit_id) ON DELETE CASCADE,
          verdict VARCHAR(20) NOT NULL,
          category VARCHAR(50) NOT NULL,
          expected_value TEXT NULL,
          notes TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        DO $migration$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'audit_qa_feedback'
              AND column_name = 'created_at'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE audit_qa_feedback
              ALTER COLUMN created_at TYPE TIMESTAMPTZ
              USING created_at AT TIME ZONE current_setting('TimeZone');
          END IF;
        END
        $migration$;
      `);
      await client.query('CREATE INDEX IF NOT EXISTS storefront_audits_v2_qa_priority_idx ON storefront_audits_v2 (qa_priority DESC, scan_started_at DESC)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS scanner_proxy_health (
          geo VARCHAR(10) NOT NULL,
          port INTEGER NOT NULL,
          connects BIGINT NOT NULL DEFAULT 0,
          errors BIGINT NOT NULL DEFAULT 0,
          retries BIGINT NOT NULL DEFAULT 0,
          retry_successes BIGINT NOT NULL DEFAULT 0,
          storefront_successes BIGINT NOT NULL DEFAULT 0,
          total_connect_ms BIGINT NOT NULL DEFAULT 0,
          consecutive_errors INTEGER NOT NULL DEFAULT 0,
          quarantined_until TIMESTAMPTZ NULL,
          last_success_at TIMESTAMPTZ NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (geo, port)
        )
      `);
    } finally {
      client.release();
    }
  }

  private useMemory() {
    return !this.pool && this.memoryEnabled;
  }

  async createAudit(
    domain: string,
    testedGeos: string | null = null,
    groupLabel: string | null = null,
    scanMode: ScanMode = 'normal',
    selectedModules?: AuditModule[],
    queueOptions?: Partial<AuditQueueOptions>
  ): Promise<StorefrontAudit> {
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO storefront_audits_v2
          (domain, group_label, scan_started_at, scan_status, scan_mode, selected_modules, queue_options, error_category, tested_geos, cms_platform_detected, trace_steps)
         VALUES ($1, $2, NOW(), 'pending', $3, $4, $5, 'none', $6, 'Unknown', '[]')
         RETURNING *`,
        [domain, groupLabel, scanMode, selectedAuditModules(selectedModules), normalizeQueueOptions(queueOptions), testedGeos]
      );
      return result.rows[0];
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const audit: StorefrontAudit = {
      audit_id: this.nextMemoryId++,
      domain,
      group_label: groupLabel,
      scan_started_at: new Date().toISOString(),
      scan_completed_at: null,
      scan_status: 'pending',
      scan_mode: scanMode,
      selected_modules: selectedAuditModules(selectedModules),
      queue_options: normalizeQueueOptions(queueOptions),
      error_category: 'none',
      tested_geos: testedGeos as StorefrontAudit['tested_geos'],
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
      qa_priority: 0,
      qa_review_status: null,
      qa_reviewed_at: null
    };
    this.memoryDb.unshift(audit);
    return audit;
  }

  async updateAudit(id: string | number, updates: Partial<StorefrontAudit>): Promise<StorefrontAudit | null> {
    const entries = Object.entries(updates).filter(([key]) => AUDIT_COLUMNS.has(key));
    if (!entries.length) return this.getAudit(id);
    if (this.pool) {
      const setClause = entries.map(([key], index) => `"${key}" = $${index + 2}`).join(', ');
      const result = await this.pool.query(
        `UPDATE storefront_audits_v2 SET ${setClause} WHERE audit_id = $1 RETURNING *`,
        [id, ...entries.map(([, value]) => value)]
      );
      return result.rows[0] || null;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const index = this.memoryDb.findIndex((audit) => String(audit.audit_id) === String(id));
    if (index < 0) return null;
    this.memoryDb[index] = { ...this.memoryDb[index], ...Object.fromEntries(entries) };
    return this.memoryDb[index];
  }

  async recoverStaleAudit(id: string | number, updates: Partial<StorefrontAudit>): Promise<StorefrontAudit | null> {
    const entries = Object.entries(updates).filter(([key]) => AUDIT_COLUMNS.has(key));
    if (!entries.length) return this.getAudit(id);
    if (this.pool) {
      const setClause = entries.map(([key], index) => `"${key}" = $${index + 2}`).join(', ');
      const result = await this.pool.query(
        `UPDATE storefront_audits_v2 SET ${setClause}
         WHERE audit_id = $1 AND scan_status = ANY($${entries.length + 2}::TEXT[])
         RETURNING *`,
        [id, ...entries.map(([, value]) => value), ['pending', 'scanning']]
      );
      return result.rows[0] || null;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const index = this.memoryDb.findIndex((audit) => String(audit.audit_id) === String(id));
    if (index < 0 || !['pending', 'scanning'].includes(this.memoryDb[index].scan_status)) return null;
    this.memoryDb[index] = { ...this.memoryDb[index], ...Object.fromEntries(entries) };
    return this.memoryDb[index];
  }

  async claimPendingAudit(id: string | number): Promise<StorefrontAudit | null> {
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE storefront_audits_v2 SET scan_status = 'scanning', scan_started_at = NOW() WHERE audit_id = $1 AND scan_status = 'pending' RETURNING *`,
        [id]
      );
      return result.rows[0] || null;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const audit = this.memoryDb.find((candidate) => String(candidate.audit_id) === String(id));
    if (!audit || audit.scan_status !== 'pending') return null;
    audit.scan_status = 'scanning';
    audit.scan_started_at = new Date().toISOString();
    return audit;
  }

  async requeueStaleAudit(id: string | number, traceSteps: string): Promise<StorefrontAudit | null> {
    const updates = { scan_status: 'pending' as const, scan_started_at: new Date().toISOString(), scan_completed_at: null, trace_steps: traceSteps };
    if (this.pool) {
      const result = await this.pool.query(
        `UPDATE storefront_audits_v2
         SET scan_status = $2, scan_started_at = $3, scan_completed_at = $4, trace_steps = $5
         WHERE audit_id = $1 AND scan_status = 'scanning'
         RETURNING *`,
        [id, updates.scan_status, updates.scan_started_at, updates.scan_completed_at, updates.trace_steps]
      );
      return result.rows[0] || null;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const audit = this.memoryDb.find((candidate) => String(candidate.audit_id) === String(id));
    if (!audit || audit.scan_status !== 'scanning') return null;
    Object.assign(audit, updates);
    return audit;
  }

  async getAudit(id: string | number): Promise<StorefrontAudit | null> {
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM storefront_audits_v2 WHERE audit_id = $1', [id]);
      if (!result.rows[0]) return null;
      result.rows[0].qa_feedback = await this.getQaFeedback(id);
      return result.rows[0];
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const audit = this.memoryDb.find((candidate) => String(candidate.audit_id) === String(id));
    return audit ? { ...audit, qa_feedback: await this.getQaFeedback(id) } : null;
  }

  async getAllAudits(limit = boundedInteger(process.env.AUDIT_LIST_LIMIT, 1000, 1, 5000)): Promise<StorefrontAudit[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 5000));
    if (this.pool) {
      const result = await this.pool.query(
        'SELECT * FROM storefront_audits_v2 ORDER BY scan_started_at DESC LIMIT $1',
        [boundedLimit]
      );
      return result.rows;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    return this.memoryDb.slice(0, boundedLimit);
  }

  async getRecoverableStaleAudits(staleMinutes: number, limit = 5000): Promise<StorefrontAudit[]> {
    const boundedMinutes = Math.max(3, Math.min(Math.trunc(staleMinutes), 1_440));
    const boundedLimit = Math.max(1, Math.min(limit, 5_000));
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM storefront_audits_v2
         WHERE scan_status = 'scanning'
           AND scan_started_at < NOW() - make_interval(mins => $1)
         ORDER BY scan_started_at ASC
         LIMIT $2`,
        [boundedMinutes, boundedLimit]
      );
      return result.rows;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const cutoff = Date.now() - boundedMinutes * 60_000;
    return this.memoryDb.filter((audit) =>
      audit.scan_status === 'scanning' && new Date(audit.scan_started_at).getTime() < cutoff
    ).slice(0, boundedLimit);
  }

  async getPendingAudits(limit = 5000): Promise<StorefrontAudit[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 5_000));
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM storefront_audits_v2 WHERE scan_status = 'pending' ORDER BY scan_started_at ASC LIMIT $1`,
        [boundedLimit]
      );
      return result.rows;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    return this.memoryDb.filter((audit) => audit.scan_status === 'pending').slice(0, boundedLimit);
  }

  async getAuditsByGroup(groupLabel: string): Promise<StorefrontAudit[]> {
    if (this.pool) {
      const result = await this.pool.query(
        'SELECT * FROM storefront_audits_v2 WHERE group_label = $1 ORDER BY scan_started_at DESC LIMIT 5000',
        [groupLabel]
      );
      return result.rows;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    return this.memoryDb.filter((audit) => audit.group_label === groupLabel);
  }

  async getReviewCandidates(limit = 100): Promise<StorefrontAudit[]> {
    const bounded = Math.max(1, Math.min(limit, 500));
    if (this.pool) {
      const result = await this.pool.query(
        `SELECT * FROM storefront_audits_v2
         WHERE qa_priority > 0 OR overall_confidence = 'low' OR cardinality(COALESCE(consistency_violations, ARRAY[]::TEXT[])) > 0
         ORDER BY qa_priority DESC, scan_started_at DESC LIMIT $1`,
        [bounded]
      );
      return result.rows;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    return this.memoryDb.filter((audit) => (audit.qa_priority || 0) > 0 || audit.overall_confidence === 'low')
      .sort((a, b) => (b.qa_priority || 0) - (a.qa_priority || 0)).slice(0, bounded);
  }

  async addQaFeedback(feedback: Omit<QaFeedback, 'created_at'>): Promise<QaFeedback> {
    const createdAt = new Date().toISOString();
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO audit_qa_feedback (audit_id, verdict, category, expected_value, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING audit_id, verdict, category, expected_value, notes, created_at`,
        [feedback.audit_id, feedback.verdict, feedback.category, feedback.expected_value, feedback.notes, createdAt]
      );
      return { ...result.rows[0], audit_id: String(result.rows[0].audit_id) };
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const stored = { ...feedback, created_at: createdAt };
    this.memoryFeedback.push(stored);
    return stored;
  }

  async getQaFeedback(id?: string | number): Promise<QaFeedback[]> {
    if (this.pool) {
      const result = id === undefined
        ? await this.pool.query('SELECT audit_id, verdict, category, expected_value, notes, created_at FROM audit_qa_feedback ORDER BY created_at DESC')
        : await this.pool.query('SELECT audit_id, verdict, category, expected_value, notes, created_at FROM audit_qa_feedback WHERE audit_id = $1 ORDER BY created_at DESC', [id]);
      return result.rows.map((row) => ({ ...row, audit_id: String(row.audit_id) }));
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    return id === undefined ? [...this.memoryFeedback] : this.memoryFeedback.filter((item) => String(item.audit_id) === String(id));
  }

  async deleteAudit(id: string | number) {
    if (this.pool) {
      const result = await this.pool.query('DELETE FROM storefront_audits_v2 WHERE audit_id = $1', [id]);
      return (result.rowCount || 0) > 0;
    }
    if (!this.useMemory()) throw new Error('Database is unavailable and memory storage is not enabled.');
    const index = this.memoryDb.findIndex((audit) => String(audit.audit_id) === String(id));
    if (index < 0) return false;
    this.memoryDb.splice(index, 1);
    return true;
  }

  async recordProxyMetric(event: ProxyMetricEvent) {
    if (event.port === null || !Number.isInteger(event.port)) return;
    const threshold = boundedInteger(process.env.PROXY_PORT_ERROR_THRESHOLD, 3, 2, 20);
    const quarantineMs = boundedInteger(process.env.PROXY_PORT_QUARANTINE_MS, 600_000, 30_000, 86_400_000);
    const increments = {
      connects: event.kind === 'connect' ? 1 : 0,
      errors: event.kind === 'error' ? 1 : 0,
      retries: event.kind === 'retry' ? 1 : 0,
      retry_successes: event.kind === 'retry_success' ? 1 : 0,
      storefront_successes: event.kind === 'storefront_success' ? 1 : 0,
      total_connect_ms: event.kind === 'connect' ? Math.max(0, Math.round(event.duration_ms || 0)) : 0
    };
    if (this.pool) {
      await this.pool.query(`
        INSERT INTO scanner_proxy_health
          (geo, port, connects, errors, retries, retry_successes, storefront_successes, total_connect_ms,
           consecutive_errors, quarantined_until, last_success_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
          CASE WHEN $4::BIGINT > 0 THEN 1 ELSE 0 END,
          CASE WHEN $4::BIGINT > 0 AND $9 <= 1 THEN NOW() + ($10 * INTERVAL '1 millisecond') ELSE NULL END,
          CASE WHEN $7::BIGINT > 0 THEN NOW() ELSE NULL END,
          NOW())
        ON CONFLICT (geo, port) DO UPDATE SET
          connects = scanner_proxy_health.connects + EXCLUDED.connects,
          errors = scanner_proxy_health.errors + EXCLUDED.errors,
          retries = scanner_proxy_health.retries + EXCLUDED.retries,
          retry_successes = scanner_proxy_health.retry_successes + EXCLUDED.retry_successes,
          storefront_successes = scanner_proxy_health.storefront_successes + EXCLUDED.storefront_successes,
          total_connect_ms = scanner_proxy_health.total_connect_ms + EXCLUDED.total_connect_ms,
          consecutive_errors = CASE
            WHEN $7::BIGINT > 0 THEN 0
            WHEN $4::BIGINT > 0 THEN scanner_proxy_health.consecutive_errors + 1
            ELSE scanner_proxy_health.consecutive_errors
          END,
          quarantined_until = CASE
            WHEN $7::BIGINT > 0 THEN NULL
            WHEN $4::BIGINT > 0 AND scanner_proxy_health.consecutive_errors + 1 >= $9
              THEN NOW() + ($10 * INTERVAL '1 millisecond')
            ELSE scanner_proxy_health.quarantined_until
          END,
          last_success_at = CASE WHEN $7::BIGINT > 0 THEN NOW() ELSE scanner_proxy_health.last_success_at END,
          updated_at = NOW()
      `, [event.geo.toUpperCase(), event.port, increments.connects, increments.errors, increments.retries,
        increments.retry_successes, increments.storefront_successes, increments.total_connect_ms, threshold, quarantineMs]);
      return;
    }
    if (!this.useMemory()) return;
    const key = `${event.geo.toUpperCase()}:${event.port}`;
    const row = this.memoryProxyHealth.get(key) || {
      geo: event.geo.toUpperCase(), port: event.port, connects: 0, errors: 0, retries: 0,
      retry_successes: 0, storefront_successes: 0, total_connect_ms: 0, consecutive_errors: 0,
      quarantined_until: null, last_success_at: null, updated_at: new Date().toISOString()
    };
    for (const [field, increment] of Object.entries(increments)) row[field] += increment;
    if (event.kind === 'error') {
      row.consecutive_errors += 1;
      if (row.consecutive_errors >= threshold) row.quarantined_until = new Date(Date.now() + quarantineMs).toISOString();
    }
    if (event.kind === 'storefront_success') {
      row.consecutive_errors = 0;
      row.quarantined_until = null;
      row.last_success_at = new Date().toISOString();
    }
    row.updated_at = new Date().toISOString();
    this.memoryProxyHealth.set(key, row);
  }

  async getProxyHealth() {
    const rows = this.pool
      ? (await this.pool.query('SELECT * FROM scanner_proxy_health ORDER BY geo, port')).rows
      : [...this.memoryProxyHealth.values()];
    return rows.map((row) => ({
      ...row,
      error_rate: Number(row.connects) ? Number(row.errors) / Number(row.connects) : 0,
      retry_recovery_rate: Number(row.retries) ? Number(row.retry_successes) / Number(row.retries) : 0,
      average_connect_ms: Number(row.connects) ? Number(row.total_connect_ms) / Number(row.connects) : null,
      quarantined: row.quarantined_until ? new Date(row.quarantined_until).getTime() > Date.now() : false
    }));
  }
}
