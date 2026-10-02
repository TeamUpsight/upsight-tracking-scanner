import { describe, expect, it } from 'vitest';
import { BulkCsvValidationError, normalizeBulkCsvHeader, normalizeModuleCell, parseBulkCsvRows, prepareBulkCsv, type BulkCsvDefaults } from './bulk-csv';

const ui: BulkCsvDefaults = {
  tested_geos: 'USA', tested_country: 'US', mode: 'diagnostic', group_label: 'default-group', selected_modules: ['consent', 'tracking']
};
const header = 'domain,region,exact_country,mode,group_label,modules';
const inherited = {
  domain: 'example.com', region: 'USA', exact_country: 'US', mode: 'diagnostic', group_label: 'default-group', modules: ['consent', 'tracking']
};
const prepare = (csv: string, defaults = ui, limit = 5000) => prepareBulkCsv(csv, defaults, limit);
function rejection(csv: string, defaults = ui) {
  try { prepare(csv, defaults); } catch (error) {
    expect(error).toBeInstanceOf(BulkCsvValidationError);
    return (error as BulkCsvValidationError).response;
  }
  throw new Error('Expected validation failure');
}

describe('bulk CSV row configuration', () => {
  it('inherits all UI settings for a legacy domain-only CSV', () => {
    expect(prepare('domain\nexample.com').configs).toEqual([inherited]);
  });
  it('applies a full override before validating the UI country and modules', () => {
    expect(prepare(`${header}\nexample.de,EU,DE,diagnostic,eu-canary,"consent,serverside"`, {
      ...ui, mode: 'normal', selected_modules: ['tracking']
    }).configs).toEqual([{
      domain: 'example.de', region: 'EU', exact_country: 'DE', mode: 'diagnostic', group_label: 'eu-canary', modules: ['consent', 'server_side']
    }]);
  });
  it('inherits partial settings while preserving the exact-country Consent requirement', () => {
    expect(prepare('domain,mode,modules\nexample.com,diagnostic,consent', {
      ...ui, tested_geos: 'EU', tested_country: 'DE', mode: 'normal', selected_modules: ['tracking']
    }).configs).toEqual([{
      domain: 'example.com', region: 'EU', exact_country: 'DE', mode: 'diagnostic', group_label: 'default-group', modules: ['consent']
    }]);
  });
  it('resolves mixed regions, countries, modes, labels and modules without row leakage', () => {
    const result = prepare(`${header}\nsite1.com,USA,US,diagnostic,us-canary,"consent,tracking"\nsite2.com,UK,GB,normal,uk-canary,consent\nsite3.com,EU,DE,diagnostic,de-canary,"consent,serverside"\nsite4.com,EU,FR,normal,fr-canary,"consent,tracking,serverside"\nexample.com,,,,,`);
    expect(result.configs.map((config) => [config.region, config.exact_country, config.mode, config.group_label, config.modules])).toEqual([
      ['USA', 'US', 'diagnostic', 'us-canary', ['consent', 'tracking']],
      ['UK', 'GB', 'normal', 'uk-canary', ['consent']],
      ['EU', 'DE', 'diagnostic', 'de-canary', ['consent', 'server_side']],
      ['EU', 'FR', 'normal', 'fr-canary', ['consent', 'tracking', 'server_side']],
      ['USA', 'US', 'diagnostic', 'default-group', ['consent', 'tracking']]
    ]);
  });
  it.each(['', ' ', '"   "'])('inherits every blank override (%s)', (blank) => {
    expect(prepare(`${header}\nexample.com,${Array(5).fill(blank).join(',')}`).configs).toEqual([inherited]);
  });
  it('uses existing defaults when no UI defaults are supplied', () => {
    expect(prepare('domain\nexample.com', {}).configs).toEqual([{
      domain: 'example.com', region: 'USA', exact_country: null, mode: 'normal', group_label: null,
      modules: ['consent', 'tracking', 'server_side']
    }]);
  });
  it('normalizes case and whitespace after parsing quoted cells', () => {
    expect(prepare(`${header}\nexample.com," eu "," de "," Diagnostic ", eu-canary ," CONSENT, Tracking "`).configs).toEqual([{
      domain: 'example.com', region: 'EU', exact_country: 'DE', mode: 'diagnostic', group_label: 'eu-canary', modules: ['consent', 'tracking']
    }]);
  });
  it.each(['example.com', 'shop.example.com', 'https://example.com/path'])('reuses domain normalization for %s', (domain) => {
    expect(prepare(`domain\n${domain}`).configs[0].domain).toBe(domain.startsWith('https:') ? 'example.com' : domain);
  });
  it('uses regional routing when neither CSV nor UI specifies an exact country', () => {
    expect(prepare('domain,region,modules\nexample.com,UK,"tracking,serverside"', {
      ...ui, tested_country: null
    }).configs[0]).toMatchObject({ region: 'UK', exact_country: null, modules: ['tracking', 'server_side'] });
  });
  it('validates an inherited UI country against the overridden region', () => {
    expect(rejection('domain,region\nexample.com,EU').rows[0]).toMatchObject({
      field: 'exact_country', message: 'exact_country US is not supported for EU.'
    });
  });
  it.each(['DE', 'NL', 'FR', 'IT', 'ES'])('uses the shared EU country definition for %s', (country) => {
    expect(prepare(`domain,region,exact_country\nexample.com,EU,${country}`).configs[0].exact_country).toBe(country);
  });
  it('trims labels, preserves quoted punctuation, and applies the existing 120-character cap', () => {
    expect(prepare('domain,group_label\nexample.com,"  canary,""quoted""  "').configs[0].group_label).toBe('canary,"quoted"');
    expect(prepare(`domain,group_label\nexample.com,${'a'.repeat(150)}`).configs[0].group_label).toHaveLength(120);
  });
});

