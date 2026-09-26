import { isValidProxy } from './scanner/proxy/decodo';

export function productionConfigurationIssues(environment: NodeJS.ProcessEnv, compiledBundle = false): string[] {
  if (compiledBundle && environment.NODE_ENV !== 'production') {
    return ['A compiled server requires NODE_ENV=production.'];
  }
  if (environment.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  if (!environment.INTERNAL_API_TOKEN?.trim()) issues.push('INTERNAL_API_TOKEN is required in production.');
  if (environment.USE_MEMORY_DB === 'true') issues.push('USE_MEMORY_DB must be false in production.');
  if (environment.BROWSER_PROVIDER === 'local') issues.push('BROWSER_PROVIDER=local is not supported in production.');
  if (!environment.BROWSERLESS_TOKEN?.trim()) issues.push('BROWSERLESS_TOKEN is required in production.');
  if (environment.BROWSERLESS_CHALLENGE_SOLVING_ENABLED === 'true') {
    issues.push('BROWSERLESS_CHALLENGE_SOLVING_ENABLED must be false in production until BrowserQL navigation is guarded.');
  }
  if (environment.GPC_EXPERIMENT_ENABLED === 'true') {
    issues.push('GPC_EXPERIMENT_ENABLED must be false in production until its separate browser session is guarded.');
  }
  for (const geo of ['USA', 'EU', 'UK']) {
    const proxy = environment[`DECODO_PROXY_${geo}`]?.trim();
    if (!proxy) issues.push(`DECODO_PROXY_${geo} is required in production.`);
    else if (!isValidProxy(proxy)) issues.push(`DECODO_PROXY_${geo} must be a valid proxy URL.`);
  }
  return issues;
}
