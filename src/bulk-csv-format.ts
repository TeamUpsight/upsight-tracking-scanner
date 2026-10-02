export type CsvField = 'domain' | 'region' | 'exact_country' | 'mode' | 'group_label' | 'modules';
export type CsvRow = { row: number; cells: string[] };
export type ColumnMap = Partial<Record<CsvField, number>>;

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

export function bulkCsvColumns(first: CsvRow): { columns: ColumnMap; hasHeader: boolean } {
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
