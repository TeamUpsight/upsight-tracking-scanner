import type { AuditModule } from './types';

export const AUDIT_MODULE_ORDER: AuditModule[] = ['consent', 'tracking', 'server_side'];

export function normalizeAuditModules(value: unknown): AuditModule[] | null {
  if (value === undefined || value === null) return [...AUDIT_MODULE_ORDER];
  if (!Array.isArray(value) || value.length === 0) return null;
  const selected = new Set<AuditModule>();
  for (const item of value) {
    if (typeof item !== 'string' || !AUDIT_MODULE_ORDER.includes(item as AuditModule)) return null;
    selected.add(item as AuditModule);
  }
  return selected.size ? AUDIT_MODULE_ORDER.filter((module) => selected.has(module)) : null;
}

export function selectedAuditModules(value: unknown): AuditModule[] {
  return normalizeAuditModules(value) || [...AUDIT_MODULE_ORDER];
}

export function includesAuditModule(value: unknown, module: AuditModule) {
  return selectedAuditModules(value).includes(module);
}
