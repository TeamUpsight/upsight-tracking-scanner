import type { BrowserContext, CDPSession, Page } from 'playwright-core';

function normalizedBase(host: string) {
  return host.toLowerCase().replace(/^www\./, '');
}

function configuredDomains() {
  return new Set(String(process.env.AUTHORIZED_SCAN_DOMAINS || '')
    .split(',')
    .map((value) => normalizedBase(value.trim()))
    .filter(Boolean));
}

export function authorizedAccessConfiguredFor(domain: string) {
  return configuredDomains().has(normalizedBase(domain)) &&
    /^x-[a-z0-9-]{1,60}$/i.test(String(process.env.AUTHORIZED_SCAN_HEADER_NAME || '')) &&
    Boolean(process.env.AUTHORIZED_SCAN_HEADER_VALUE);
}

export async function attachAuthorizedAccessHeader(context: BrowserContext, page: Page, domain: string): Promise<CDPSession | null> {
  if (!authorizedAccessConfiguredFor(domain)) return null;
  const headerName = String(process.env.AUTHORIZED_SCAN_HEADER_NAME).toLowerCase();
  const headerValue = String(process.env.AUTHORIZED_SCAN_HEADER_VALUE);
  const targetBase = normalizedBase(domain);
  const session = await context.newCDPSession(page);
  await session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*/*', requestStage: 'Request' }] });
  session.on('Fetch.requestPaused', async (event: any) => {
    const requestId = event.requestId;
    try {
      const url = new URL(String(event.request?.url || ''));
      const sameSite = normalizedBase(url.hostname) === targetBase || normalizedBase(url.hostname).endsWith(`.${targetBase}`);
      const documentRequest = event.resourceType === 'Document' && ['GET', 'HEAD'].includes(String(event.request?.method || '').toUpperCase());
      if (!sameSite || !documentRequest) {
        await session.send('Fetch.continueRequest', { requestId });
        return;
      }
      const headers = Object.entries(event.request?.headers || {})
        .filter(([name]) => name.toLowerCase() !== headerName)
        .map(([name, value]) => ({ name, value: String(value) }));
      headers.push({ name: headerName, value: headerValue });
      await session.send('Fetch.continueRequest', { requestId, headers });
    } catch {
      await session.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });
  return session;
}
