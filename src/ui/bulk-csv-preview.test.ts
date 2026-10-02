import { describe, expect, it, vi } from 'vitest';
import { detectBulkCsvConfigColumns, NO_CSV_OVERRIDES, readBulkCsvConfigColumns } from './bulk-csv-preview';

const all = { region: true, exact_country: true, mode: true, group_label: true, modules: true };
describe('bulk CSV header ownership detection', () => {
  it('detects all configuration headers', () => {
    expect(detectBulkCsvConfigColumns('domain,region,exact_country,mode,group_label,modules')).toEqual(all);
  });
  it('detects partial ownership without inheriting flags from a previous detection', () => {
    detectBulkCsvConfigColumns('domain,region,exact_country,mode,group_label,modules');
    expect(detectBulkCsvConfigColumns('domain,region,modules')).toEqual({ ...NO_CSV_OVERRIDES, region: true, modules: true });
  });
  it('uses the same alias normalization for spaced headers', () => {
    expect(detectBulkCsvConfigColumns('Domain,Tested Geo,Tested Country,Group Label,Modules')).toEqual({ ...all, mode: false });
  });
  it.each(['region', 'geo', 'tested_geos', 'tested_geo', 'TESTED-GEOS'])('recognizes region alias %s', (alias) => {
    expect(detectBulkCsvConfigColumns(`domain,${alias}`)).toEqual({ ...NO_CSV_OVERRIDES, region: true });
  });
  it.each(['exact_country', 'tested_country', 'country', 'Exact Country'])('recognizes country alias %s', (alias) => {
    expect(detectBulkCsvConfigColumns(`domain,${alias}`)).toEqual({ ...NO_CSV_OVERRIDES, exact_country: true });
  });
  it.each(['group_label', 'group label', 'group', 'Group-Label'])('recognizes label alias %s', (alias) => {
    expect(detectBulkCsvConfigColumns(`domain,${alias}`)).toEqual({ ...NO_CSV_OVERRIDES, group_label: true });
  });
  it('handles case, whitespace, BOM and quoted headers', () => {
    expect(detectBulkCsvConfigColumns('\uFEFF" DOMAIN "," GEO "," Country "," MODE "," Group Label "," MODULES "')).toEqual(all);
  });
  it.each(['domain', 'domain,company_name,notes', 'domain,region_hint,mode_hint,constructor,__proto__', 'example.com'])('detects no ownership for %s', (header) => {
    expect(detectBulkCsvConfigColumns(header)).toEqual(NO_CSV_OVERRIDES);
  });
  it('retains legacy domain-header recognition and ignores unknown columns', () => {
    expect(detectBulkCsvConfigColumns('Storefront Domain,mode,notes')).toEqual({ ...NO_CSV_OVERRIDES, mode: true });
    expect(detectBulkCsvConfigColumns('example.com,EU,consent')).toEqual(NO_CSV_OVERRIDES);
  });
  it('ignores all later rows, including quoted module commas and malformed row quoting', () => {
    expect(detectBulkCsvConfigColumns('domain,modules\nexample.com,"consent,tracking,serverside"\nexample.org,"unclosed')).toEqual({ ...NO_CSV_OVERRIDES, modules: true });
  });
  it('uses shared quoted-cell semantics and skips blank lines', () => {
    expect(detectBulkCsvConfigColumns('\r\n\n"domain","Group\nLabel","ignored,""quoted""",mode\r\nexample.com,a,b,c')).toEqual({ ...NO_CSV_OVERRIDES, group_label: true, mode: true });
  });
  it.each(['"domain,region', 'domain,"mode"oops', 'domain,mo"de', '', ' \n'])('declines unsafe or empty headers (%j)', (header) => {
    expect(detectBulkCsvConfigColumns(header)).toBeNull();
  });
  it('does not guess a header from an incomplete file prefix', () => {
    expect(detectBulkCsvConfigColumns('domain,mode', false)).toBeNull();
    expect(detectBulkCsvConfigColumns('domain,mode\npartial later row', false)).toEqual({ ...NO_CSV_OVERRIDES, mode: true });
  });
});

describe('bounded CSV file header reads', () => {
  it('stops after the first small slice and never reads the whole file', async () => {
    const file = new Blob(['domain,region,modules\n', 'x'.repeat(100_000)]);
    const slice = vi.spyOn(file, 'slice');
    const text = vi.spyOn(file, 'text');
    expect(await readBulkCsvConfigColumns(file)).toEqual({ ...NO_CSV_OVERRIDES, region: true, modules: true });
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 4096);
    expect(text).not.toHaveBeenCalled();
  });
  it('handles UTF-8 and headers crossing slice boundaries', async () => {
    const file = new Blob([`domain,${'é'.repeat(2047)},modules\r\nexample.com,ignored,consent`]);
    expect(await readBulkCsvConfigColumns(file)).toEqual({ ...NO_CSV_OVERRIDES, modules: true });
  });
  it('recognizes a header-only file without a final newline', async () => {
    expect(await readBulkCsvConfigColumns(new Blob(['domain,mode']))).toEqual({ ...NO_CSV_OVERRIDES, mode: true });
  });
  it('caps preview reads without interpreting a truncated header as complete', async () => {
    const file = new Blob([' '.repeat(70_000), 'domain,modules\nexample.com,consent']);
    const slice = vi.spyOn(file, 'slice');
    expect(await readBulkCsvConfigColumns(file)).toBeNull();
    expect(slice).toHaveBeenCalledTimes(16);
    expect(slice.mock.calls.at(-1)).toEqual([61_440, 65_536]);
  });
  it('stops on a malformed first record even when more data follows', async () => {
    const file = new Blob(['domain,"mode"oops\n', 'x'.repeat(100_000)]);
    const slice = vi.spyOn(file, 'slice');
    expect(await readBulkCsvConfigColumns(file)).toBeNull();
    expect(slice).toHaveBeenCalledTimes(1);
  });
  it('returns no ownership for empty files', async () => {
    expect(await readBulkCsvConfigColumns(new Blob([]))).toBeNull();
  });
});
