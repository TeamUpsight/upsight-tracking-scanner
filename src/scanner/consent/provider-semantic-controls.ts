import type { Frame, Locator, Page } from 'playwright-core';
import type { CmpAdapterProviderId } from './adapter-registry';
import { semanticActionForConsentLabel } from './generic-consent-detector';

export type ProviderSemanticControl = {
  id: string;
  action: 'accept_all' | 'reject_all' | 'only_necessary' | 'open_preferences';
  accessible_name: string;
  visible: true;
  enabled: boolean;
  actionable: true;
  surface_id: string;
  location: 'main_frame' | 'child_frame';
  shadow_mode: 'open' | 'none';
};

export type ProviderSemanticDiscovery = {
  controls: ProviderSemanticControl[];
  invoke(id: string): Promise<boolean>;
};

const labels: Record<Extract<CmpAdapterProviderId, 'cookiebot' | 'didomi' | 'usercentrics'>, readonly string[]> = {
  cookiebot: ['ALLE AKZEPTIEREN', 'NUR NOTWENDIGE'],
  didomi: ['Tout accepter', 'Continuer sans accepter', 'Personnaliser'],
  usercentrics: ['Alles akzeptieren', 'Alles ablehnen', 'Einstellungen verwalten']
};

const supported = (provider: CmpAdapterProviderId): provider is keyof typeof labels => provider in labels;

/**
 * A bounded provider-first fallback for vendor templates whose DOM bridge is
 * unable to expose their controls. Locator text matching is exact and only
 * becomes a Consent action after the element's actionable, local Consent
 * context has been verified. Targets remain transient and are never stored.
 */
export async function discoverProviderSemanticControls(page: Page, provider: CmpAdapterProviderId): Promise<ProviderSemanticDiscovery> {
  if (!supported(provider)) return { controls: [], invoke: async () => false };
  const frames = page.frames().filter((frame) => frame === page.mainFrame() || frame.parentFrame() === page.mainFrame()).slice(0, 10);
  const targets = new Map<string, Locator>();
  const controls: ProviderSemanticControl[] = [];
  let sequence = 0;
  for (const [frameIndex, frame] of frames.entries()) {
    for (const label of labels[provider]) {
      if (controls.some((control) => control.accessible_name === label)) continue;
      const candidates = await frame.getByText(label, { exact: true }).all().catch(() => []);
      for (const candidate of candidates.slice(0, 8)) {
        if (!await candidate.isVisible().catch(() => false)) continue;
        const resolved = await resolveActionableConsentTarget(candidate).catch(() => null);
        if (!resolved?.enabled) continue;
        const action = semanticActionForConsentLabel(label);
        if (action !== 'accept_all' && action !== 'reject_all' && action !== 'only_necessary' && action !== 'open_preferences') continue;
        const id = `provider-semantic:${frameIndex}:${sequence++}`;
        targets.set(id, candidate);
        controls.push({ id, action, accessible_name: label, visible: true, enabled: true, actionable: true, surface_id: `provider-fallback:${frameIndex}`, location: frame === page.mainFrame() ? 'main_frame' : 'child_frame', shadow_mode: 'open' });
        break;
      }
    }
  }
  return { controls, invoke: async (id) => targets.get(id)?.click().then(() => true).catch(() => false) || false };
}

async function resolveActionableConsentTarget(locator: Locator) {
  return locator.evaluate((element) => {
    const visible = (node: Element) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = getComputedStyle(node); const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const parent = (node: Element) => node.parentElement || (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null);
    const interactive = (node: Element) => {
      const role = node.getAttribute('role'); const tabindex = Number(node.getAttribute('tabindex'));
      return node.matches('button, a[href], input[type="button"], input[type="submit"]') || role === 'button' || role === 'link' ||
        (node.hasAttribute('tabindex') && Number.isFinite(tabindex) && tabindex >= 0) || node.hasAttribute('onclick');
    };
    let actionable: Element | null = element;
    for (let level = 0; actionable && level < 5; level += 1) {
      if (interactive(actionable) && visible(actionable) && actionable.getAttribute('aria-disabled') !== 'true' && !(actionable as HTMLButtonElement).disabled) break;
      actionable = parent(actionable);
    }
    if (!actionable || !interactive(actionable) || !visible(actionable)) return null;
    let scope: Element | null = actionable;
    for (let level = 0; scope && level < 6; level += 1) {
      const marker = `${scope.id} ${scope.getAttribute('class') || ''} ${scope.getAttribute('role') || ''} ${(scope as HTMLElement).innerText || scope.textContent || ''}`.slice(0, 1200);
      if (scope.getAttribute('role') === 'dialog' || scope.getAttribute('aria-modal') === 'true' || /cookie|consent|privacy|cookiebot|didomi|usercentrics/i.test(marker)) return { enabled: actionable.getAttribute('aria-disabled') !== 'true' && !(actionable as HTMLButtonElement).disabled };
      scope = parent(scope);
    }
    return null;
  });
}
