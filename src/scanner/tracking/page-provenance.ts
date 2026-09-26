import type { BrowserContext, Page, Request } from 'playwright-core';

export interface PageProvenance {
  observed_page_id?: string;
  observed_page_url?: string;
  navigation_epoch?: number;
}

export function safeObservedPageUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2048);
  } catch { return undefined; }
}

function routeKey(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    // Query may identify an SPA route. It remains in memory and is never persisted.
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch { return undefined; }
}

export class PageProvenanceTracker {
  private readonly pages = new WeakMap<Page, { id: string; epoch: number; key?: string; raw: string; pendingEventUrl?: string }>();
  private nextPageId = 1;

  attach(context: BrowserContext): void {
    for (const page of context.pages()) this.register(page);
    context.on('page', (page) => this.register(page));
  }

  register(page: Page): void {
    if (this.pages.has(page)) return;
    const key = routeKey(page.url());
    const state = { id: `page_${this.nextPageId++}`, epoch: key ? 1 : 0, key, raw: page.url(), pendingEventUrl: undefined as string | undefined };
    this.pages.set(page, state);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const next = routeKey(frame.url());
      if (!next) return;
      const raw = frame.url();
      if (state.pendingEventUrl === raw) {
        state.pendingEventUrl = undefined;
        return;
      }
      state.pendingEventUrl = undefined;
      // Playwright emits this for document commits and History API URL changes.
      // A repeated URL is a document reload; a fragment-only change is noise.
      if (next !== state.key || raw === state.raw) {
        state.epoch += 1;
        state.key = next;
      }
      state.raw = raw;
    });
  }

  snapshot(page: Page): PageProvenance {
    this.register(page);
    const state = this.pages.get(page)!;
    const observed = routeKey(page.url());
    if (observed && observed !== state.key) {
      state.epoch += 1;
      state.key = observed;
      state.raw = page.url();
      state.pendingEventUrl = state.raw;
    }
    return {
      observed_page_id: state.id,
      observed_page_url: safeObservedPageUrl(page.url()),
      navigation_epoch: state.epoch || undefined
    };
  }

  forRequest(request: Request): PageProvenance {
    try {
      if (request.serviceWorker()) return {};
      const page = request.frame().page();
      return this.snapshot(page);
    } catch { return {}; }
  }
}
