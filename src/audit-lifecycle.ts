import { selectedAuditModules } from './audit-modules';
import type { AuditModule, AuditProxyProvider, AuditQueueOptions, ErrorCategory, ScanMode, ScanStatus, StorefrontAudit } from './types';

export interface AuditQueueJob {
  audit_id: string | number;
  domain: string;
  enable_captcha_solving: boolean;
  is_bulk: boolean;
  scan_mode: ScanMode;
  selected_modules: AuditModule[];
  proxy_provider: AuditProxyProvider;
  available_at?: number;
}

export function normalizeQueueOptions(input?: Partial<AuditQueueOptions> | null): AuditQueueOptions {
  return {
    is_bulk: input?.is_bulk === true,
    enable_captcha_solving: input?.enable_captcha_solving === true,
    proxy_provider: input?.proxy_provider === 'browserless_residential' ? 'browserless_residential' : 'decodo'
  };
}

export function queueJobForAudit(
  audit: StorefrontAudit,
  options?: Partial<AuditQueueOptions>
): AuditQueueJob {
  const queueOptions = normalizeQueueOptions({ ...audit.queue_options, ...options });
  return {
    audit_id: audit.audit_id,
    domain: audit.domain,
    enable_captcha_solving: queueOptions.enable_captcha_solving,
    is_bulk: queueOptions.is_bulk,
    scan_mode: audit.scan_mode === 'diagnostic' ? 'diagnostic' : 'normal',
    selected_modules: selectedAuditModules(audit.selected_modules),
    proxy_provider: queueOptions.proxy_provider
  };
}

export function shouldEnqueueAudit(alreadyQueuedOrActive: boolean) {
  return !alreadyQueuedOrActive;
}

export function rerunAuditOptions(
  source: StorefrontAudit,
  mode: ScanMode = source.scan_mode === 'diagnostic' ? 'diagnostic' : 'normal',
  queueOverrides?: Partial<AuditQueueOptions>
) {
  return {
    domain: source.domain,
    tested_geos: source.tested_geos,
    group_label: source.group_label,
    scan_mode: mode,
    selected_modules: selectedAuditModules(source.selected_modules),
    queue_options: normalizeQueueOptions({ ...source.queue_options, ...queueOverrides })
  };
}

export function classifyAuditTermination(manuallyCancelled: boolean, timedOut: boolean): { category: ErrorCategory; scanStatus: ScanStatus } | null {
  if (manuallyCancelled) return { category: 'cancelled', scanStatus: 'cancelled' };
  if (timedOut) return { category: 'scan_timeout', scanStatus: 'failed' };
  return null;
}

export function isRecoverableStaleAudit(audit: StorefrontAudit, queuedOrActive: boolean, trace: Record<string, unknown>[]) {
  return audit.scan_status === 'scanning' &&
    !queuedOrActive &&
    !trace.some((step) => step.step === 'scan_finalized');
}
