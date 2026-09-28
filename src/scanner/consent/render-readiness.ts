import type { Page, Request } from 'playwright-core';

export type RenderState = 'ready' | 'incomplete' | 'unknown';

export interface RenderReadinessObservation {
  render_state: RenderState;
  document_ready_state: 'loading' | 'interactive' | 'complete' | 'unknown';
  domcontentloaded_completed: boolean;
  visible_body_text_length: number;
  visible_element_count: number;
  visible_control_count: number;
  loading_indicator_detected: boolean;
  aria_busy_detected: boolean;
  dominant_loading_surface_detected: boolean;
  app_root_detected: boolean;
  app_root_meaningful_content: boolean;
  render_wait_ms: number;
  render_state_changed: boolean;
}

export interface RenderRuntimeDiagnostics {
  page_error_count: number;
  page_error_families: string[];
  failed_request_count: number;
  failed_request_samples: Array<{ host: string; path: string; resource_type: string; failure_family: string }>;
}

const emptyObservation = (): RenderReadinessObservation => ({
  render_state: 'unknown', document_ready_state: 'unknown', domcontentloaded_completed: false,
  visible_body_text_length: 0, visible_element_count: 0, visible_control_count: 0,
  loading_indicator_detected: false, aria_busy_detected: false, dominant_loading_surface_detected: false,
  app_root_detected: false, app_root_meaningful_content: false, render_wait_ms: 0, render_state_changed: false
});

/** Counts only browser-visible structure; no text, HTML, or screenshots leave the page. */
async function sample(page: Page): Promise<RenderReadinessObservation> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const facts = await Promise.race([page.evaluate(() => {
      const body = document.body;
      const readyState = document.readyState;
      if (!body) return null;
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const domContentLoadedCompleted = readyState === 'complete' || Boolean(navigation && navigation.domContentLoadedEventEnd > 0);
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      };
      const root = document.querySelector('#root, #app, #__next, #__nuxt, [data-reactroot]');
      const elements = Array.from(body.querySelectorAll('*')).slice(0, 600);
      let visibleElements = 0; let controls = 0; let loading = false; let busy = false; let dominant = false;
      for (const element of elements) {
        if (element.matches('[aria-busy="true"]') && (visible(element) || element.querySelector('.spinner, .loading-overlay, [role="progressbar"]'))) busy = true;
        if (!visible(element)) continue;
        visibleElements += 1;
        if (element.matches('button, input, select, textarea, a[href], [role="button"], [role="link"]')) controls += 1;
        const marker = `${element.id} ${typeof element.className === 'string' ? element.className : ''}`;
        const isLoader = element.matches('[role="progressbar"], progress, [aria-busy="true"]') || /(?:^|[\s_-])(spinner|loading|loader|skeleton|progress)(?:$|[\s_-])/i.test(marker);
        if (!isLoader) continue;
        loading = true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if ((style.position === 'fixed' || style.position === 'absolute' || element === root) &&
            rect.width * rect.height >= innerWidth * innerHeight * 0.55) dominant = true;
      }
      const meaningfulLength = (body.innerText || '').replace(/\b(?:loading|please wait|one moment|just a moment)\b[.!\s…]*/gi, '').trim().length;
      const rootLength = root ? (root.textContent || '').replace(/\b(?:loading|please wait|one moment|just a moment)\b[.!\s…]*/gi, '').trim().length : 0;
      return {
        readyState, domContentLoadedCompleted, meaningfulLength: Math.min(10_000, meaningfulLength), visibleElements: Math.min(600, visibleElements),
        controls: Math.min(600, controls), loading, busy, dominant, root: Boolean(root),
        rootMeaningful: rootLength >= 20 || (rootLength >= 12 && controls >= 2),
        semanticMain: Boolean(document.querySelector('main, article, [role="main"]'))
      };
    }), new Promise<null>((resolve) => { watchdog = setTimeout(() => resolve(null), 600); })]);
    if (!facts) return emptyObservation();
    const documentReady = facts.readyState === 'loading' || facts.readyState === 'interactive' || facts.readyState === 'complete'
      ? facts.readyState : 'unknown';
    const contentReady = (facts.meaningfulLength >= 8 && facts.semanticMain && !facts.loading && !facts.busy) || facts.meaningfulLength >= 35 ||
      (facts.meaningfulLength >= 12 && (facts.controls >= 2 || facts.semanticMain || facts.rootMeaningful));
    const loadingBlocks = facts.dominant || (facts.busy && !contentReady) || (facts.loading && !contentReady);
    return {
      render_state: documentReady === 'unknown' ? 'unknown' : !facts.domContentLoadedCompleted || !contentReady || loadingBlocks ? 'incomplete' : 'ready',
      document_ready_state: documentReady, domcontentloaded_completed: facts.domContentLoadedCompleted,
      visible_body_text_length: facts.meaningfulLength, visible_element_count: facts.visibleElements,
      visible_control_count: facts.controls, loading_indicator_detected: facts.loading,
      aria_busy_detected: facts.busy, dominant_loading_surface_detected: facts.dominant,
      app_root_detected: facts.root, app_root_meaningful_content: facts.rootMeaningful,
      render_wait_ms: 0, render_state_changed: false
    };
  } catch {
    return emptyObservation();
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

export async function observeRenderedPage(page: Page, maxWaitMs = 2_500): Promise<RenderReadinessObservation> {
  const started = Date.now();
  let current = await sample(page);
  if (current.render_state === 'ready') return current;
  const first = JSON.stringify(current);
  let changed = false;
  const boundedWait = Math.max(0, Math.min(3_500, maxWaitMs));
  while (Date.now() - started < boundedWait && !page.isClosed()) {
    await page.waitForTimeout(Math.min(250, boundedWait - (Date.now() - started))).catch(() => {});
    const next = await sample(page);
    changed ||= JSON.stringify(next) !== first;
    current = next;
    if (current.render_state === 'ready') break;
  }
  return { ...current, render_wait_ms: Math.min(3_500, Date.now() - started), render_state_changed: changed };
}

export function pageErrorFamily(error: unknown): string {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  if (/chunkloaderror|loading chunk|dynamically imported module/i.test(message)) return 'chunk_load_error';
  if (/hydration|hydrateRoot|server rendered HTML/i.test(message)) return 'hydration_error';
  if (/fetch failed|failed to fetch|networkerror|network request failed/i.test(message)) return 'network_fetch_error';
  if (/execution context|navigation|document was detached|target closed/i.test(message)) return 'navigation_context_error';
  if (/typeerror|referenceerror|syntaxerror|rangeerror|uncaught/i.test(message)) return 'script_runtime_error';
  return 'unknown_runtime_error';
}

function failureFamily(error: string): string {
  if (/ERR_ABORTED|canceled/i.test(error)) return 'aborted';
  if (/ERR_NAME_NOT_RESOLVED|ERR_DNS/i.test(error)) return 'dns';
  if (/TIMED_OUT|timeout/i.test(error)) return 'timeout';
  if (/ERR_CERT|SSL|TLS/i.test(error)) return 'tls';
  if (/ERR_CONNECTION|ERR_NETWORK|ERR_INTERNET/i.test(error)) return 'transport';
  return 'other';
}

function safeRequestLocation(raw: string): { host: string; path: string } | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const path = url.pathname.split('/').map((segment) =>
      segment.length > 48 || /(?:[a-f0-9]{16,}|[A-Za-z0-9_-]{32,}|%40|@)/i.test(segment) ? ':redacted' : segment
    ).join('/').slice(0, 160);
    return { host: url.hostname.toLowerCase().slice(0, 120), path };
  } catch { return null; }
}

