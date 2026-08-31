import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  Activity, BarChart3, Bug, Check, CheckCircle2, ChevronRight, CircleHelp, Database, Download,
  ExternalLink, FileSearch, FlaskConical, Gauge, Globe2, Info, Loader2, Play, RefreshCw, RotateCcw,
  Search, Settings2, ShieldCheck, Square, Trash2, Upload, X
} from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { AuditModule, FindingConfidence, QaFeedback, StorefrontAudit } from './types';
import { AnalysisPanel, type AnalysisResult, TraceTimeline } from './ui/AuditInsights';
import { MetricCard, ProxyDashboard, QualityDashboard, formatDuration } from './ui/Analytics';
import { apiFetch, downloadBlob } from './ui/api';
import { formatLabel, websiteUrl } from './ui/format';
import { StatusBadge } from './ui/StatusBadge';

type View = 'audits' | 'quality' | 'review' | 'proxy';
type AuditFilter = 'all' | 'review' | 'failed' | 'timeout' | 'proxy' | 'access' | 'runtime' | 'fallback_candidate' | 'bot_unresolved' | 'rate_limited' | 'fallback_recovered' | 'active';
const ACTIVE_STATUSES = new Set(['pending', 'scanning']);
const ACCESS_FAILURES = new Set(['rate_limited', 'access_blocked', 'bot_protection', 'dns_error', 'ssl_error']);
const QA_CATEGORIES: QaFeedback['category'][] = ['CMP', 'Consent', 'GA4', 'Meta', 'view_item', 'PDP discovery', 'server-side', 'CMS', 'bot/access', 'other'];

