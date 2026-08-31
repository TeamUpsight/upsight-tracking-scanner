import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, Gauge, Network, ShieldAlert } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { formatLabel, websiteUrl } from './format';

type Counts = Record<string, number>;

export function formatPercent(value: unknown) {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—';
}

export function formatDuration(value: unknown) {
  if (typeof value !== 'number') return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

export function MetricCard({ label, value, helper, tone = 'default' }: {
  label: string;
  value: string | number;
  helper?: string;
  tone?: 'default' | 'good' | 'warning' | 'danger';
}) {
  const tones = {
    default: 'from-slate-500/10 to-transparent',
    good: 'from-emerald-500/15 to-transparent',
    warning: 'from-amber-500/15 to-transparent',
    danger: 'from-rose-500/15 to-transparent'
  };
  return (
    <article className={`rounded-xl border border-neutral-border bg-gradient-to-br ${tones[tone]} p-3.5 shadow-sm`}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">{label}</div>
      <div className="mt-1.5 text-xl font-bold tracking-tight text-white">{value}</div>
      {helper && <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{helper}</p>}
    </article>
  );
}

function entries(counts: Counts = {}, omitZero = true) {
  return Object.entries(counts)
    .filter(([, count]) => !omitZero || Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
}

export function BarList({ data, maxItems = 8, empty = 'No data yet.', color = 'bg-primary' }: {
  data?: Counts;
  maxItems?: number;
  empty?: string;
  color?: string;
}) {
  const rows = entries(data || {}).slice(0, maxItems);
  const max = Math.max(1, ...rows.map(([, count]) => Number(count)));
  if (!rows.length) return <div className="rounded-lg border border-dashed border-neutral-border p-8 text-center text-xs text-slate-500">{empty}</div>;
  return (
    <div className="space-y-3">
      {rows.map(([label, count]) => (
        <div key={label}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px]">
            <span className="truncate text-slate-200">{formatLabel(label)}</span>
            <span className="font-mono text-slate-500">{count}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.max(3, Number(count) / max * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DonutChart({ data, centerLabel }: { data?: Counts; centerLabel: string }) {
  const rows = entries(data || {});
  const total = rows.reduce((sum, [, count]) => sum + Number(count), 0);
  const palette = ['#00ad84', '#f59e0b', '#f43f5e', '#60a5fa', '#a78bfa', '#64748b'];
  let cursor = 0;
  const stops = rows.map(([, count], index) => {
    const start = cursor;
    cursor += total ? Number(count) / total * 100 : 0;
    return `${palette[index % palette.length]} ${start}% ${cursor}%`;
  }).join(', ');
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div className="relative h-36 w-36 shrink-0 rounded-full" style={{ background: total ? `conic-gradient(${stops})` : '#1e293b' }}>
        <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-bg-card text-center">
          <span className="text-2xl font-bold text-white">{total}</span>
          <span className="text-[9px] uppercase tracking-widest text-slate-500">{centerLabel}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {rows.slice(0, 6).map(([label, count], index) => (
          <div key={label} className="flex items-center justify-between gap-4 text-[11px]">
            <span className="flex min-w-0 items-center gap-2 text-slate-300"><i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: palette[index % palette.length] }} /><span className="truncate">{formatLabel(label)}</span></span>
            <span className="font-mono text-slate-200">{count} <span className="text-slate-400">· {total ? Math.round(Number(count) / total * 100) : 0}%</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendChart({ points = [], metric = 'audits' }: { points?: Array<Record<string, any> & { date: string }>; metric?: string }) {
  const width = 720;
  const height = 180;
  const max = Math.max(1, ...points.map((point) => Number(point[metric] || 0)));
  const coordinates = points.map((point, index) => `${points.length === 1 ? width / 2 : index / (points.length - 1) * width},${height - Number(point[metric] || 0) / max * (height - 28) - 12}`).join(' ');
  if (!points.length) return <div className="flex h-44 items-center justify-center text-xs text-slate-500">No scan history yet.</div>;
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full overflow-visible" role="img" aria-label="Audits over time">
        {[0.25, 0.5, 0.75, 1].map((line) => <line key={line} x1="0" x2={width} y1={height - line * (height - 28) - 12} y2={height - line * (height - 28) - 12} stroke="#26303d" strokeWidth="1" />)}
        <polyline points={coordinates} fill="none" stroke="#00ad84" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => {
          const x = points.length === 1 ? width / 2 : index / (points.length - 1) * width;
          const value = Number(point[metric] || 0);
          const y = height - value / max * (height - 28) - 12;
          return <circle key={point.date} cx={x} cy={y} r="5" fill="#0f1219" stroke="#00ad84" strokeWidth="3"><title>{point.date}: {value} {formatLabel(metric)}</title></circle>;
        })}
      </svg>
      <div className="flex justify-between text-[9px] uppercase tracking-wider text-slate-400"><span>{points[0]?.date}</span><span>{points.at(-1)?.date}</span></div>
    </div>
  );
}

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-border bg-bg-card p-4 shadow-sm">
      <div className="mb-4">
        <h3 className="text-sm font-bold text-white">{title}</h3>
        {description && <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function QualityDashboard({ quality, onOpenAudit }: { quality: any; onOpenAudit: (id: string | number) => void }) {
  const failures = quality.failure_clusters || [];
  const categories = quality.verified.category_summaries || [];
  const [trendMetric, setTrendMetric] = useState<'audits' | 'completed' | 'failed' | 'inconclusive'>('audits');
  const [distributionKey, setDistributionKey] = useState('overall_status');
  const distributions = [
    ['overall_status', 'Overall'], ['scan_status', 'Scan Status'], ['error_category', 'Operational / Access'],
    ['cms', 'CMS'], ['cmp', 'CMP'], ['consent', 'Consent'], ['ga4_installation', 'GA4'],
    ['meta_installation', 'Meta'], ['product_payload', 'PDP / View Item'], ['server_side', 'Server-Side']
  ];
  const distribution = quality.distributions[distributionKey] || {};
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-4 py-3 text-[11px] text-slate-300">
        Finding distributions, rates, trends, and improvement priorities use only the latest audit for each unique website. Historical audits remain stored and available from the Audits page.
      </div>
      <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
        <MetricCard label="Total Audits" value={Number(quality.operational.total_audits ?? quality.operational.audits ?? 0).toLocaleString()} helper="All stored audit history" />
        <MetricCard label="Unique Websites" value={Number(quality.operational.unique_websites ?? 0).toLocaleString()} helper="Latest finding per website" />
        <MetricCard label="Completion" value={formatPercent(quality.operational.completion_rate)} helper="Latest unique audits" tone="good" />
        <MetricCard label="Valid Storefront" value={formatPercent(quality.operational.valid_storefront_rate)} helper="Pages safe to evaluate" tone="good" />
        <MetricCard label="Inconclusive" value={formatPercent(quality.operational.inconclusive_rate)} helper="Best opportunity to reduce uncertainty" tone={quality.operational.inconclusive_rate > .2 ? 'warning' : 'default'} />
        <MetricCard label="Needs Review" value={quality.operational.review_candidates} helper={`${quality.operational.unverified_audits} audits not verified`} tone="warning" />
        <MetricCard label="QA Coverage" value={formatPercent(quality.verified.coverage)} helper={`${quality.verified.verified_audits} audits verified`} />
        <MetricCard label="P95 Access" value={formatDuration(quality.operational.p95_access_duration_ms ?? quality.operational.p95_scan_time_ms)} helper={`Average ${formatDuration(quality.operational.average_access_duration_ms ?? quality.operational.average_scan_time_ms)}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <Panel title="Latest Website Audit Trend" description="Each website contributes only its latest audit. Select a metric to compare daily outcomes over the last 30 active days.">
          <div className="mb-2 flex flex-wrap gap-1">{(['audits', 'completed', 'failed', 'inconclusive'] as const).map((metric) => <button key={metric} type="button" onClick={() => setTrendMetric(metric)} className={`rounded-full px-3 py-1.5 text-[10px] font-semibold transition ${trendMetric === metric ? 'bg-primary/15 text-primary' : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'}`}>{formatLabel(metric)}</button>)}</div>
          <TrendChart points={quality.trend} metric={trendMetric} />
        </Panel>
        <Panel title="Scan Outcomes" description="Interactive summary based on the latest audit for every unique website."><DonutChart data={quality.distributions.scan_status} centerLabel="Websites" /></Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <Panel title="Finding Distribution Explorer" description="Switch between modules to see the latest unique website findings: detected, missing, inconclusive, and not tested.">
          <div className="mb-5 flex flex-wrap gap-1.5">{distributions.map(([key, label]) => <button key={key} type="button" onClick={() => setDistributionKey(key)} className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition ${distributionKey === key ? 'border-primary/40 bg-primary/15 text-primary' : 'border-neutral-border text-slate-400 hover:border-slate-600 hover:text-white'}`}>{label}</button>)}</div>
          <div className="grid items-center gap-6 md:grid-cols-[.72fr_1.28fr]"><DonutChart data={distribution} centerLabel={distributions.find(([key]) => key === distributionKey)?.[1] || 'Findings'} /><BarList data={distribution} maxItems={10} color="bg-violet-500" /></div>
        </Panel>
        <Panel title="Improvement Priorities" description="Recurring scanner weaknesses ranked by frequency. Select a row to inspect a representative audit.">
          {failures.length ? <div className="space-y-2">{failures.slice(0, 7).map((cluster: any, index: number) => (
            <article key={cluster.code} className="group rounded-lg border border-neutral-border-muted bg-[#10141c] p-3 transition hover:border-primary/40 hover:bg-bg-card-hover">
              <div className="flex items-start gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-[10px] font-bold text-amber-300">{index + 1}</span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><span className="truncate font-mono text-[10px] font-semibold text-amber-300">{cluster.code}</span><span className="text-[10px] font-bold text-slate-300">{cluster.count}</span></div><p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-400">{cluster.recommendation}</p><div className="mt-2 flex flex-wrap items-center gap-2">{(cluster.domains || []).slice(0, 3).map((domain: string) => <a key={domain} href={websiteUrl(domain)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[9px] text-primary hover:underline">{domain}<ExternalLink className="h-2.5 w-2.5" /></a>)}{!cluster.domains?.length && <span className="text-[9px] text-slate-400">No Sample Domain</span>}<button type="button" onClick={() => cluster.audit_ids?.[0] !== undefined && onOpenAudit(cluster.audit_ids[0])} className="ml-auto rounded-md border border-primary/30 px-2 py-1 text-[9px] font-semibold text-primary hover:bg-primary/10">Open Audit</button></div></div></div>
            </article>
          ))}</div> : <div className="rounded-lg border border-dashed border-neutral-border p-8 text-center text-xs text-slate-400">No failure fingerprints have been recorded.</div>}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <Panel title="Verified Finding Accuracy" description="Human-confirmed outcomes only. Colored bars expose true/false positives and negatives without hiding sparse ground truth.">
          {categories.length ? <div className="space-y-3">{categories.map((category: any) => {
            const scored = category.true_positive + category.false_positive + category.true_negative + category.false_negative;
            const total = Math.max(1, category.total);
            return <div key={category.category} className="rounded-lg border border-neutral-border-muted bg-[#10141c] p-3"><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-white">{formatLabel(category.category)}</span><span className="text-[10px] text-primary">{formatPercent(category.accuracy)} accuracy · {category.total} verified</span></div><div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-800"><i className="bg-emerald-500" title={`True Positive: ${category.true_positive}`} style={{ width: `${category.true_positive / total * 100}%` }} /><i className="bg-sky-500" title={`True Negative: ${category.true_negative}`} style={{ width: `${category.true_negative / total * 100}%` }} /><i className="bg-rose-500" title={`False Positive: ${category.false_positive}`} style={{ width: `${category.false_positive / total * 100}%` }} /><i className="bg-orange-500" title={`False Negative: ${category.false_negative}`} style={{ width: `${category.false_negative / total * 100}%` }} /><i className="bg-slate-600" title={`Unscored / inconclusive: ${category.total - scored}`} style={{ width: `${(category.total - scored) / total * 100}%` }} /></div><div className="mt-2 flex flex-wrap gap-3 text-[9px] text-slate-400"><span>TP {category.true_positive}</span><span>TN {category.true_negative}</span><span className="text-rose-300">FP {category.false_positive}</span><span className="text-orange-300">FN {category.false_negative}</span><span>Other {category.total - scored}</span></div></div>;
          })}</div> : <div className="rounded-lg border border-dashed border-neutral-border p-8 text-center text-xs text-slate-400">No verified findings yet. Use the feedback panel on an audit to establish ground truth.</div>}
        </Panel>
        <Panel title="Access Health" description="Latest-audit access outcomes, provider recovery, challenge recovery, and access timing.">
          <div className="grid grid-cols-2 gap-2"><MetricCard label="Valid Storefront" value={formatPercent(quality.operational.valid_storefront_rate)} /><MetricCard label="Decodo Primary" value={formatPercent(quality.operational.decodo_primary_success_rate)} /><MetricCard label="Retry Recovery" value={formatPercent(quality.operational.retry_recovery_rate)} /><MetricCard label="Browserless Fallback" value={formatPercent(quality.operational.browserless_fallback_recovery_rate)} /><MetricCard label="Challenge Recovery" value={formatPercent(quality.operational.challenge_recovery_rate)} /><MetricCard label="Average Access" value={formatDuration(quality.operational.average_access_duration_ms ?? quality.operational.average_scan_time_ms)} /><MetricCard label="P95 Access" value={formatDuration(quality.operational.p95_access_duration_ms ?? quality.operational.p95_scan_time_ms)} /><MetricCard label="Rate Limits" value={formatPercent(quality.operational.rate_limit_rate)} /></div>
        </Panel>
      </div>
    </div>
  );
}

function sum(rows: any[], field: string) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

export function ProxyDashboard({ metrics, readiness, queue }: { metrics: any; readiness: any; queue: any }) {
  const rows = Array.isArray(metrics?.persistent) ? metrics.persistent : [];
  const connects = sum(rows, 'connects');
  const errors = sum(rows, 'errors');
  const retries = sum(rows, 'retries');
  const recovered = sum(rows, 'retry_successes');
  const connectTime = sum(rows, 'total_connect_ms');
  const byGeo = rows.reduce((result: Record<string, number>, row: any) => {
    result[row.geo] = (result[row.geo] || 0) + Number(row.connects || 0);
    return result;
  }, {});
  const errorsByGeo = rows.reduce((result: Record<string, number>, row: any) => {
    result[row.geo] = (result[row.geo] || 0) + Number(row.errors || 0);
    return result;
  }, {});
  const issues = readiness?.proxy_configuration_issues || [];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard label="Connections" value={connects.toLocaleString()} helper="Persistent recorded attempts" />
        <MetricCard label="Error Rate" value={formatPercent(connects ? errors / connects : 0)} helper={`${errors} connection errors`} tone={connects && errors / connects > .2 ? 'danger' : 'good'} />
        <MetricCard label="Retry Recovery" value={formatPercent(retries ? recovered / retries : 0)} helper={`${recovered} of ${retries} retries recovered`} tone={retries && recovered / retries < .5 ? 'warning' : 'good'} />
        <MetricCard label="Average Connect" value={formatDuration(connects ? connectTime / connects : null)} helper="Browserless connection latency" />
        <MetricCard label="Queue" value={`${queue?.active || 0} active`} helper={`${queue?.pending || 0} pending · limit ${queue?.concurrency ?? '—'}`} />
        <MetricCard label="Quarantined Ports" value={rows.filter((row: any) => row.quarantined).length} helper={`${rows.length} configured ports observed`} tone={rows.some((row: any) => row.quarantined) ? 'danger' : 'good'} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[.8fr_1.2fr]">
        <Panel title="Access Readiness" description="Current browser, route, proxy, and escalation configuration. Secrets are never exposed.">
          <div className="space-y-3">
            {[
              ['Browser provider', readiness?.browser_provider],
              ['Browserless route', readiness?.browserless_route],
              ['Proxy mode', readiness?.proxy_mode],
              ['Difficult-site escalation', readiness?.bql_escalation_enabled ? 'enabled' : 'disabled'],
              ['Egress verification', readiness?.egress_probe_enabled ? 'enabled' : 'disabled']
            ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 rounded-lg bg-[#10141c] px-3 py-2.5 text-[11px]"><span className="text-slate-500">{label}</span><StatusBadge value={value || 'not configured'} /></div>)}
          </div>
          {issues.length ? <div className="mt-4 rounded-lg border border-amber-800/50 bg-amber-950/20 p-3"><div className="flex items-center gap-2 text-xs font-bold text-amber-300"><AlertTriangle className="h-4 w-4" />Configuration attention</div><ul className="mt-2 space-y-1 text-[11px] text-amber-200/70">{issues.map((issue: string) => <li key={issue}>• {issue}</li>)}</ul></div> : <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-3 text-xs text-emerald-300"><CheckCircle2 className="h-4 w-4" />Configured proxy checks passed.</div>}
        </Panel>
        <Panel title="Traffic by Geo" description="Connection volume and errors help identify a weak regional gateway.">
          <div className="grid gap-7 sm:grid-cols-2"><div><div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><Network className="h-3.5 w-3.5" />Connections</div><BarList data={byGeo} /></div><div><div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><ShieldAlert className="h-3.5 w-3.5" />Errors</div><BarList data={errorsByGeo} color="bg-rose-500" empty="No proxy errors recorded." /></div></div>
        </Panel>
      </div>

      <Panel title="Port Health" description="Error rate, retry recovery, latency, and quarantine state for each persisted Decodo port.">
        {rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-xs"><thead className="text-[9px] uppercase tracking-wider text-slate-600"><tr><th className="pb-3">Geo / port</th><th className="pb-3">Connections</th><th className="pb-3">Storefront success</th><th className="pb-3">Error rate</th><th className="pb-3">Retry recovery</th><th className="pb-3">Connect time</th><th className="pb-3">Health</th></tr></thead><tbody>{rows.map((row: any) => <tr key={`${row.geo}:${row.port}`} className="border-t border-neutral-border-muted"><td className="py-3 font-mono font-semibold text-white">{row.geo} · {row.port}</td><td className="py-3 text-slate-400">{Number(row.connects || 0).toLocaleString()}</td><td className="py-3 text-slate-400">{Number(row.storefront_successes || 0).toLocaleString()}</td><td className="py-3"><div className="flex items-center gap-2"><span className="w-12 text-slate-400">{formatPercent(Number(row.error_rate || 0))}</span><span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800"><i className="block h-full rounded-full bg-rose-500" style={{ width: `${Math.min(100, Number(row.error_rate || 0) * 100)}%` }} /></span></div></td><td className="py-3 text-slate-400">{formatPercent(Number(row.retry_recovery_rate || 0))}</td><td className="py-3 text-slate-400">{formatDuration(row.average_connect_ms === null ? null : Number(row.average_connect_ms))}</td><td className="py-3"><StatusBadge value={row.quarantined ? 'quarantined' : Number(row.consecutive_errors || 0) ? 'watch' : 'healthy'} /></td></tr>)}</tbody></table></div> : <div className="rounded-lg border border-dashed border-neutral-border p-10 text-center"><Gauge className="mx-auto h-6 w-6 text-slate-600" /><p className="mt-3 text-xs text-slate-500">No persisted proxy activity yet. Run an audit to populate port analytics.</p></div>}
      </Panel>

      {queue?.domain_circuits?.length > 0 && <Panel title="Domain Cooldowns" description="Temporary circuit breakers prevent repeated requests to a domain that is blocking or rate-limiting scans."><div className="grid gap-3 md:grid-cols-2">{queue.domain_circuits.map((circuit: any) => <div key={circuit.domain} className="rounded-lg border border-amber-800/40 bg-amber-950/15 p-3"><a href={websiteUrl(circuit.domain)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs font-bold text-amber-300 hover:underline"><Clock3 className="h-4 w-4" />{circuit.domain}<ExternalLink className="h-3 w-3" /></a><p className="mt-2 text-[11px] text-slate-400">{formatLabel(circuit.reason)} · resumes {new Date(circuit.resumes_at).toLocaleString()}</p></div>)}</div></Panel>}
    </div>
  );
}