describe('CSV modules and headers', () => {
  it.each(['serverside', 'server_side', 'server-side'])('normalizes %s to server_side', (alias) => {
    expect(normalizeModuleCell(alias)).toEqual(['server_side']);
  });
  it('normalizes quoted module lists through the existing strict canonical module normalizer', () => {
    expect(prepare('domain,modules\nexample.com,"consent,tracking,serverside"').configs[0].modules).toEqual(['consent', 'tracking', 'server_side']);
    expect(normalizeModuleCell('server-side,consent,tracking,consent')).toEqual(['consent', 'tracking', 'server_side']);
    expect(normalizeModuleCell('consent,foobar')).toBeNull();
    expect(normalizeModuleCell('consent,')).toBeNull();
    expect(normalizeModuleCell('product')).toBeNull();
  });
  it.each(['region', 'geo', 'tested_geos', 'tested_geo'])('maps region header %s', (alias) => {
    expect(prepare(`domain,${alias},exact_country\nexample.com,EU,DE`).configs[0].region).toBe('EU');
  });
  it.each(['exact_country', 'tested_country', 'country', 'Exact Country', 'exact-country'])('maps country header %s', (alias) => {
    expect(prepare(`domain,region,${alias}\nexample.com,UK,GB`).configs[0].exact_country).toBe('GB');
  });
  it.each(['group_label', 'group label', 'group', 'Group Label', 'group-label'])('maps label header %s', (alias) => {
    expect(prepare(`domain,${alias}\nexample.com,row-group`).configs[0].group_label).toBe('row-group');
  });
  it.each(['Domain', 'DOMAIN', ' domain '])('maps normalized domain header %s', (alias) => {
    expect(prepare(`${alias}\nexample.com`).configs).toEqual([inherited]);
  });
  it('normalizes supported headers deterministically and ignores fuzzy or private configuration columns', () => {
    expect(normalizeBulkCsvHeader(' Group-Label ')).toBe('group_label');
    expect(prepare('domain,region_hint,proxy_url,enable_captcha_solving,timeout,constructor,__proto__\nexample.com,EU,private-value,true,1,bad,bad').configs).toEqual([inherited]);
  });
  it('uses the first matching column when aliases collide', () => {
    expect(prepare('domain,geo,region,country,exact_country\nexample.com,UK,EU,GB,DE').configs[0]).toMatchObject({ region: 'UK', exact_country: 'GB' });
  });
});