function ExplainedAction({ help, children, className = '', ...buttonProps }: {
  help: string;
  children: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const tooltipId = useId();
  return (
    <span className="group relative inline-flex">
      <button {...buttonProps} aria-describedby={tooltipId} className={`action-button ${className}`}>
        {children}<Info className="h-3 w-3 opacity-55 transition group-hover:opacity-100" aria-hidden="true" />
      </button>
      <span id={tooltipId} role="tooltip" className="pointer-events-none invisible absolute left-0 top-full z-50 mt-2 w-72 translate-y-1 rounded-lg border border-slate-700 bg-[#090d13] px-3 py-2.5 text-left text-[10px] font-normal normal-case leading-relaxed tracking-normal text-slate-300 opacity-0 shadow-2xl transition group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
        {help}
      </span>
    </span>
  );
}

function boolStatus(value: boolean | null | undefined) {
  return value === null || value === undefined ? 'not tested' : value ? 'detected' : 'not detected';
}

function ga4InstallationStatus(audit: StorefrontAudit) {
  const evidence = Boolean(audit.site_ga4_detected || audit.site_ga4_measurement_ids?.length || audit.finding_confidence?.ga4?.detected);
  return evidence ? 'detected' : boolStatus(audit.site_ga4_detected);
}

function currentFindingValue(audit: StorefrontAudit, category: QaFeedback['category']) {
  if (category === 'GA4') return boolStatus(audit.site_ga4_detected);
  if (category === 'Meta') return boolStatus(audit.site_meta_detected);
  if (category === 'CMP') return audit.cmp_provider || 'not tested';
  if (category === 'Consent') return audit.consent_status || 'not tested';
  if (category === 'view_item') return audit.product_payload_status || 'not tested';
  if (category === 'PDP discovery') return audit.pdp_url_tested ? 'detected' : audit.product_payload_status || 'not tested';
  if (category === 'server-side') return audit.server_side_status || 'not tested';
  if (category === 'CMS') return audit.cms_platform_detected || 'Unknown';
  if (category === 'bot/access') return audit.error_category || 'none';
  return audit.overall_status || 'not tested';
}

function Finding({ title, description, value, confidence }: {
  title: string;
  description: ReactNode;
  value: unknown;
  confidence?: FindingConfidence;
}) {
  return (
    <article className="rounded-xl border border-neutral-border-muted bg-[#11151d] p-4 transition hover:border-neutral-border">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0"><h4 className="text-xs font-bold text-white">{title}</h4><div className="mt-1.5 text-[11px] leading-relaxed text-slate-400">{description}</div></div>
        <StatusBadge value={value} />
      </div>
      {confidence && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-border-muted pt-3 text-[9px] uppercase tracking-wider text-slate-600"><span>{confidence.confidence} confidence</span><span>·</span><span className="font-mono text-slate-500">{confidence.reason_code}</span></div>}
    </article>
  );
}

function timeLabel(value: string | null) {
  if (!value) return 'Not completed';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function uniqueCodes(codes: string[] | null | undefined) {
  return [...new Set<string>(codes || [])];
}

function terminalFailure(audit: StorefrontAudit) {
  const trace = (() => {
    try {
      const parsed = JSON.parse(audit.trace_steps || '[]');
      return Array.isArray(parsed) ? parsed.filter((step): step is Record<string, unknown> => Boolean(step && typeof step === 'object')) : [];
    } catch { return []; }
  })();
  const terminal = [...trace].reverse().find((step) => step.step !== 'scan_finalized' &&
    (typeof step.reason_code === 'string' || typeof step.error_category === 'string' || /(?:failed|error|timeout|blocked)/i.test(String(step.step || ''))));
  const reasonCode = audit.terminal_reason_code || (typeof terminal?.reason_code === 'string' ? terminal.reason_code :
    typeof terminal?.error_category === 'string' ? terminal.error_category : audit.error_category);
  return {
    phase: audit.terminal_runtime_phase ? formatLabel(audit.terminal_runtime_phase) : terminal?.step ? formatLabel(terminal.step) : 'Terminal finalization',
    reasonCode,
    productPhase: /(?:pdp|product)/i.test(`${terminal?.step || ''} ${reasonCode}`)
  };
}

function proxyLabel(provider: 'decodo' | 'browserless_residential' | null | undefined, retry = false) {
  if (!provider) return '—';
  if (provider === 'browserless_residential') return 'Browserless fallback';
  return retry ? 'Decodo retry' : 'Decodo primary';
}

function accessStateLabel(audit: StorefrontAudit) {
  if (audit.error_category === 'proxy_error') return 'Proxy failure';
  if (audit.error_category === 'rate_limited') return 'Rate limit';
  if (audit.error_category === 'bot_protection') return 'Bot/WAF challenge';
  if (audit.error_category === 'access_blocked') return 'HTTP access block';
  if (audit.evidence_bundle?.access?.valid_storefront === true) return 'Valid storefront reached';
  return 'Runtime/access inconclusive';
}

function accessAttemptResult(attempt: NonNullable<StorefrontAudit['evidence_bundle']>['access']['proxy_attempts'][number]) {
  if (attempt.failure_classification) return formatLabel(attempt.failure_classification);
  if (attempt.target_result === 'valid_storefront') return 'Storefront reached';
  return formatLabel(attempt.target_result);
}

function failureMatches(audit: StorefrontAudit, filter: AuditFilter) {
  const access = audit.evidence_bundle?.access;
  if (filter === 'fallback_candidate') return Boolean(access?.proxy_fallback_used || audit.runtime_metrics?.proxy_fallback_candidate);
  if (filter === 'bot_unresolved') return Boolean(access?.challenge_detected && access.challenge_solver_result !== 'succeeded' && access.valid_storefront !== true);
  if (filter === 'rate_limited') return audit.error_category === 'rate_limited';
  if (filter === 'fallback_recovered') return Boolean(access?.proxy_fallback_recovered);
  if (audit.scan_status !== 'failed') return false;
  if (filter === 'failed') return true;
  if (filter === 'timeout') return audit.error_category === 'scan_timeout';
  if (filter === 'proxy') return audit.error_category === 'proxy_error';
  if (filter === 'access') return ACCESS_FAILURES.has(audit.error_category);
  return filter === 'runtime' && audit.error_category !== 'scan_timeout' && audit.error_category !== 'proxy_error' && !ACCESS_FAILURES.has(audit.error_category);
}

function EvidenceCodeGroup({ title, codes, tone }: { title: string; codes: string[]; tone: 'decision' | 'review' | 'fingerprint' | 'issue' }) {
  if (!codes.length) return null;
  const styles = tone === 'issue'
    ? 'border-rose-800/45 bg-rose-950/25 text-rose-200'
    : tone === 'review'
      ? 'border-amber-800/45 bg-amber-950/20 text-amber-200'
      : tone === 'fingerprint'
        ? 'border-violet-800/45 bg-violet-950/20 text-violet-200'
      : 'border-sky-800/40 bg-sky-950/20 text-sky-200';
  return (
    <div>
      <div className="mb-2 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">{title}</div>
      <div className="flex flex-wrap gap-2">{codes.map((code) => (
        <span key={code} title={code} className={`rounded-md border px-2.5 py-1.5 text-[9px] font-semibold ${styles}`}>{formatLabel(code)}</span>
      ))}</div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('audits');
  const [token, setToken] = useState(() => sessionStorage.getItem('upsight_internal_token') || '');
  const [domain, setDomain] = useState('');
  const [geo, setGeo] = useState<'USA' | 'EU' | 'UK'>('USA');
  const [group, setGroup] = useState('');
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [scanMode, setScanMode] = useState<'normal' | 'diagnostic'>('normal');
  const [selectedModules, setSelectedModules] = useState<AuditModule[]>(['consent', 'tracking', 'server_side']);
  const [csv, setCsv] = useState<File | null>(null);
  const [captcha, setCaptcha] = useState(false);
  const [scans, setScans] = useState<StorefrontAudit[]>([]);
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [search, setSearch] = useState('');
  const [reviewSearch, setReviewSearch] = useState('');
  const [auditFilter, setAuditFilter] = useState<AuditFilter>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<any>(null);
  const [reviewCandidates, setReviewCandidates] = useState<StorefrontAudit[]>([]);
  const [proxyMetrics, setProxyMetrics] = useState<any>(null);
  const [accessReadiness, setAccessReadiness] = useState<any>(null);
  const [queueMetrics, setQueueMetrics] = useState<any>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [qaCorrectionOpen, setQaCorrectionOpen] = useState(false);
  const [qaCategory, setQaCategory] = useState<QaFeedback['category']>('GA4');
  const [qaExpected, setQaExpected] = useState('');
  const [qaNotes, setQaNotes] = useState('');
  const [qaSubmitting, setQaSubmitting] = useState<'correct' | 'incorrect' | null>(null);
  const [qaSaved, setQaSaved] = useState<string | null>(null);
  const [markingCorrectId, setMarkingCorrectId] = useState<string | number | null>(null);
  const [selectedAuditIds, setSelectedAuditIds] = useState<Set<string>>(() => new Set());

  const selected = scans.find((scan) => String(scan.audit_id) === String(selectedId)) || null;
  const filteredScans = useMemo(() => {
    const term = search.trim().toLowerCase();
    return scans.filter((scan) => {
      const matchesTerm = !term || scan.domain.toLowerCase().includes(term) ||
        String(scan.group_label || '').toLowerCase().includes(term) ||
        String(scan.cms_platform_detected || '').toLowerCase().includes(term) ||
        String(scan.failure_fingerprints || '').toLowerCase().includes(term);
      const matchesFilter = auditFilter === 'all' ||
        auditFilter === 'review' && scan.qa_review_status !== 'correct' && ((scan.qa_priority || 0) > 0 || scan.overall_confidence === 'low') ||
        ['failed', 'timeout', 'proxy', 'access', 'runtime', 'fallback_candidate', 'bot_unresolved', 'rate_limited', 'fallback_recovered'].includes(auditFilter) && failureMatches(scan, auditFilter) ||
        auditFilter === 'active' && ACTIVE_STATUSES.has(scan.scan_status);
      return matchesTerm && matchesFilter;
    });
  }, [scans, search, auditFilter]);
  const filteredReviewCandidates = useMemo(() => {
    const term = reviewSearch.trim().toLowerCase();
    if (!term) return reviewCandidates;
    return reviewCandidates.filter((scan) => scan.domain.toLowerCase().includes(term) ||
      String(scan.cms_platform_detected || '').toLowerCase().includes(term) ||
      String(scan.cmp_provider || '').toLowerCase().includes(term) ||
      String(scan.failure_fingerprints || '').toLowerCase().includes(term) ||
      String((scan.qa_feedback || []).map((item) => `${item.category} ${item.expected_value} ${item.notes}`)).toLowerCase().includes(term));
  }, [reviewCandidates, reviewSearch]);
  const allFilteredSelected = filteredScans.length > 0 && filteredScans.every((scan) => selectedAuditIds.has(String(scan.audit_id)));

  const request = useCallback((input: RequestInfo | URL, init?: RequestInit) => apiFetch(input, init, token), [token]);

  const loadScans = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const response = await request('/api/v1/scans?limit=1000');
      const data = await response.json();
      setScans(data);
      setSelectedId((current) => current ?? data[0]?.audit_id ?? null);
      setError(null);
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [request]);

  useEffect(() => { void loadScans(); }, [loadScans]);
  useEffect(() => {
    if (!scans.some((scan) => ACTIVE_STATUSES.has(scan.scan_status))) return;
    const timer = window.setInterval(() => void loadScans(true), 3000);
    return () => window.clearInterval(timer);
  }, [scans, loadScans]);
  useEffect(() => { setAnalysis(null); setQaCorrectionOpen(false); setQaSaved(null); setQaSubmitting(null); }, [selectedId]);
  useEffect(() => {
    if (selectedId === null) return;
    let cancelled = false;
    const loadSelectedAudit = async () => {
      try {
        const response = await request(`/api/v1/scans/${selectedId}`);
        const audit = await response.json() as StorefrontAudit;
        if (!cancelled) setScans((current) => current.map((item) =>
          String(item.audit_id) === String(audit.audit_id) ? audit : item
        ));
      } catch (caught: any) {
        if (!cancelled) setError(caught.message);
      }
    };
    void loadSelectedAudit();
    return () => { cancelled = true; };
  }, [selectedId, request]);
  useEffect(() => {
    const loadView = async () => {
      try {
        if (view === 'quality') setQuality(await (await request('/api/v1/quality/metrics')).json());
        if (view === 'review') setReviewCandidates(await (await request('/api/v1/quality/review-candidates')).json());
        if (view === 'proxy') {
          const [proxyResponse, readinessResponse, queueResponse] = await Promise.all([
            request('/api/v1/scanner/proxy-metrics'), request('/api/v1/scanner/access-readiness'), request('/api/v1/queue')
          ]);
          setProxyMetrics(await proxyResponse.json());
          setAccessReadiness(await readinessResponse.json());
          setQueueMetrics(await queueResponse.json());
        }
      } catch (caught: any) { setError(caught.message); }
    };
    void loadView();
  }, [view, request]);

  const saveToken = (value: string) => {
    setToken(value);
    if (value) sessionStorage.setItem('upsight_internal_token', value);
    else sessionStorage.removeItem('upsight_internal_token');
  };

  const startScan = async () => {
    if (!selectedModules.length) { setError('Select at least one audit module.'); return; }
    setBusy(true);
    setError(null);
    try {
      let response: Response;
      if (mode === 'single') {
        response = await request('/api/v1/scan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, tested_geos: geo, group_label: group || null, mode: scanMode, selected_modules: selectedModules, enable_captcha_solving: captcha })
        });
      } else {
        if (!csv) throw new Error('Choose a CSV file first.');
        const body = new FormData();
        body.append('file', csv); body.append('tested_geos', geo); body.append('group_label', group); body.append('mode', scanMode); body.append('selected_modules', JSON.stringify(selectedModules));
        response = await request('/api/v1/scan/bulk', { method: 'POST', body });
      }
      const result = await response.json();
      const created = result.audits?.[0] || result;
      setDomain(''); setCsv(null);
      await loadScans(true);
      if (created?.audit_id) setSelectedId(created.audit_id);
    } catch (caught: any) { setError(caught.message); } finally { setBusy(false); }
  };

  const selectedAction = async (path: string, init: RequestInit = { method: 'POST' }) => {
    if (!selected) return null;
    setBusy(true); setError(null);
    try {
      const response = await request(`/api/v1/scans/${selected.audit_id}/${path}`, init);
      const result = await response.json();
      await loadScans(true);
      return result;
    } catch (caught: any) { setError(caught.message); return null; } finally { setBusy(false); }
  };

  const exportDebug = async () => {
    if (!selected) return;
    try {
      const response = await request(`/api/v1/scans/${selected.audit_id}/debug-package`);
      downloadBlob(await response.blob(), `upsight-debug-${selected.audit_id}.zip`);
    } catch (caught: any) { setError(caught.message); }
  };

  const submitFeedback = async (verdict: 'correct' | 'incorrect') => {
    if (!selected || qaSubmitting) return;
    const actual = currentFindingValue(selected, qaCategory);
    setQaSubmitting(verdict);
    setQaSaved(null);
    setError(null);
    try {
      const response = await request(`/api/v1/scans/${selected.audit_id}/qa-feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, category: qaCategory, expected_value: verdict === 'correct' ? actual : qaExpected || null, notes: qaNotes || null })
      });
      const feedback = await response.json() as QaFeedback;
      await loadScans(true);
      setScans((current) => current.map((scan) => String(scan.audit_id) === String(selected.audit_id)
        ? { ...scan, qa_feedback: [feedback, ...(scan.qa_feedback || [])] }
        : scan));
      setReviewCandidates((current) => current.map((scan) => String(scan.audit_id) === String(selected.audit_id)
        ? { ...scan, qa_feedback: [feedback, ...(scan.qa_feedback || [])] }
        : scan));
      setQaSaved(`${formatLabel(qaCategory)} feedback saved to the Review Queue and Quality dataset.`);
      setQaCorrectionOpen(false); setQaExpected(''); setQaNotes('');
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setQaSubmitting(null);
    }
  };

  const markAuditCorrect = async (audit: StorefrontAudit) => {
    if (markingCorrectId !== null || !window.confirm(`Mark Audit #${audit.audit_id} for ${audit.domain} as correct and remove it from the Review Queue?`)) return;
    setMarkingCorrectId(audit.audit_id);
    setError(null);
    try {
      const response = await request(`/api/v1/scans/${audit.audit_id}/mark-correct`, { method: 'POST' });
      const reviewed = await response.json() as StorefrontAudit;
      setReviewCandidates((current) => current.filter((item) => String(item.audit_id) !== String(audit.audit_id)));
      setScans((current) => current.map((item) => String(item.audit_id) === String(audit.audit_id) ? { ...item, ...reviewed } : item));
      setQuality(null);
    } catch (caught: any) {
      setError(caught.message);
    } finally {
      setMarkingCorrectId(null);
    }
  };

  const deleteSelected = async () => {
    if (!selected || !window.confirm(`Delete audit ${selected.audit_id} for ${selected.domain}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await request('/api/v1/scans/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [selected.audit_id] }) });
      setSelectedId(null); await loadScans(true);
    } catch (caught: any) { setError(caught.message); } finally { setBusy(false); }
  };

  const toggleAuditSelection = (id: string | number) => {
    setSelectedAuditIds((current) => {
      const next = new Set(current);
      const key = String(id);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAllFilteredAudits = () => {
    setSelectedAuditIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filteredScans.forEach((scan) => next.delete(String(scan.audit_id)));
      else filteredScans.forEach((scan) => next.add(String(scan.audit_id)));
      return next;
    });
  };

  const bulkRerunSelected = async () => {
    const ids = [...selectedAuditIds];
    if (!ids.length || !window.confirm(`Re-run ${ids.length} selected audit${ids.length === 1 ? '' : 's'} using each audit's original geo, mode, modules, and group label?`)) return;
    setBusy(true); setError(null);
    try {
      const response = await request('/api/v1/scans/bulk-rerun', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
      });
      const result = await response.json();
      setSelectedAuditIds(new Set());
      await loadScans(true);
      if (result.audits?.[0]?.audit_id) setSelectedId(result.audits[0].audit_id);
    } catch (caught: any) { setError(caught.message); } finally { setBusy(false); }
  };

  const bulkDeleteSelected = async () => {
    const ids = [...selectedAuditIds];
    if (!ids.length || !window.confirm(`Delete ${ids.length} selected audit${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBusy(true); setError(null);
    try {
      await request('/api/v1/scans/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
      });
      if (selectedId !== null && selectedAuditIds.has(String(selectedId))) setSelectedId(null);
      setSelectedAuditIds(new Set());
      await loadScans(true);
    } catch (caught: any) { setError(caught.message); } finally { setBusy(false); }
  };

  const openAudit = (id: string | number) => { setSelectedId(id); setView('audits'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const scanSummary = {
    active: scans.filter((scan) => ACTIVE_STATUSES.has(scan.scan_status)).length,
    failed: scans.filter((scan) => scan.scan_status === 'failed').length,
    review: scans.filter((scan) => scan.qa_review_status !== 'correct' && ((scan.qa_priority || 0) > 0 || scan.overall_confidence === 'low')).length
  };

  return (
    <div className="min-h-screen bg-bg-dark text-foreground">
      <header className="sticky top-0 z-30 border-b border-neutral-border bg-bg-dark/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <button type="button" onClick={() => setView('audits')} className="group flex items-center gap-3 text-left">
            <div className="rounded-xl border border-primary/40 bg-primary/10 p-2.5 text-primary transition group-hover:bg-primary/20"><Activity className="h-5 w-5" /></div>
            <div><h1 className="font-display text-base font-bold sm:text-lg">Upsight Scanner</h1><p className="text-[9px] uppercase tracking-[0.22em] text-slate-400">Evidence-Backed Audits</p></div>
          </button>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto rounded-xl border border-neutral-border bg-[#0c1016] p-1 text-xs sm:order-none sm:w-auto">
            {([['audits', 'Audits', Database], ['quality', 'Quality', BarChart3], ['review', 'Review Queue', FileSearch], ['proxy', 'Access & Proxy', Gauge]] as const).map(([key, label, Icon]) => (
              <button key={key} type="button" onClick={() => setView(key)} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 transition ${view === key ? 'bg-primary/15 text-primary shadow-sm' : 'text-slate-400 hover:bg-white/[0.03] hover:text-white'}`}><Icon className="h-3.5 w-3.5" />{label}</button>
            ))}
          </nav>
          <details className="relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-neutral-border px-3 py-2 text-xs text-slate-400 transition hover:border-slate-600 hover:text-white"><Settings2 className="h-3.5 w-3.5" />Connection</summary>
            <div className="absolute right-0 top-11 z-40 w-80 rounded-xl border border-neutral-border bg-bg-card p-4 shadow-2xl">
              <div className="flex items-center gap-2 text-xs font-semibold text-white"><ShieldCheck className="h-4 w-4 text-primary" />Internal API Access</div>
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400">Only required when INTERNAL_API_TOKEN is configured on the server.</p>
              <input type="password" value={token} onChange={(event) => saveToken(event.target.value)} placeholder="Internal API token" className="mt-3 w-full rounded-lg border border-neutral-border bg-[#0d1016] px-3 py-2.5 text-xs text-white outline-none focus:border-primary" autoComplete="off" />
            </div>
          </details>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        {error && <div className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-rose-900/70 bg-rose-950/30 px-4 py-3 text-sm text-rose-300"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X className="h-4 w-4" /></button></div>}

        {view === 'audits' && <div className="space-y-5">
          <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div><div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Audit Workspace</div><h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Scan, Verify, Improve</h2><p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-400">Run a lean audit by default, preserve deeper evidence when debugging, and turn confirmed mistakes into replayable QA data.</p></div>
            <div className="grid grid-cols-4 gap-2 lg:w-[500px]"><MetricCard label="Stored" value={scans.length} /><MetricCard label="Active" value={scanSummary.active} /><MetricCard label="Failed" value={scanSummary.failed} tone={scanSummary.failed ? 'danger' : 'default'} /><MetricCard label="Review" value={scanSummary.review} tone={scanSummary.review ? 'warning' : 'default'} /></div>
          </section>

          <section className="rounded-2xl border border-neutral-border bg-bg-card p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-white">New Audit</h3><p className="mt-1 text-[11px] text-slate-400">One PDP per domain. Bulk runs use bounded concurrency and one proxy retry.</p></div><div className="flex rounded-lg border border-neutral-border bg-[#0d1016] p-1 text-xs"><button type="button" onClick={() => setMode('single')} className={`rounded-md px-3 py-1.5 ${mode === 'single' ? 'bg-primary/15 text-primary' : 'text-slate-400 hover:text-white'}`}>Single</button><button type="button" onClick={() => setMode('bulk')} className={`rounded-md px-3 py-1.5 ${mode === 'bulk' ? 'bg-primary/15 text-primary' : 'text-slate-400 hover:text-white'}`}>Bulk CSV</button></div></div>
            <div className="grid gap-3 lg:grid-cols-[2fr_110px_170px_1fr_auto]">
              {mode === 'single' ? <div className="relative"><Globe2 className="absolute left-3 top-3 h-4 w-4 text-slate-600" /><input value={domain} onChange={(event) => setDomain(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && domain && !busy) void startScan(); }} placeholder="storefront.example" className="w-full rounded-lg border border-neutral-border bg-[#0d1016] py-2.5 pl-10 pr-3 text-sm outline-none transition focus:border-primary" /></div> : <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-neutral-border bg-[#0d1016] px-3 py-2.5 text-xs text-slate-400 hover:border-primary/50"><Upload className="h-4 w-4" />{csv?.name || 'Choose CSV with domain column'}<input type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => setCsv(event.target.files?.[0] || null)} /></label>}
              <select aria-label="Audit geo" value={geo} onChange={(event) => setGeo(event.target.value as typeof geo)} className="rounded-lg border border-neutral-border bg-[#0d1016] px-3 text-xs"><option>USA</option><option>EU</option><option>UK</option></select>
              <select aria-label="Scan mode" value={scanMode} onChange={(event) => setScanMode(event.target.value as typeof scanMode)} className="rounded-lg border border-neutral-border bg-[#0d1016] px-3 text-xs"><option value="normal">Normal · lean</option><option value="diagnostic">Diagnostic · more evidence</option></select>
              <input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="Optional group label" className="rounded-lg border border-neutral-border bg-[#0d1016] px-3 text-xs outline-none transition focus:border-primary" />
              <button type="button" disabled={busy || (mode === 'single' ? !domain : !csv)} onClick={() => void startScan()} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-xs font-black uppercase tracking-wider text-[#07120f] shadow-lg shadow-primary/10 transition hover:bg-primary-hover hover:shadow-primary/20 disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run audit</button>
            </div>
            <fieldset className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-300"><legend className="mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Modules</legend>{([['consent', 'Consent'], ['tracking', 'Tracking'], ['server_side', 'Server-side']] as const).map(([module, label]) => <label key={module} className="flex items-center gap-1.5"><input type="checkbox" checked={selectedModules.includes(module)} onChange={(event) => setSelectedModules((current) => event.target.checked ? [...current, module] : current.filter((item) => item !== module))} />{label}</label>)}</fieldset>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[10px] text-slate-400"><span>{scanMode === 'normal' ? 'Normal mode captures the bounded evidence needed for routine and bulk audits.' : 'Diagnostic mode keeps extra request summaries, DOM/CMP signals, timings, and screenshots.'}</span>{mode === 'single' && <label className="flex items-center gap-2"><input type="checkbox" checked={captcha} onChange={(event) => setCaptcha(event.target.checked)} />Allow one challenge-solving retry</label>}</div>
          </section>

          <div className="grid items-start gap-5 lg:grid-cols-[minmax(360px,.78fr)_minmax(0,1.22fr)]">
            <section className="overflow-hidden rounded-2xl border border-neutral-border bg-bg-card shadow-sm lg:sticky lg:top-24">
              <div className="border-b border-neutral-border p-4">
                <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-600" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search domain, CMS, group or fingerprint" className="w-full rounded-lg border border-neutral-border bg-[#0d1016] py-2 pl-9 pr-10 text-xs outline-none transition focus:border-primary" /><button type="button" onClick={() => void loadScans()} aria-label="Refresh audits" className="absolute right-1.5 top-1.5 rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-white"><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /></button></div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex gap-1 overflow-x-auto">{([['all', 'All'], ['review', 'Needs review'], ['failed', 'Failed'], ['timeout', 'Timeout'], ['proxy', 'Proxy'], ['access', 'Access'], ['runtime', 'Runtime'], ['fallback_candidate', 'Fallback candidate'], ['bot_unresolved', 'Bot unresolved'], ['rate_limited', 'Rate-limited'], ['fallback_recovered', 'Fallback recovered'], ['active', 'Active']] as const).map(([key, label]) => <button type="button" key={key} onClick={() => setAuditFilter(key)} className={`shrink-0 rounded-full px-3 py-1.5 text-[10px] font-semibold transition ${auditFilter === key ? 'bg-primary/15 text-primary' : 'text-slate-500 hover:bg-white/[0.04] hover:text-white'}`}>{label}</button>)}</div>
                  <label className="inline-flex items-center gap-2 text-[10px] font-semibold text-slate-400"><input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFilteredAudits} className="h-3.5 w-3.5 accent-primary" />Select Visible</label>
                </div>
                {selectedAuditIds.size > 0 && <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/[0.06] px-3 py-2">
                  <span className="text-[10px] font-bold text-primary">{selectedAuditIds.size} Selected</span>
                  <div className="flex items-center gap-1.5">
                    <ExplainedAction help="Create a new audit for every selected row, preserving each audit's geo, scan mode, selected modules, and group label." type="button" disabled={busy} onClick={() => void bulkRerunSelected()} className="border-primary/35 px-2.5 text-primary hover:bg-primary/10"><RotateCcw className="h-3.5 w-3.5" />Re-run</ExplainedAction>
                    <ExplainedAction help="Permanently delete all selected audit records and their associated QA feedback." type="button" disabled={busy} onClick={() => void bulkDeleteSelected()} className="border-rose-900/60 px-2.5 text-rose-300 hover:bg-rose-950/30"><Trash2 className="h-3.5 w-3.5" />Delete</ExplainedAction>
                  </div>
                </div>}
              </div>
              <div className="max-h-[760px] overflow-auto p-2">
                {filteredScans.map((scan) => <article key={scan.audit_id} onClick={() => setSelectedId(scan.audit_id)} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(scan.audit_id); }} role="button" tabIndex={0} className={`mb-1 w-full cursor-pointer rounded-xl border p-3 text-left transition last:mb-0 ${String(selectedId) === String(scan.audit_id) ? 'border-primary/40 bg-primary/[0.07]' : selectedAuditIds.has(String(scan.audit_id)) ? 'border-primary/20 bg-primary/[0.035]' : 'border-transparent hover:border-neutral-border hover:bg-white/[0.025]'}`}><div className="flex items-start gap-3"><input type="checkbox" aria-label={`Select audit ${scan.audit_id}`} checked={selectedAuditIds.has(String(scan.audit_id))} onClick={(event) => event.stopPropagation()} onChange={() => toggleAuditSelection(scan.audit_id)} className="mt-1 h-4 w-4 shrink-0 accent-primary" /><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><a href={websiteUrl(scan.domain)} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="group/link inline-flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-white hover:text-primary hover:underline">{scan.domain}<ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition group-hover/link:opacity-100" /></a><div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-slate-400"><span>#{scan.audit_id}</span><span>·</span><span>{scan.tested_geos}</span><span>·</span><span>{scan.cms_platform_detected || 'Unknown CMS'}</span></div>{scan.group_label && <div className="mt-2 inline-flex max-w-full rounded-md border border-violet-800/35 bg-violet-950/20 px-2 py-1 text-[9px] font-medium text-violet-300"><span className="truncate">Group: {scan.group_label}</span></div>}</div><ChevronRight className={`mt-1 h-4 w-4 shrink-0 ${String(selectedId) === String(scan.audit_id) ? 'text-primary' : 'text-slate-500'}`} /></div><div className="mt-3 flex flex-wrap items-center gap-2"><StatusBadge value={scan.scan_status} /><StatusBadge value={scan.overall_status} />{(scan.qa_priority || 0) > 0 && <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[9px] font-bold text-amber-300">Review {scan.qa_priority}</span>}</div></div></div></article>)}
                {!filteredScans.length && <div className="p-10 text-center text-xs text-slate-600">No audits match this view.</div>}
              </div>
            </section>

            <div className="min-w-0 space-y-4">
              {selected ? <>
                <section className="rounded-2xl border border-neutral-border bg-bg-card p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><a href={websiteUrl(selected.domain)} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-2 text-xl font-bold tracking-tight text-white hover:text-primary hover:underline">{selected.domain}<ExternalLink className="h-4 w-4 opacity-50 transition group-hover:opacity-100" /></a><StatusBadge value={selected.scan_status} /></div><p className="mt-1.5 text-[11px] text-slate-400">Audit #{selected.audit_id} · {selected.scan_mode || 'normal'} mode · {selected.tested_geos} · {timeLabel(selected.scan_completed_at)}</p><p className="mt-1 text-[10px] text-slate-500">Modules: {(selected.selected_modules || ['consent', 'tracking', 'server_side']).join(' · ')}</p>{selected.group_label && <div className="mt-2 inline-flex rounded-md border border-violet-800/35 bg-violet-950/20 px-2.5 py-1 text-[10px] font-medium text-violet-300">Group: {selected.group_label}</div>}</div><div className="flex items-center gap-2"><span className="text-[9px] uppercase tracking-wider text-slate-400">Overall</span><StatusBadge value={selected.overall_status} /></div></div>
                  {selected.scan_status === 'failed' && (() => { const failure = terminalFailure(selected); const proxyFailure = selected.error_category === 'proxy_error'; return <div className={`mt-4 rounded-xl border px-3 py-3 ${proxyFailure ? 'border-amber-800/50 bg-amber-950/20' : 'border-rose-800/50 bg-rose-950/20'}`} role="status"><div className={`text-[9px] font-bold uppercase tracking-[0.14em] ${proxyFailure ? 'text-amber-300' : 'text-rose-300'}`}>{proxyFailure ? 'Operational infrastructure failure' : 'Scan failed'}</div><div className="mt-1 flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-white">Terminal phase: {failure.phase}</span><span className={`font-mono text-[10px] ${proxyFailure ? 'text-amber-200' : 'text-rose-200'}`} title={failure.reasonCode}>{formatLabel(failure.reasonCode)}</span></div>{proxyFailure && <p className="mt-1.5 text-[11px] text-amber-100">Proxy transport failed; no access or compliance conclusion was made.</p>}{failure.productPhase && <p className={`mt-1.5 text-[11px] ${proxyFailure ? 'text-amber-100' : 'text-rose-100'}`}>Homepage evidence completed; PDP/product module incomplete.</p>}</div>; })()}
                  {selected.evidence_bundle?.page.cross_domain_redirect_accepted && selected.evidence_bundle.page.observed_domain && <div className="mt-4 rounded-xl border border-sky-800/45 bg-sky-950/20 px-3 py-3 text-[11px] text-sky-100" role="status"><span className="font-semibold">Accepted storefront redirect:</span> {selected.domain} was audited at {selected.evidence_bundle.page.observed_domain}.</div>}
                  {selected.evidence_bundle?.access && (() => { const access = selected.evidence_bundle.access; return <details className="group mt-4 rounded-xl border border-neutral-border-muted bg-[#10141c] p-3"><summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 [&::-webkit-details-marker]:hidden"><div><div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Access & runtime</div><div className="mt-1 text-xs font-semibold text-white">{accessStateLabel(selected)}</div></div><div className="flex items-center gap-2"><StatusBadge value={access.valid_storefront === true ? 'valid storefront reached' : access.valid_storefront === false ? 'storefront not reached' : 'inconclusive'} /><ChevronRight aria-hidden="true" className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-90" /></div></summary><div className="mt-3 grid gap-2 text-[10px] sm:grid-cols-2 xl:grid-cols-4"><div><span className="text-slate-500">Initial provider</span><p className="mt-0.5 text-slate-300">{proxyLabel(access.initial_provider)}</p></div><div><span className="text-slate-500">Final provider</span><p className="mt-0.5 text-slate-300">{proxyLabel(access.final_provider, access.initial_provider === 'decodo' && access.final_provider === 'decodo' && access.access_attempt_count > 1)}</p></div><div><span className="text-slate-500">Retries</span><p className="mt-0.5 text-slate-300">{Math.max(0, access.access_attempt_count - 1)}</p></div><div><span className="text-slate-500">Access duration</span><p className="mt-0.5 text-slate-300">{formatDuration(access.time_to_valid_storefront_ms)}</p></div><div><span className="text-slate-500">Browserless fallback</span><p className="mt-0.5"><StatusBadge value={access.proxy_fallback_used ? access.proxy_fallback_recovered ? 'recovered' : 'used' : 'not used'} /></p></div><div><span className="text-slate-500">Challenge</span><p className="mt-0.5"><StatusBadge value={access.challenge_detected ? access.challenge_type || 'unknown challenge' : 'not detected'} /></p></div><div><span className="text-slate-500">Solver</span><p className="mt-0.5"><StatusBadge value={access.challenge_solver_used ? access.challenge_solver_result : 'not used'} /></p></div><div><span className="text-slate-500">HTTP</span><p className="mt-0.5 text-slate-300">{access.http_status ?? '—'}</p></div></div></details>; })()}
                  <div className="mt-5 flex flex-wrap gap-2">
                    {ACTIVE_STATUSES.has(selected.scan_status) && <button type="button" onClick={() => void selectedAction('cancel')} className="action-button border-amber-800/60 text-amber-300"><Square className="h-3.5 w-3.5" />Cancel</button>}
                    <ExplainedAction type="button" help="Creates a new diagnostic audit for this domain and geo, preserving the selected modules. It retains more bounded evidence and screenshots, and does not enable challenge escalation." onClick={async () => { const result = await selectedAction('diagnostic-rerun'); if (result?.audit_id) setSelectedId(result.audit_id); }} className="border-primary/40 text-primary hover:bg-primary/10"><Bug className="h-3.5 w-3.5" />Re-run diagnostic</ExplainedAction>
                    <ExplainedAction type="button" help="Creates a manual diagnostic audit with the same selected modules and configured CAPTCHA or challenge retry. Use this for high-value blocked sites, not routine bulk scanning." onClick={async () => { const result = await selectedAction('difficult-site-rerun'); if (result?.audit_id) setSelectedId(result.audit_id); }} className="border-violet-700/70 text-violet-300 hover:bg-violet-950/30"><FlaskConical className="h-3.5 w-3.5" />Re-run difficult site</ExplainedAction>
                    <ExplainedAction type="button" help="Downloads a sanitized ZIP containing the audit result, evidence, request summaries, trace, detector evidence, version data, and diagnostic screenshots when available." onClick={() => void exportDebug()} className="border-neutral-border text-slate-300 hover:bg-white/[0.04]"><Download className="h-3.5 w-3.5" />Export debug</ExplainedAction>
                    <ExplainedAction type="button" help="Does not visit the website. It runs the current detector rules against this audit's stored Evidence Bundle and shows any changed findings." onClick={async () => setAnalysis({ kind: 'replay', data: await selectedAction('replay') })} className="border-neutral-border text-slate-300 hover:bg-white/[0.04]"><RotateCcw className="h-3.5 w-3.5" />Replay</ExplainedAction>
                    <ExplainedAction type="button" help="Does not run a scan. It checks stored evidence and lifecycle guardrails, explains likely root causes, and suggests a shared patch plan and regression tests." onClick={async () => setAnalysis({ kind: 'review', data: await selectedAction('review') })} className="border-neutral-border text-slate-300 hover:bg-white/[0.04]"><CircleHelp className="h-3.5 w-3.5" />Audit reviewer</ExplainedAction>
                    <button type="button" onClick={() => void deleteSelected()} aria-label="Delete selected audit" className="action-button ml-auto border-rose-900/60 px-2.5 text-rose-400 hover:bg-rose-950/30"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </section>

                <section className="rounded-2xl border border-neutral-border bg-bg-card p-4 shadow-sm"><div className="mb-4 flex items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-white">Audit Findings</h3><p className="mt-1 text-[11px] text-slate-400">Evidence-based statuses. “Not tested” means the module did not run; “inconclusive” means it ran without enough evidence.</p></div><span className="text-[10px] uppercase tracking-wider text-slate-400">{selected.overall_confidence || '—'} confidence</span></div><div className="grid gap-3 xl:grid-cols-2">
                  <Finding title="CMS Platform" description="Platform inferred from page, script, and storefront signals." value={selected.cms_platform_detected} confidence={selected.finding_confidence?.cms} />
                  <Finding title="Consent Manager (CMP)" description={selected.cmp_provider === 'Not Found' ? 'No CMP detected during this scan.' : 'Provider identified from combined DOM, network, cookie, global, or iframe evidence.'} value={selected.cmp_provider} confidence={selected.finding_confidence?.cmp} />
                  <Finding title="Consent Behavior" description="Observed tracking behavior around consent interaction; this is not a legal-compliance determination." value={selected.consent_status} confidence={selected.finding_confidence?.consent} />
                  <Finding title="GA4 Installed" description={(selected.site_ga4_measurement_ids || []).length ? `Measurement ID${selected.site_ga4_measurement_ids!.length > 1 ? 's' : ''}: ${selected.site_ga4_measurement_ids!.join(', ')}` : 'Installation evidence is evaluated separately from collection and ecommerce events.'} value={ga4InstallationStatus(selected)} confidence={selected.finding_confidence?.ga4} />
                  <Finding title="GA4 Collection Observed" description={ga4InstallationStatus(selected) === 'detected' ? 'Installation evidence was found; this reports whether a qualifying GA4 collection hit was observed.' : 'No installation evidence was retained for this audit.'} value={boolStatus(selected.site_ga4_collection_hit_detected)} confidence={selected.finding_confidence?.ga4} />
                  <Finding title="GA4 view_item Observed" description={selected.pdp_url_tested ? <a href={selected.pdp_url_tested} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">{selected.pdp_url_tested}<ExternalLink className="h-3 w-3 shrink-0" /></a> : 'No PDP URL was successfully tested.'} value={selected.product_payload_status} confidence={selected.finding_confidence?.product} />
                  <Finding title="Meta Pixel" description={selected.site_meta_collection_hit_detected ? 'Meta Pixel installation and collection were observed.' : selected.site_meta_detected ? 'Meta Pixel installation was detected from script evidence; no collection hit was observed in this scan.' : 'No Meta Pixel installation evidence was observed.'} value={boolStatus(selected.site_meta_detected)} confidence={selected.finding_confidence?.meta} />
                  <Finding title="Server-Side / First-Party Collection" description={`Collection topology: ${formatLabel(selected.ss_collection_type || 'not tested')}.`} value={selected.server_side_status} confidence={selected.finding_confidence?.server_side} />
                </div></section>

                <section className="rounded-2xl border border-neutral-border bg-bg-card p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-white">Evidence Summary</h3><p className="mt-1 text-[11px] text-slate-400">Compact operational context and machine-readable reason codes.</p></div>{selected.evidence_bundle?.product.pdp_url && <a href={selected.evidence_bundle.product.pdp_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">Open Tested PDP<ExternalLink className="h-3 w-3" /></a>}</div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-6"><MetricCard compact label="Requests" value={selected.evidence_bundle?.network.total_requests ?? '—'} /><MetricCard compact label="Duration" value={formatDuration(selected.evidence_bundle?.runtime.total_duration_ms)} /><MetricCard compact label="Evidence" value={selected.evidence_bundle ? `${Math.round(selected.evidence_bundle.runtime.evidence_size_bytes / 1024)} KB` : '—'} /><MetricCard compact label="Proxy retries" value={selected.evidence_bundle?.runtime.proxy_retry_count ?? '—'} /><MetricCard compact label="Proxy country" value={selected.evidence_bundle?.runtime.proxy_country || 'unverified'} /><MetricCard compact label="Challenge" value={selected.evidence_bundle?.page.challenge_cleared ? 'cleared' : selected.evidence_bundle?.page.bot_provider ? 'not cleared' : 'none seen'} /></div>
                  {selected.evidence_bundle && <details className="mt-4 rounded-xl border border-neutral-border-muted bg-[#10141c] p-3"><summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-slate-400">Diagnostics & health</summary><div className="mt-3 grid gap-3 text-[11px] text-slate-300 sm:grid-cols-2"><div><div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Build</div><p className="mt-1.5">Scanner {selected.evidence_bundle.scanner_version} · Rule pack {selected.evidence_bundle.rule_pack_version}</p><p className="mt-1 text-slate-500">Build {selected.evidence_bundle.build_commit || 'local'} · {selected.evidence_bundle.build_timestamp}</p></div>{selected.evidence_bundle.mode === 'diagnostic' && <div><div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Access attempts</div>{selected.evidence_bundle.access.proxy_attempts.length ? <ol className="mt-2 space-y-2">{selected.evidence_bundle.access.proxy_attempts.map((attempt) => <li key={`${attempt.provider}-${attempt.attempt}`} className="rounded-md border border-neutral-border-muted bg-[#0d1016] px-2.5 py-2 text-[10px]"><span className="font-semibold text-white">Attempt {attempt.attempt + 1}</span><span className="mx-1 text-slate-600">·</span><span>{proxyLabel(attempt.provider, attempt.provider === 'decodo' && attempt.attempt > 0)}{attempt.port !== null ? ` / port ${attempt.port}` : ''}</span><span className="mx-1 text-slate-600">→</span><span className="text-slate-400">{accessAttemptResult(attempt)}</span></li>)}</ol> : <p className="mt-1.5 text-slate-500">No access-attempt telemetry was retained.</p>}</div>}</div></details>}
                  {selected.evidence_bundle && (() => {
                    const candidate = selected.evidence_bundle.product.candidate_url || selected.evidence_bundle.product.pdp_candidates[0] || null;
                    const finalPdp = selected.evidence_bundle.product.final_pdp_url || selected.evidence_bundle.product.pdp_url || selected.pdp_url_tested;
                    const trackingEnablement = selected.evidence_bundle.consent.tracking_enablement;
                    return <div className="mt-4 grid gap-3 rounded-xl border border-neutral-border-muted bg-[#10141c] p-3 text-[11px] sm:grid-cols-2">
                      <div><div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">PDP navigation</div><div className="mt-1.5 space-y-1.5 text-slate-300"><div>Candidate: {candidate ? <a href={candidate} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">{candidate}</a> : '—'}</div><div>Final: {finalPdp ? <a href={finalPdp} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">{finalPdp}</a> : '—'}</div>{candidate && finalPdp && candidate !== finalPdp && <p className="text-sky-200">Candidate redirected or resolved to the final PDP above.</p>}</div></div>
                      {trackingEnablement && <div><div className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Tracking enablement</div><div className="mt-1.5 text-slate-300"><StatusBadge value={trackingEnablement} /><p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">Operational CMP state used to enable Tracking when needed; it is not a Consent audit finding.</p></div></div>}
                    </div>;
                  })()}
                  <div className="mt-4 grid gap-4 rounded-xl border border-neutral-border-muted bg-[#10141c] p-3 sm:grid-cols-2">
                    <EvidenceCodeGroup title="Decision Reasons" codes={uniqueCodes(selected.reason_codes)} tone="decision" />
                    <EvidenceCodeGroup title="Review Triggers" codes={uniqueCodes(selected.qa_priority_signals?.map((signal) => signal.code))} tone="review" />
                    <EvidenceCodeGroup title="Failure Fingerprints" codes={uniqueCodes(selected.failure_fingerprints)} tone="fingerprint" />
                    <EvidenceCodeGroup title="Consistency Issues" codes={uniqueCodes(selected.consistency_violations)} tone="issue" />
                    {!(selected.reason_codes?.length || selected.qa_priority_signals?.length || selected.failure_fingerprints?.length || selected.consistency_violations?.length) && <span className="text-[11px] text-slate-500">No decision, review, failure, or consistency codes were stored for this audit.</span>}
                  </div>
                </section>

                <section className="rounded-2xl border border-neutral-border bg-bg-card p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-bold text-white">Verify a Finding</h3><p className="mt-1 text-[11px] text-slate-400">Confirm one specific finding at a time. Saved responses appear in the Review Queue and contribute to Quality metrics.</p></div><div className="flex gap-2"><button type="button" disabled={Boolean(qaSubmitting)} onClick={() => void submitFeedback('correct')} className="action-button border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/30 disabled:opacity-50">{qaSubmitting === 'correct' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{qaSubmitting === 'correct' ? 'Recording…' : 'Correct'}</button><button type="button" disabled={Boolean(qaSubmitting)} onClick={() => setQaCorrectionOpen(!qaCorrectionOpen)} className="action-button border-rose-900/60 text-rose-300 hover:bg-rose-950/30 disabled:opacity-50">Incorrect</button></div></div>
                  <div className="mt-4 grid items-center gap-3 sm:grid-cols-[minmax(180px,260px)_1fr]"><select value={qaCategory} disabled={Boolean(qaSubmitting)} onChange={(event) => { setQaCategory(event.target.value as QaFeedback['category']); setQaExpected(''); setQaSaved(null); }} className="rounded-lg border border-neutral-border bg-[#0d1016] px-3 py-2.5 text-xs">{QA_CATEGORIES.map((category) => <option key={category} value={category}>{formatLabel(category)}</option>)}</select><div className="rounded-lg border border-neutral-border-muted bg-[#10141c] px-3 py-2.5 text-[11px]"><span className="text-slate-400">Scanner Says:</span> <span className="ml-2 font-semibold text-white">{formatLabel(currentFindingValue(selected, qaCategory))}</span></div></div>
                  {qaCorrectionOpen && <div className="mt-3 grid gap-2 rounded-xl border border-rose-900/30 bg-rose-950/10 p-3"><input value={qaExpected} disabled={Boolean(qaSubmitting)} onChange={(event) => setQaExpected(event.target.value)} placeholder="Expected / corrected value" className="rounded-lg border border-neutral-border bg-[#0d1016] px-3 py-2.5 text-xs" /><textarea value={qaNotes} disabled={Boolean(qaSubmitting)} onChange={(event) => setQaNotes(event.target.value)} placeholder="Why is this incorrect? Optional, but useful for the regression fixture." className="min-h-20 rounded-lg border border-neutral-border bg-[#0d1016] px-3 py-2.5 text-xs" /><button type="button" disabled={!qaExpected.trim() || Boolean(qaSubmitting)} onClick={() => void submitFeedback('incorrect')} className="inline-flex items-center gap-2 justify-self-start rounded-lg bg-rose-700 px-4 py-2.5 text-xs font-bold text-white transition hover:bg-rose-600 disabled:opacity-40">{qaSubmitting === 'incorrect' && <Loader2 className="h-4 w-4 animate-spin" />}{qaSubmitting === 'incorrect' ? 'Recording Feedback…' : 'Save Correction'}</button></div>}
                  {qaSaved && <div role="status" className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/25 px-3 py-2.5 text-[11px] font-medium text-emerald-300"><CheckCircle2 className="h-4 w-4 shrink-0" />{qaSaved}</div>}
                  {(selected.qa_feedback || []).length > 0 && <div className="mt-4 border-t border-neutral-border-muted pt-3"><div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Recent Verification</div><div className="mt-2 grid gap-2 sm:grid-cols-2">{selected.qa_feedback!.slice(0, 4).map((feedback, index) => <div key={`${feedback.created_at}-${index}`} className="rounded-md border border-neutral-border-muted bg-[#10141c] px-3 py-2 text-[10px] text-slate-300"><div className="flex items-center justify-between gap-2"><b>{formatLabel(feedback.category)}</b><span className={feedback.verdict === 'correct' ? 'text-emerald-300' : 'text-rose-300'}>{formatLabel(feedback.verdict)}</span></div>{feedback.expected_value && <div className="mt-1 text-slate-400">Expected: {feedback.expected_value}</div>}</div>)}</div></div>}
                </section>

                {analysis && analysis.data && <AnalysisPanel result={analysis} onClose={() => setAnalysis(null)} />}
                <TraceTimeline trace={selected.trace_steps} />
              </> : <div className="rounded-2xl border border-dashed border-neutral-border bg-bg-card p-16 text-center"><Database className="mx-auto h-7 w-7 text-slate-700" /><p className="mt-3 text-xs text-slate-600">Select an audit to inspect its findings and evidence.</p></div>}
            </div>
          </div>
        </div>}

        {view === 'quality' && <section className="space-y-4"><div><div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Accuracy System</div><h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Quality & Improvement Analytics</h2><p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">Operational metrics use stored audits. Precision and accuracy use only human-verified findings, so they remain honest when ground truth is sparse.</p></div>{!quality ? <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div> : <QualityDashboard quality={quality} onOpenAudit={openAudit} />}</section>}

        {view === 'review' && <section className="space-y-5">
          <div><div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">QA Work Queue</div><h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Review Queue</h2><p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">One latest audit per website, ordered by human corrections and transparent review-priority signals.</p></div>
          <div className="grid gap-2 sm:grid-cols-3"><MetricCard label="Unique Websites" value={reviewCandidates.length} /><MetricCard label="High Priority" value={reviewCandidates.filter((scan) => (scan.qa_priority || 0) >= 50).length} tone="danger" /><MetricCard label="With Feedback" value={reviewCandidates.filter((scan) => (scan.qa_feedback || []).length).length} tone="warning" /></div>
          <div className="rounded-2xl border border-neutral-border bg-bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative w-full max-w-xl"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" /><input value={reviewSearch} onChange={(event) => setReviewSearch(event.target.value)} placeholder="Search website, CMS, CMP, review signal, or feedback" className="w-full rounded-lg border border-neutral-border bg-[#0d1016] py-2 pl-9 pr-3 text-xs text-white outline-none focus:border-primary" /></div><span className="text-[10px] text-slate-400">{filteredReviewCandidates.length} of {reviewCandidates.length} Websites</span></div>
          </div>
          <div className="overflow-x-auto pb-2">
            <table className="w-full min-w-[1180px] border-separate border-spacing-y-2 text-left text-xs">
              <thead className="text-[9px] uppercase tracking-[0.14em] text-slate-400"><tr><th className="px-5 py-2">Website</th><th className="px-5 py-2">Latest Findings</th><th className="px-5 py-2">Review Priority</th><th className="px-5 py-2">Reviewer Feedback</th><th className="px-5 py-2 text-right">Actions</th></tr></thead>
              <tbody>{filteredReviewCandidates.map((scan) => {
                const feedback = (scan.qa_feedback || [])[0];
                return <tr key={scan.domain.replace(/^www\./, '')} className="group align-top shadow-sm">
                  <td className="w-[22%] rounded-l-xl border-y border-l border-neutral-border bg-bg-card p-5 transition group-hover:border-slate-600 group-hover:bg-bg-card-hover/50">
                    <a href={websiteUrl(scan.domain)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-bold text-white hover:text-primary hover:underline">{scan.domain}<ExternalLink className="h-3 w-3 opacity-55" /></a>
                    <div className="mt-2 text-[10px] leading-relaxed text-slate-400">Audit #{scan.audit_id}<br />{timeLabel(scan.scan_started_at)}</div>
                    <div className="mt-3 flex flex-wrap gap-1.5"><StatusBadge value={scan.scan_status} />{scan.group_label && <span className="max-w-44 truncate rounded border border-violet-800/35 bg-violet-950/20 px-2 py-1 text-[9px] text-violet-300" title={scan.group_label}>{scan.group_label}</span>}</div>
                  </td>
                  <td className="w-[26%] border-y border-neutral-border bg-bg-card p-5 transition group-hover:border-slate-600 group-hover:bg-bg-card-hover/50">
                    <div className="grid grid-cols-[54px_1fr] items-center gap-x-3 gap-y-2.5 text-[10px]"><span className="text-slate-500">CMS</span><StatusBadge value={scan.cms_platform_detected} /><span className="text-slate-500">CMP</span><StatusBadge value={scan.cmp_provider} /><span className="text-slate-500">GA4</span><StatusBadge value={boolStatus(scan.site_ga4_detected)} /><span className="text-slate-500">Meta</span><StatusBadge value={boolStatus(scan.site_meta_detected)} /><span className="text-slate-500">PDP</span><StatusBadge value={scan.product_payload_status} /></div>
                  </td>
                  <td className="w-[24%] border-y border-neutral-border bg-bg-card p-5 transition group-hover:border-slate-600 group-hover:bg-bg-card-hover/50">
                    <div className="flex items-center gap-3"><div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-lg font-black ${(scan.qa_priority || 0) >= 50 ? 'border-rose-800/60 bg-rose-950/30 text-rose-300' : 'border-amber-800/50 bg-amber-950/20 text-amber-300'}`}>{scan.qa_priority || 0}</div><div><div className="text-[10px] font-bold text-white">Priority Points</div><div className="mt-1"><StatusBadge value={scan.overall_confidence} /></div></div></div>
                    <div className="mt-3 space-y-1.5">{(scan.qa_priority_signals || []).slice(0, 4).map((signal) => <div key={signal.code} title={signal.code} className="flex items-start justify-between gap-3 rounded-md bg-[#0e1219] px-2.5 py-2 text-[9px]"><span className="leading-snug text-slate-300">{signal.label}</span><b className="shrink-0 text-amber-300">+{signal.points}</b></div>)}{!(scan.qa_priority_signals || []).length && <span className="text-[10px] text-slate-500">No current scoring signal.</span>}</div>
                  </td>
                  <td className="w-[20%] border-y border-neutral-border bg-bg-card p-5 transition group-hover:border-slate-600 group-hover:bg-bg-card-hover/50">
                    {feedback ? <div className={`rounded-lg border p-3 ${feedback.verdict === 'incorrect' ? 'border-rose-900/45 bg-rose-950/15' : 'border-emerald-900/40 bg-emerald-950/15'}`}><div className="flex items-center justify-between gap-2"><b className="text-[10px] text-white">{formatLabel(feedback.category)}</b><span className={feedback.verdict === 'incorrect' ? 'text-[9px] font-bold text-rose-300' : 'text-[9px] font-bold text-emerald-300'}>{formatLabel(feedback.verdict)}</span></div>{feedback.expected_value && <p className="mt-2 text-[10px] text-slate-300">Expected: {feedback.expected_value}</p>}{feedback.notes && <p className="mt-1 line-clamp-3 text-[9px] leading-relaxed text-slate-400">{feedback.notes}</p>}</div> : <div className="rounded-lg border border-dashed border-neutral-border px-3 py-4 text-center text-[10px] text-slate-500">Awaiting Review</div>}
                  </td>
                  <td className="w-[8%] rounded-r-xl border-y border-r border-neutral-border bg-bg-card p-5 transition group-hover:border-slate-600 group-hover:bg-bg-card-hover/50"><div className="flex flex-col items-end gap-2"><button type="button" onClick={() => openAudit(scan.audit_id)} className="action-button border-primary/30 text-primary hover:bg-primary/10">Review <ChevronRight className="h-3.5 w-3.5" /></button><ExplainedAction help="Confirm this latest audit is accurate, remove it from the Review Queue, and resolve its Quality-page priority." type="button" onClick={() => void markAuditCorrect(scan)} disabled={markingCorrectId !== null} className="whitespace-nowrap border-emerald-700/50 text-emerald-300 hover:bg-emerald-950/40 disabled:cursor-wait disabled:opacity-60">{String(markingCorrectId) === String(scan.audit_id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Correct</ExplainedAction></div></td>
                </tr>;
              })}</tbody>
            </table>
            {!filteredReviewCandidates.length && <div className="rounded-xl border border-dashed border-neutral-border bg-bg-card p-12 text-center text-xs text-slate-400">No websites match this search.</div>}
          </div>
        </section>}

        {view === 'proxy' && <section className="space-y-5"><div><div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Scanner Operations</div><h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Access & Proxy Health</h2><p className="mt-2 max-w-3xl text-xs leading-relaxed text-slate-400">Understand Browserless readiness, Decodo geo/port performance, retry recovery, queue load, and quarantined gateways without exposing credentials.</p></div>{!proxyMetrics || !accessReadiness || !queueMetrics ? <div className="flex h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div> : <ProxyDashboard metrics={proxyMetrics} readiness={accessReadiness} queue={queueMetrics} />}</section>}
      </main>
    </div>
  );
}