/** Attach before navigation; retain only capped categories and sanitized request coordinates. */
export function attachRenderRuntimeDiagnostics(page: Page) {
  const result: RenderRuntimeDiagnostics = { page_error_count: 0, page_error_families: [], failed_request_count: 0, failed_request_samples: [] };
  const onPageError = (error: Error) => {
    result.page_error_count = Math.min(999, result.page_error_count + 1);
    const family = pageErrorFamily(error);
    if (!result.page_error_families.includes(family) && result.page_error_families.length < 10) result.page_error_families.push(family);
  };
  const onRequestFailed = (request: Request) => {
    const failure = request.failure()?.errorText || '';
    // The scanner's public-web guard aborts disallowed requests with this code.
    if (/blockedbyclient|ERR_BLOCKED_BY_CLIENT/i.test(failure)) return;
    const location = safeRequestLocation(request.url());
    if (!location) return;
    result.failed_request_count = Math.min(999, result.failed_request_count + 1);
    if (result.failed_request_samples.length < 10) result.failed_request_samples.push({
      ...location, resource_type: request.resourceType().slice(0, 24), failure_family: failureFamily(failure)
    });
  };
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  return {
    snapshot: (): RenderRuntimeDiagnostics => ({ ...result, page_error_families: [...result.page_error_families], failed_request_samples: result.failed_request_samples.map((item) => ({ ...item })) }),
    dispose: () => { page.off('pageerror', onPageError); page.off('requestfailed', onRequestFailed); }
  };
}