describe('CSV parsing and atomic validation', () => {
  it.each(['\n', '\r\n'])('parses quoted commas, escaped quotes and blank lines with %j endings', (eol) => {
    expect(parseBulkCsvRows(`domain,modules,group_label${eol}${eol}example.com,"consent,tracking","canary,""quoted"""${eol}`)).toEqual([
      { row: 1, cells: ['domain', 'modules', 'group_label'] },
      { row: 3, cells: ['example.com', 'consent,tracking', 'canary,"quoted"'] }
    ]);
  });
  it('supports UTF-8 BOM and line breaks inside quoted cells', () => {
    expect(prepare('\uFEFFdomain,group_label\r\nexample.com,"canary\r\nlabel"').configs[0].group_label).toBe('canary\nlabel');
  });
  it.each(['example.com,"consent', 'example.com,"consent"oops', 'example.com,con"sent'])('rejects malformed quoted CSV: %s', (row) => {
    expect(rejection(`domain,modules\n${row}`).rows[0]).toMatchObject({ row: 2, field: 'csv' });
  });
  it.each([
    ['region', 'APAC', 'region'], ['exact_country', 'DE', 'exact_country'],
    ['mode', 'fast', 'mode'], ['modules', '"consent,foobar"', 'modules']
  ])('rejects invalid explicit %s without falling back', (column, value, field) => {
    expect(rejection(`domain,${column}\nexample.com,${value}`).rows[0].field).toBe(field);
  });
  it.each([['EU', 'US'], ['UK', 'US'], ['USA', 'DE'], ['EU', 'CZ'], ['EU', 'Germany']])('rejects region/country %s/%s', (region, country) => {
    expect(rejection(`domain,region,exact_country\nexample.com,${region},${country}`).rows[0].field).toBe('exact_country');
  });
  it('preserves exact-country module compatibility', () => {
    expect(rejection('domain,region,exact_country,modules\nexample.com,EU,FR,"tracking,serverside"').rows[0].message).toMatch(/requires the Consent module/);
  });
  it('reports the first invalid field in the specified validation order', () => {
    expect(rejection(`${header}\nlocalhost,APAC,XX,fast,label,foobar`).rows[0].field).toBe('domain');
    expect(rejection(`${header}\nexample.com,APAC,XX,fast,label,foobar`).rows[0].field).toBe('modules');
    expect(rejection(`${header}\nexample.com,APAC,XX,fast,label,consent`).rows[0].field).toBe('region');
    expect(rejection(`${header}\nexample.com,EU,US,fast,label,consent`).rows[0].field).toBe('exact_country');
    expect(rejection(`${header}\nexample.com,EU,DE,fast,label,tracking`).rows[0].field).toBe('mode');
  });
  it('keeps the first valid duplicate configuration and ignores later duplicate overrides', () => {
    const result = prepare('domain,region,exact_country\nexample.com,USA,US\nhttps://example.com/path,EU,DE\nEXAMPLE.COM,APAC,XX');
    expect(result.configs).toEqual([inherited]);
    expect(result.duplicates_removed).toBe(2);
  });
  it('selects the first valid occurrence even when an earlier duplicate is invalid', () => {
    expect(prepare('domain,region\nexample.com,APAC\nexample.com,USA')).toEqual({ configs: [inherited], duplicates_removed: 1 });
    expect(rejection('domain,region\nexample.com,APAC\nexample.org,USA').error_count).toBe(1);
  });
  it('retains legacy first-column/headerless imports and invalid-domain filtering', () => {
    expect(prepare('example.com\nexample.org').configs).toHaveLength(2);
    const result = prepare('Storefront Domain,ignored\nexample.com,x\nlocalhost,x\nexample.com,x');
    expect(result.configs).toEqual([inherited]);
    expect(result.duplicates_removed).toBe(2);
  });
  it('returns at most 50 errors while counting every invalid non-duplicate row', () => {
    const result = rejection(`domain,mode\n${Array.from({ length: 75 }, (_, index) => `site${index}.com,fast`).join('\n')}`);
    expect(result).toMatchObject({ error_count: 75, errors_returned: 50, errors_truncated: true });
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0].row).toBe(2);
  });
  it('does not echo arbitrary invalid cells, sensitive URLs, or unknown CSV columns', () => {
    const secret = 'https://username:secret@example.com/private?token=hidden';
    const result = rejection(`domain,modules,proxy_url\nexample.com,${secret},${secret}`);
    expect(JSON.stringify(result)).not.toMatch(/username|secret|private|token|hidden/);
    const domainError = rejection(`domain,mode\nhttps://user:secret@localhost/?token=hidden,normal`);
    expect(domainError.rows[0].domain).toBeNull();
    expect(JSON.stringify(domainError)).not.toMatch(/secret|token|hidden/);
  });
  it('caps unique domains after deduplication', () => {
    expect(prepare('domain\nexample.com\nexample.com', ui, 1).duplicates_removed).toBe(1);
    expect(() => prepare('domain\nexample.com\nexample.org', ui, 1)).toThrow('maximum is 1');
    expect(() => prepare(`domain\n${Array.from({ length: 5001 }, (_, index) => `site${index}.com`).join('\n')}`)).toThrow('maximum is 5000');
  });
  it('rejects empty or header-only CSVs', () => {
    expect(() => prepare(' \r\n')).toThrow('The CSV is empty.');
    expect(() => prepare('domain\n')).toThrow('No valid domains were found.');
  });
});
