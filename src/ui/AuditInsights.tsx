import { CheckCircle2, CircleDot, FlaskConical, GitCompareArrows, ListChecks, Wrench } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import { formatLabel } from './format';

export type AnalysisResult = { kind: 'review' | 'replay'; data: any };

function parseTrace(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  } catch {
    try {
      const normalized = value.includes('\\n') && !value.includes('\n') ? value.replace(/\\n/g, '\n') : value;
      return normalized.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [{ step: 'trace_parse_failed', detail: 'The stored trace could not be parsed.' }];
    }
  }
  return [];
}

function valueText(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function AnalysisPanel({ result, onClose }: { result: AnalysisResult; onClose: () => void }) {
  if (result.kind === 'replay') {
    const comparison = result.data?.comparison;
    const changes = comparison?.changes || [];
    return (
      <section className="rounded-xl border border-violet-800/40 bg-violet-950/10 p-4">
        <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-xs font-bold text-violet-200"><GitCompareArrows className="h-4 w-4" />Offline Replay Result</div><p className="mt-1 text-[11px] text-slate-400">Stored evidence was re-evaluated; no browser or live website was used.</p></div><button type="button" onClick={onClose} className="text-[10px] uppercase text-slate-400 hover:text-white">Close</button></div>
        {changes.length ? <div className="mt-4 space-y-2">{changes.map((change: any) => <div key={change.field} className="grid gap-2 rounded-lg border border-neutral-border-muted bg-[#10141c] p-3 text-xs sm:grid-cols-[1fr_auto_auto]"><span className="font-semibold text-white">{formatLabel(change.field)}</span><span className="text-slate-400"><s>{valueText(change.previous)}</s></span><span className="text-violet-300">→ {valueText(change.next)}</span></div>)}</div> : <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-800/30 bg-emerald-950/20 p-3 text-xs text-emerald-300"><CheckCircle2 className="h-4 w-4" />Current rule pack produces the same major findings.</div>}
      </section>
    );
  }

  const review = result.data || {};
  const violations = review.violations || [];
  return (
    <section className="rounded-xl border border-amber-800/40 bg-amber-950/10 p-4">
      <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-xs font-bold text-amber-200"><ListChecks className="h-4 w-4" />Audit Reviewer</div><p className="mt-1 text-[11px] text-slate-400">Deterministic diagnosis derived from evidence and lifecycle guardrails—not a second copy of the trace.</p></div><button type="button" onClick={onClose} className="text-[10px] uppercase text-slate-400 hover:text-white">Close</button></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-lg bg-[#10141c] p-3"><div className="text-[9px] uppercase tracking-wider text-slate-600">Classification</div><div className="mt-2 font-mono text-[11px] text-amber-300">{review.classification || '—'}</div></div><div className="rounded-lg bg-[#10141c] p-3"><div className="text-[9px] uppercase tracking-wider text-slate-600">Likely root cause</div><div className="mt-2 text-[11px] leading-relaxed text-slate-300">{review.likely_root_cause || '—'}</div></div></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div><div className="mb-2 text-[9px] font-bold uppercase tracking-wider text-slate-500">Guardrail violations</div>{violations.length ? <div className="space-y-2">{violations.map((violation: any) => <div key={violation.code} className="rounded-lg border border-rose-900/40 bg-rose-950/20 p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-rose-300">{violation.code}</span><StatusBadge value={violation.severity} /></div><p className="mt-2 text-[10px] leading-relaxed text-slate-500">{violation.explanation}</p></div>)}</div> : <p className="rounded-lg bg-[#10141c] p-3 text-[11px] text-emerald-300">No deterministic violations found.</p>}</div>
        <ReviewList title="Suggested patch plan" items={review.patch_plan} icon={Wrench} />
        <ReviewList title="Regression tests" items={review.regression_tests} icon={FlaskConical} empty="No new regression test suggested." />
      </div>
    </section>
  );
}

function ReviewList({ title, items = [], icon: Icon, empty = 'No suggestions.' }: { title: string; items?: string[]; icon: typeof Wrench; empty?: string }) {
  return <div><div className="mb-2 flex items-center gap-2 text-[9px] font-bold uppercase tracking-wider text-slate-500"><Icon className="h-3.5 w-3.5" />{title}</div><div className="space-y-2">{items.length ? items.map((item, index) => <div key={`${index}-${item}`} className="flex gap-2 rounded-lg bg-[#10141c] p-3 text-[10px] leading-relaxed text-slate-400"><span className="font-bold text-primary">{index + 1}</span><span>{item}</span></div>) : <p className="rounded-lg bg-[#10141c] p-3 text-[10px] text-slate-600">{empty}</p>}</div></div>;
}

export function TraceTimeline({ trace }: { trace: unknown }) {
  const steps = parseTrace(trace);
  return (
    <details className="rounded-xl border border-neutral-border bg-bg-card p-4">
      <summary className="cursor-pointer list-none text-xs font-bold text-white"><span className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><CircleDot className="h-4 w-4 text-primary" />Sanitized Trace Timeline</span><span className="text-[10px] font-normal text-slate-400">{steps.length} events · technical evidence</span></span></summary>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">Chronological runtime facts for debugging. Secrets and sensitive values are removed; the reviewer above interprets these facts.</p>
      <div className="mt-4 max-h-[520px] space-y-0 overflow-auto pr-2">
        {steps.map((step, index) => {
          const details = Object.entries(step).filter(([key]) => !['step', 'timestamp'].includes(key));
          return <div key={`${index}-${String(step.step)}`} className="relative ml-2 border-l border-slate-700 pb-4 pl-5 last:pb-0"><i className="absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full border-2 border-bg-card bg-primary" /><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[11px] font-semibold text-slate-100">{formatLabel(String(step.step || `event ${index + 1}`))}</span>{step.timestamp && <time className="text-[10px] font-medium text-slate-400">{new Date(String(step.timestamp)).toLocaleString()}</time>}</div>{details.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{details.slice(0, 10).map(([key, value]) => {
            const text = valueText(value);
            const isUrl = /url/i.test(key) && /^https?:\/\//i.test(text);
            return isUrl ? <a key={key} href={text} target="_blank" rel="noreferrer" title={text} className="max-w-full truncate rounded border border-primary/20 bg-[#0a1016] px-2 py-1.5 font-mono text-[10px] text-primary hover:border-primary/50 hover:underline"><b className="text-slate-400">{formatLabel(key)}:</b> {text}</a> : <span key={key} title={text} className="max-w-full truncate rounded border border-slate-800 bg-[#0a1016] px-2 py-1.5 font-mono text-[10px] text-slate-300"><b className="text-slate-400">{formatLabel(key)}:</b> {text}</span>;
          })}</div>}</div>;
        })}
        {!steps.length && <div className="rounded-lg border border-dashed border-neutral-border p-8 text-center text-xs text-slate-500">No trace events were stored.</div>}
      </div>
    </details>
  );
}
