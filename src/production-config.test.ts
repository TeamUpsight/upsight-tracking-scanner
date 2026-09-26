import { describe, expect, it } from 'vitest';
import { productionConfigurationIssues } from './production-config';

describe('production startup configuration', () => {
  it('fails closed without authentication and browser infrastructure', () => {
    expect(productionConfigurationIssues({ NODE_ENV: 'production' })).toEqual(expect.arrayContaining([
      expect.stringContaining('INTERNAL_API_TOKEN'), expect.stringContaining('BROWSERLESS_TOKEN'),
      expect.stringContaining('DECODO_PROXY_USA')
    ]));
    expect(productionConfigurationIssues({ NODE_ENV: 'production', INTERNAL_API_TOKEN: 'token',
      BROWSERLESS_TOKEN: 'browser', DECODO_PROXY_USA: 'http://proxy.example:10001', DECODO_PROXY_EU: 'http://proxy.example:10001',
      DECODO_PROXY_UK: 'http://proxy.example:10001', USE_MEMORY_DB: 'true' })).toContain('USE_MEMORY_DB must be false in production.');
    expect(productionConfigurationIssues({ NODE_ENV: 'production', BROWSERLESS_CHALLENGE_SOLVING_ENABLED: 'true',
      GPC_EXPERIMENT_ENABLED: 'true' })).toEqual(expect.arrayContaining([
      expect.stringContaining('BROWSERLESS_CHALLENGE_SOLVING_ENABLED must be false'),
      expect.stringContaining('GPC_EXPERIMENT_ENABLED must be false')
    ]));
  });

  it('allows a fully configured production startup and local development', () => {
    expect(productionConfigurationIssues({ NODE_ENV: 'development' })).toEqual([]);
    expect(productionConfigurationIssues({ NODE_ENV: 'development' }, true)).toContain('A compiled server requires NODE_ENV=production.');
    expect(productionConfigurationIssues({ NODE_ENV: 'production', INTERNAL_API_TOKEN: 'token',
      BROWSERLESS_TOKEN: 'browser', DECODO_PROXY_USA: 'http://proxy.example:10001', DECODO_PROXY_EU: 'http://proxy.example:10001',
      DECODO_PROXY_UK: 'http://proxy.example:10001' })).toEqual([]);
  });
});
