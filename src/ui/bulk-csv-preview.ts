import { useEffect, useState } from 'react';
import { bulkCsvColumns, parseBulkCsvRows } from '../bulk-csv-format';
import type { CsvRow } from '../bulk-csv-format';

export const CSV_CONFIG_LABELS = {
  region: 'Region', exact_country: 'Exact Country', mode: 'Mode', group_label: 'Group Label', modules: 'Modules'
};
export type BulkCsvConfigColumns = Record<keyof typeof CSV_CONFIG_LABELS, boolean>;
export const NO_CSV_OVERRIDES: BulkCsvConfigColumns = {
  region: false, exact_country: false, mode: false, group_label: false, modules: false
};
const HEADER_READ_CHUNK_BYTES = 4096;
const MAX_HEADER_PREVIEW_BYTES = 65_536;

// Locate only the first CSV record; the shared parser checks its quoting and cells.
function firstHeader(csvText: string, completeFile: boolean) {
  let quoted = false;
  let start = 0;
  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    if (character === '"') {
      if (quoted && csvText[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (character === '\r' || character === '\n')) {
      const header = parseBulkCsvRows(csvText.slice(start, index))[0];
      if (header) return header;
      if (character === '\r' && csvText[index + 1] === '\n') index += 1;
      start = index + 1;
    }
  }
  return completeFile ? parseBulkCsvRows(csvText.slice(start))[0] : undefined;
}

/** Header presence only: no row values, audit validation, or server imports. */
function columnsForHeader(header: CsvRow): BulkCsvConfigColumns {
  const { columns } = bulkCsvColumns(header);
  return Object.fromEntries(Object.keys(NO_CSV_OVERRIDES).map((field) => [field, columns[field] !== undefined])) as BulkCsvConfigColumns;
}

export function detectBulkCsvConfigColumns(csvText: string, completeFile = true): BulkCsvConfigColumns | null {
  try {
    const header = firstHeader(csvText, completeFile);
    if (!header) return null;
    return columnsForHeader(header);
  } catch {
    return null;
  }
}

export async function readBulkCsvConfigColumns(file: Pick<Blob, 'size' | 'slice'>): Promise<BulkCsvConfigColumns | null> {
  const decoder = new TextDecoder();
  let headerText = '';
  const limit = Math.min(file.size, MAX_HEADER_PREVIEW_BYTES);
  for (let offset = 0; offset < limit; offset += HEADER_READ_CHUNK_BYTES) {
    const end = Math.min(offset + HEADER_READ_CHUNK_BYTES, limit);
    const completeFile = end === file.size;
    headerText += decoder.decode(await file.slice(offset, end).arrayBuffer(), { stream: !completeFile });
    try {
      const header = firstHeader(headerText, completeFile);
      if (header) return columnsForHeader(header);
    } catch { return null; }
    if (completeFile) return null;
  }
  return null;
}

type CsvPreview = { file: File | null; columns: BulkCsvConfigColumns; status: 'idle' | 'reading' | 'ready' | 'unavailable' };

export function useBulkCsvPreview(file: File | null) {
  const empty: CsvPreview = { file, columns: NO_CSV_OVERRIDES, status: file ? 'reading' : 'idle' };
  const [preview, setPreview] = useState<CsvPreview>(empty);
  useEffect(() => {
    let current = true;
    setPreview({ file, columns: NO_CSV_OVERRIDES, status: file ? 'reading' : 'idle' });
    if (file) void readBulkCsvConfigColumns(file).then((columns) => {
      if (current) setPreview({ file, columns: columns || NO_CSV_OVERRIDES, status: columns ? 'ready' : 'unavailable' });
    }).catch(() => {
      if (current) setPreview({ file, columns: NO_CSV_OVERRIDES, status: 'unavailable' });
    });
    return () => { current = false; };
  }, [file]);
  // Clear ownership during the replacement render, before the previous effect's cleanup.
  return preview.file === file ? preview : empty;
}
