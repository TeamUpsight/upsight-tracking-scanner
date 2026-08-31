export interface BrowserQlHandoffOptions {
  host: string;
  token: string;
  route: 'standard' | 'stealth';
  url: string;
  externalProxyServer?: string;
  builtInProxy?: 'residential';
  proxyCountry?: string;
  proxySticky?: boolean;
  proxyLocaleMatch?: boolean;
  browserLocale?: string;
  sessionTimeoutMs: number;
  reconnectTimeoutMs?: number;
  solveChallenge?: boolean;
  fetchFn?: typeof fetch;
}

export interface BrowserQlHandoffResult {
  browserWSEndpoint: string;
  navigationStatus: number | null;
  captchaFound: boolean;
  captchaSolved: boolean;
  solveTimeMs: number | null;
}

export async function createBrowserQlHandoff(options: BrowserQlHandoffOptions): Promise<BrowserQlHandoffResult> {
  const params = new URLSearchParams({
    token: options.token,
    timeout: String(options.sessionTimeoutMs)
  });
  if (options.externalProxyServer) params.set('externalProxyServer', options.externalProxyServer);
  if (!options.externalProxyServer && options.builtInProxy) params.set('proxy', options.builtInProxy);
  if (!options.externalProxyServer && options.proxyCountry) params.set('proxyCountry', options.proxyCountry);
  if (!options.externalProxyServer && options.proxySticky) params.set('proxySticky', 'true');
  if (!options.externalProxyServer && options.proxyLocaleMatch) params.set('proxyLocaleMatch', 'true');
  if (options.browserLocale) params.set('launch', JSON.stringify({ args: [`--lang=${options.browserLocale}`, '--window-size=1280,800'] }));
  const path = options.route === 'stealth' ? '/stealth/bql' : '/chromium/bql';
  const endpoint = `https://${options.host}${path}?${params.toString()}`;
  const solveSelection = options.solveChallenge ? `
    solve {
      found
      solved
      time
    }` : '';
  const query = `
    mutation UpsightAuthorizedHandoff($url: String!, $reconnectTimeout: Float!) {
      goto(url: $url, waitUntil: domContentLoaded) {
        status
      }${solveSelection}
      reconnect(timeout: $reconnectTimeout) {
        browserWSEndpoint
      }
    }
  `;
  const response = await (options.fetchFn || fetch)(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { url: options.url, reconnectTimeout: options.reconnectTimeoutMs || 30_000 }
    }),
    signal: AbortSignal.timeout(Math.min(options.sessionTimeoutMs, 90_000))
  });
  if (!response.ok) throw new Error(`BrowserQL handoff failed with HTTP ${response.status}`);
  const payload = await response.json() as {
    data?: {
      goto?: { status?: number };
      solve?: { found?: boolean; solved?: boolean; time?: number };
      reconnect?: { browserWSEndpoint?: string };
    };
    errors?: unknown[];
  };
  const rawBrowserWSEndpoint = payload.data?.reconnect?.browserWSEndpoint;
  if (!rawBrowserWSEndpoint) throw new Error('BrowserQL handoff did not return a reconnect endpoint');
  const reconnectUrl = new URL(rawBrowserWSEndpoint);
  if (!reconnectUrl.searchParams.has('token')) reconnectUrl.searchParams.set('token', options.token);
  return {
    browserWSEndpoint: reconnectUrl.toString(),
    navigationStatus: Number.isFinite(payload.data?.goto?.status) ? Number(payload.data?.goto?.status) : null,
    captchaFound: Boolean(payload.data?.solve?.found),
    captchaSolved: Boolean(payload.data?.solve?.solved),
    solveTimeMs: Number.isFinite(payload.data?.solve?.time) ? Number(payload.data?.solve?.time) : null
  };
}
