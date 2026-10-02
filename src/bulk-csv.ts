import { BulkCsvValidationError, bulkCsvColumns, parseBulkCsvRows, type CsvField, type CsvRow, type ColumnMap, type BulkCsvRowError } from './bulk-csv-format';
export { BulkCsvValidationError, normalizeBulkCsvHeader, parseBulkCsvRows, type BulkCsvRowError } from './bulk-csv-format';
import { normalizeAuditModules } from './audit-modules';
import { validateExactCountryRequest } from './audit-lifecycle';
import { normalizeAuditDomain } from './scanner';
import { validateTestedCountry } from './scanner/proxy/decodo';
import type { AuditModule, ScanMode } from './types';

type Region = 'USA' | 'EU' | 'UK';
export interface BulkCsvDefaults {
  tested_geos?: unknown;
  tested_country?: unknown;
  mode?: unknown;
  group_label?: unknown;
  selected_modules?: unknown;
}

export interface BulkCsvConfig {
  domain: string;
  region: Region;
  exact_country: string | null;
  mode: ScanMode;
  group_label: string | null;
  modules: AuditModule[];
}

export function normalizeModuleCell(value: string): AuditModule[] | null {
  const modules = value.split(',').map((item) => {
    const normalized = item.trim().toLowerCase();
    return ['serverside', 'server-side'].includes(normalized) ? 'server_side' : normalized;
  });
  return normalizeAuditModules(modules);
}

function defaultModules(value: unknown): AuditModule[] | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return normalizeAuditModules(value);
}

function absent(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/** Every call resolves a fresh row; CSV can only select these six public fields. */
export function validateBulkCsvRow(row: CsvRow, columns: ColumnMap, defaults: BulkCsvDefaults):
  { config: BulkCsvConfig; error?: never } | { config?: never; error: BulkCsvRowError } {
  const value = (field: CsvField) => columns[field] === undefined ? '' : row.cells[columns[field]]?.trim() || '';
  const domain = normalizeAuditDomain(value('domain'));
  const fail = (field: CsvField, message: string) => ({ error: { row: row.row, domain, field, message } });
  if (!domain) return fail('domain', 'A valid storefront domain is required.');
  const modules = value('modules') ? normalizeModuleCell(value('modules')) : defaultModules(defaults.selected_modules);
  if (!modules) return fail('modules', 'modules must contain at least one supported module and no unknown modules.');
  const region = String(value('region') || (absent(defaults.tested_geos) ? 'USA' : defaults.tested_geos)).trim().toUpperCase();
  if (!['USA', 'EU', 'UK'].includes(region)) return fail('region', 'region must be USA, EU, or UK.');
  const exactValue = value('exact_country') || (absent(defaults.tested_country) ? null : defaults.tested_country);
  // Validate geography before mode, then final module compatibility below.
  const exactCountry = validateTestedCountry(region as Region, exactValue);
  if (exactCountry.error) return fail('exact_country', exactCountry.error.replace(/tested_country/g, 'exact_country'));
  const mode = String(value('mode') || (absent(defaults.mode) ? 'normal' : defaults.mode)).trim().toLowerCase();
  if (mode !== 'normal' && mode !== 'diagnostic') return fail('mode', 'mode must be normal or diagnostic.');
  // Existing API group labels are strings capped at 120 characters; React escapes their display.
  const groupValue = value('group_label') || (absent(defaults.group_label) ? null : defaults.group_label);
  const groupLabel = groupValue === null ? null : String(groupValue).trim().slice(0, 120);
  const compatibility = validateExactCountryRequest(region as Region, exactCountry.country, modules);
  if (compatibility.error) return fail('exact_country', compatibility.error.replace(/tested_country/g, 'exact_country'));
  return { config: { domain, region: region as Region, exact_country: exactCountry.country, mode, group_label: groupLabel, modules } };
}

/** No persistence or queue side effects occur until this entire validation pass succeeds. */
export function prepareBulkCsv(csv: string, defaults: BulkCsvDefaults, maxBatchSize: number) {
  const parsed = parseBulkCsvRows(csv);
  if (!parsed.length) throw new BulkCsvValidationError(400, { error: 'The CSV is empty.' });
  const { columns, hasHeader } = bulkCsvColumns(parsed[0]);
  const rows = hasHeader ? parsed.slice(1) : parsed;
  const legacyDomainOnly = Object.keys(columns).every((field) => field === 'domain');
  const configs: BulkCsvConfig[] = [];
  const seen = new Set<string>();
  const errors: BulkCsvRowError[] = [];
  let errorCount = 0;
  let duplicatesRemoved = 0;
  const validated = rows.map((row) => {
    const domain = normalizeAuditDomain(row.cells[columns.domain]);
    return !domain && legacyDomainOnly ? null : validateBulkCsvRow(row, columns, defaults);
  });
  // Pick winners only after every row is resolved and validated. No configuration is merged.
  for (const result of validated) {
    if (!result) { duplicatesRemoved += 1; continue; }
    if (result.error) continue;
    if (seen.has(result.config.domain)) { duplicatesRemoved += 1; continue; }
    seen.add(result.config.domain);
    configs.push(result.config);
  }
  for (const result of validated) {
    if (!result?.error) continue;
    if (result.error.domain && seen.has(result.error.domain)) { duplicatesRemoved += 1; continue; }
    errorCount += 1;
    if (errors.length < 50) errors.push(result.error);
  }
  if (errorCount) throw new BulkCsvValidationError(400, {
    error: 'CSV validation failed.', error_count: errorCount, errors_returned: errors.length,
    errors_truncated: errorCount > errors.length, rows: errors
  });
  if (!configs.length) throw new BulkCsvValidationError(400, { error: 'No valid domains were found.' });
  if (configs.length > maxBatchSize) throw new BulkCsvValidationError(413, {
    error: `Batch contains ${configs.length} unique domains; maximum is ${maxBatchSize}.`
  });
  return { configs, duplicates_removed: duplicatesRemoved };
}
