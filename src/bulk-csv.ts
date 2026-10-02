import { normalizeAuditModules } from './audit-modules';
import { validateExactCountryRequest } from './audit-lifecycle';
import { normalizeAuditDomain } from './scanner';
import { validateTestedCountry } from './scanner/proxy/decodo';
import type { AuditModule, ScanMode } from './types';

type Region = 'USA' | 'EU' | 'UK';
type CsvField = 'domain' | 'region' | 'exact_country' | 'mode' | 'group_label' | 'modules';
type CsvRow = { row: number; cells: string[] };
type ColumnMap = Partial<Record<CsvField, number>>;

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

export interface BulkCsvRowError {
  row: number;
  domain: string | null;
  field: CsvField | 'csv';
  message: string;
}

export class BulkCsvValidationError extends Error {
  constructor(public readonly status: number, public readonly response: {
    error: string;
    error_count?: number;
    errors_returned?: number;
    errors_truncated?: boolean;
    rows?: BulkCsvRowError[];
  }) {
    super(response.error);
  }
}

export function normalizeBulkCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

const headerFields: Record<string, CsvField> = {
  domain: 'domain', region: 'region', geo: 'region', tested_geos: 'region', tested_geo: 'region',
  exact_country: 'exact_country', tested_country: 'exact_country', country: 'exact_country',
  mode: 'mode', group_label: 'group_label', group: 'group_label', modules: 'modules'
};

/** Parse cells before interpreting module commas. Row numbers refer to physical CSV lines. */
export function parseBulkCsvRows(csv: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let rowStart = 1;
  const finishRow = () => {
    cells.push(cell.trim());
    if (cells.some(Boolean)) rows.push({ row: rowStart, cells });
    cells = [];
    cell = '';
    closedQuote = false;
  };
  const malformed = () => {
    throw new BulkCsvValidationError(400, {
      error: 'CSV validation failed.', error_count: 1, errors_returned: 1, errors_truncated: false,
      rows: [{ row: rowStart, domain: null, field: 'csv', message: 'Malformed quoted CSV cell.' }]
    });
  };
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else if (quoted) { quoted = false; closedQuote = true; }
      else if (!cell.trim() && !closedQuote) { cell = ''; quoted = true; }
      else malformed();
    } else if (character === ',' && !quoted) {
      cells.push(cell.trim()); cell = ''; closedQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (quoted) cell += '\n';
      else finishRow();
      if (character === '\r' && csv[index + 1] === '\n') index += 1;
      line += 1;
      if (!quoted) rowStart = line;
    } else {
      if (closedQuote && character.trim()) malformed();
      cell += character;
    }
  }
  if (quoted) malformed();
  finishRow();
  return rows;
}

function bulkCsvColumns(first: CsvRow): { columns: ColumnMap; hasHeader: boolean } {
  const columns: ColumnMap = {};
  for (const [index, value] of first.cells.entries()) {
    const header = normalizeBulkCsvHeader(value);
    const field = Object.hasOwn(headerFields, header) ? headerFields[header] : undefined;
    if (field && columns[field] === undefined) columns[field] = index;
  }
  // Retain legacy domain-header and headerless first-column imports.
  if (columns.domain === undefined) {
    const legacyDomain = first.cells.findIndex((value) => normalizeBulkCsvHeader(value).includes('domain'));
    if (legacyDomain >= 0) columns.domain = legacyDomain;
  }
  const hasHeader = columns.domain !== undefined;
  return { columns: hasHeader ? columns : { domain: 0 }, hasHeader };
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
