import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Audit = {
  audit_id: string | number;
  domain: string;
  scan_status: string;
  error_category: string;
  evidence_bundle?: {
    page?: { valid?: boolean | null; challenge_cleared?: boolean };
    runtime?: {
      total_duration_ms?: number | null;
      browserless_host?: string | null;
      proxy_retry_count?: number;
      proxy_retry_recovered?: boolean;
    };
  } | null;
};

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizeDomain(input: string) {
  const value = input.trim().replace(/^"|"$/g, '');
  if (!value || value.toLowerCase() === 'domain') return null;
  try {
    const hostname = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
    return hostname.includes('.') ? hostname : null;
  } catch {
    return null;
  }
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith('--')) {
  throw new Error('Usage: npm run benchmark:access -- <domains.csv> [--geo USA|UK|EU] [--output report.json]');
}
const geo = String(argument('--geo') || 'USA').toUpperCase();
if (!['USA', 'UK', 'EU'].includes(geo)) throw new Error('--geo must be USA, UK, or EU');
const baseUrl = String(argument('--api') || process.env.SCANNER_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.INTERNAL_API_TOKEN || '';
const limit = Math.max(1, Math.min(Number(process.env.ACCESS_BENCHMARK_LIMIT || 200), 500));
const pollMs = Math.max(1_000, Math.min(Number(process.env.ACCESS_BENCHMARK_POLL_MS || 3_000), 30_000));
const maxWaitMs = Math.max(60_000, Math.min(Number(process.env.ACCESS_BENCHMARK_TIMEOUT_MS || 1_800_000), 7_200_000));
const headers: Record<string, string> = { 'content-type': 'application/json' };
if (token) headers.authorization = `Bearer ${token}`;

const lines = readFileSync(path.resolve(inputPath), 'utf8').split(/\r?\n/);
const domains = [...new Set(lines.map((line) => normalizeDomain(line.split(',')[0] || '')).filter(Boolean))].slice(0, limit) as string[];
if (!domains.length) throw new Error('No valid domains were found in the first CSV column');

const groupLabel = `access-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const submitted: Array<{ id: string | number; domain: string }> = [];
for (const domain of domains) {
  const response = await fetch(`${baseUrl}/api/v1/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ domain, tested_geos: geo, mode: 'diagnostic', group_label: groupLabel })
  });
  if (!response.ok) throw new Error(`Unable to submit ${domain}: HTTP ${response.status}`);
  const audit = await response.json() as Audit;
  submitted.push({ id: audit.audit_id, domain });
}

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const results = new Map<string, Audit>();
const startedAt = Date.now();
while (results.size < submitted.length && Date.now() - startedAt < maxWaitMs) {
  for (const item of submitted) {
    if (results.has(String(item.id))) continue;
    const response = await fetch(`${baseUrl}/api/v1/scans/${item.id}`, { headers });
    if (!response.ok) continue;
    const audit = await response.json() as Audit;
    if (terminal.has(audit.scan_status)) results.set(String(item.id), audit);
  }
  if (results.size < submitted.length) await new Promise((resolve) => setTimeout(resolve, pollMs));
}

const audits = [...results.values()];
const categories = Object.fromEntries([...new Set(audits.map((audit) => audit.error_category))]
  .map((category) => [category, audits.filter((audit) => audit.error_category === category).length]));
const durations = audits.map((audit) => audit.evidence_bundle?.runtime?.total_duration_ms).filter(Number.isFinite) as number[];
const valid = audits.filter((audit) => audit.evidence_bundle?.page?.valid === true).length;
const retries = audits.filter((audit) => (audit.evidence_bundle?.runtime?.proxy_retry_count || 0) > 0).length;
const recovered = audits.filter((audit) => audit.evidence_bundle?.runtime?.proxy_retry_recovered).length;
const report = {
  generated_at: new Date().toISOString(),
  group_label: groupLabel,
  scanner_api: baseUrl,
  geo,
  browserless_hosts: [...new Set(audits.map((audit) => audit.evidence_bundle?.runtime?.browserless_host).filter(Boolean))],
  submitted: submitted.length,
  completed_within_budget: audits.length,
  valid_storefronts: valid,
  valid_storefront_rate: audits.length ? valid / audits.length : 0,
  error_categories: categories,
  challenge_clear_count: audits.filter((audit) => audit.evidence_bundle?.page?.challenge_cleared).length,
  proxy_retry_count: retries,
  proxy_retry_recovery_rate: retries ? recovered / retries : 0,
  average_duration_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
  p95_duration_ms: percentile(durations, 0.95),
  unfinished_ids: submitted.filter((item) => !results.has(String(item.id))).map((item) => item.id),
  audits: submitted.map((item) => {
    const audit = results.get(String(item.id));
    return {
      audit_id: item.id,
      domain: item.domain,
      scan_status: audit?.scan_status || 'unfinished',
      error_category: audit?.error_category || null,
      page_valid: audit?.evidence_bundle?.page?.valid ?? null,
      proxy_retries: audit?.evidence_bundle?.runtime?.proxy_retry_count ?? null,
      retry_recovered: audit?.evidence_bundle?.runtime?.proxy_retry_recovered ?? null,
      duration_ms: audit?.evidence_bundle?.runtime?.total_duration_ms ?? null
    };
  })
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = argument('--output');
if (output) writeFileSync(path.resolve(output), serialized, 'utf8');
process.stdout.write(serialized);
