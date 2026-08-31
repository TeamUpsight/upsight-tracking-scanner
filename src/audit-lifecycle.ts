import { selectedAuditModules } from './audit-modules';
import type { AuditModule, ErrorCategory, ScanMode, ScanStatus, StorefrontAudit } from './types';

export interface AuditQueueJob {
  audit_id: string | number;
  domain: string;
  enable_captcha_solving: boolean;
  is_bulk: boolean;
  scan_mode: ScanMode;
  selected_modules: AuditModule[];
  available_at?: number;
}

export function queueJobForAudit(
  audit: StorefrontAudit,
  options: Pick<AuditQueueJob, 'enable_captcha_solving' | 'is_bulk'>
): AuditQueueJob {
  return {
    audit_id: audit.audit_id,
    domain: audit.domain,
    enable_captcha_solving: options.enable_captcha_solving,
    is_bulk: options.is_bulk,
    scan_mode: audit.scan_mode === 'diagnostic' ? 'diagnostic' : 'normal',
    selected_modules: selectedAuditModules(audit.selected_modules)
  };
}

export function shouldEnqueueAudit(alreadyQueuedOrActive: boolean) {
  return !alreadyQueuedOrActive;
}

export function rerunAuditOptions(source: StorefrontAudit, mode: ScanMode = source.scan_mode === 'diagnostic' ? 'diagnostic' : 'normal') {
  return {
    domain: source.domain,
    tested_geos: source.tested_geos,
    group_label: source.group_label,
    scan_mode: mode,
    selected_modules: selectedAuditModules(source.selected_modules)
  };
}

export function classifyAuditTermination(manuallyCancelled: boolean, timedOut: boolean): { category: ErrorCategory; scanStatus: ScanStatus } | null {
  if (manuallyCancelled) return { category: 'cancelled', scanStatus: 'cancelled' };
  if (timedOut) return { category: 'scan_timeout', scanStatus: 'failed' };
  return null;
}

export function isRecoverableStaleAudit(audit: StorefrontAudit, queuedOrActive: boolean, trace: Record<string, unknown>[]) {
  return ['pending', 'scanning'].includes(audit.scan_status) &&
    !queuedOrActive &&
    !trace.some((step) => step.step === 'scan_finalized');
}
