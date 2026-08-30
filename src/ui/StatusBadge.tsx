import { formatLabel } from './format';

export function StatusBadge({ value }: { value: unknown }) {
  const text = value === null || value === undefined || value === '' ? 'not tested' : String(value);
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const recognizedDetection = new Set([
    'shopify', 'woocommerce', 'magento', 'bigcommerce', 'webflow', 'custom', 'onetrust', 'cookiebot',
    'didomi', 'usercentrics', 'cookieyes', 'osano', 'iubenda', 'trustarc', 'fides', 'quantcast',
    'iab tcf', 'shopify privacy'
  ]).has(normalized);
  const tone = normalized.includes('pdp not found') || normalized.includes('missing view item') ||
    normalized.includes('warning') || normalized.includes('partial')
    ? 'border-amber-700/60 bg-amber-950/60 text-amber-300'
    : normalized.includes('inconclusive') || normalized.includes('not tested') || normalized.includes('not detected') ||
      normalized.includes('not found') || normalized.includes('unknown') || normalized === 'none' || normalized === 'cancelled'
      ? 'border-slate-700 bg-slate-900 text-slate-300'
      : normalized.includes('fail') || normalized.includes('violation') || normalized.includes('leakage') ||
        normalized.includes('misconfigured') || normalized.includes('blocked') || normalized.includes('error') ||
        normalized.includes('rate limited') || normalized === 'low'
        ? 'border-rose-700/60 bg-rose-950/60 text-rose-300'
        : normalized.includes('pending') || normalized.includes('scanning') || normalized.includes('running')
          ? 'border-sky-700/60 bg-sky-950/60 text-sky-300'
          : recognizedDetection
            ? 'border-violet-700/60 bg-violet-950/60 text-violet-300'
            : normalized.includes('pass') || normalized.includes('completed') || normalized.includes('detected') ||
              normalized === 'correct' || normalized === 'healthy' || normalized === 'high'
              ? 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300'
              : normalized === 'medium' || normalized === 'watch'
                ? 'border-amber-700/60 bg-amber-950/60 text-amber-300'
                : 'border-slate-700 bg-slate-900 text-slate-300';
  return <span className={`inline-flex rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{formatLabel(text)}</span>;
}
