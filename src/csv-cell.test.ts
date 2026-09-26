import { describe, expect, it } from 'vitest';
import { csvCell } from './csv-cell';

describe('CSV export cells', () => {
  it('escapes formulas after whitespace or control prefixes', () => {
    for (const value of ['=1+1', '+cmd', '-cmd', '@SUM(1)', '  =1+1', '\t=1+1', '\r=1+1']) {
      expect(csvCell(value)).toBe(`"'${value}"`);
    }
    expect(csvCell('store.example')).toBe('"store.example"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });
});
