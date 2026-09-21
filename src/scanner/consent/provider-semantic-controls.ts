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
  diagnostic: { attempted: boolean; provider: 'cookiebot' | 'didomi' | 'usercentrics' | null; role_candidate_count: number; link_candidate_count: number; open_shadow_candidate_count: number; text_candidate_count: number; actionable_control_count: number };
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
  if (!supported(provider)) return { controls: [], diagnostic: { attempted: false, provider: null, role_candidate_count: 0, link_candidate_count: 0, open_shadow_candidate_count: 0, text_candidate_count: 0, actionable_control_count: 0 }, invoke: async () => false };
  const frames = page.frames().filter((frame) => frame === page.mainFrame() || frame.parentFrame() === page.mainFrame()).slice(0, 10);
  const targets = new Map<string, Locator>();
  const controls: ProviderSemanticControl[] = [];
  const diagnostic = { attempted: true, provider, role_candidate_count: 0, link_candidate_count: 0, open_shadow_candidate_count: 0, text_candidate_count: 0, actionable_control_count: 0 };
  let sequence = 0;
  for (const [frameIndex, frame] of frames.entries()) {
    for (const label of labels[provider]) {
      if (controls.some((control) => control.accessible_name === label)) continue;
      const buttonCandidates = await frame.getByRole('button', { name: label, exact: true }).all().catch(() => []);
      const linkCandidates = await frame.getByRole('link', { name: label, exact: true }).all().catch(() => []);
      const openShadowCandidates = (await Promise.all((await frame.locator('button, input[type="button"], input[type="submit"], a[href], [role="button"], [role="link"]').all().catch(() => [])).slice(0, 40).map(async (candidate) => ({ candidate, name: await candidate.evaluate((element) => String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '') })))).filter((item) => item.name === label).map((item) => item.candidate);
      const textCandidates = await frame.getByText(label, { exact: true }).all().catch(() => []);
      diagnostic.role_candidate_count = Math.min(80, diagnostic.role_candidate_count + buttonCandidates.length);
      diagnostic.link_candidate_count = Math.min(80, diagnostic.link_candidate_count + linkCandidates.length);
      diagnostic.open_shadow_candidate_count = Math.min(80, diagnostic.open_shadow_candidate_count + openShadowCandidates.length);
      diagnostic.text_candidate_count = Math.min(80, diagnostic.text_candidate_count + textCandidates.length);
      // The role locators resolve the actual actionable element. Exact text is
      // intentionally secondary and is retained only for directly actionable
      // legacy controls; a text descendant is never persisted as a target.
      const candidates = [...buttonCandidates, ...linkCandidates, ...openShadowCandidates, ...textCandidates].slice(0, 8);
      for (const candidate of candidates) {
        if (!await candidate.isVisible().catch(() => false)) continue;
        const resolved = await resolveActionableConsentTarget(candidate).catch(() => null);
        if (!resolved?.enabled || !resolved.direct) continue;
        const action = semanticActionForConsentLabel(label);
        if (action !== 'accept_all' && action !== 'reject_all' && action !== 'only_necessary' && action !== 'open_preferences') continue;
        const id = `provider-semantic:${frameIndex}:${sequence++}`;
        targets.set(id, candidate);
        controls.push({ id, action, accessible_name: label, visible: true, enabled: true, actionable: true, surface_id: `provider-fallback:${frameIndex}`, location: frame === page.mainFrame() ? 'main_frame' : 'child_frame', shadow_mode: 'open' });
        diagnostic.actionable_control_count = controls.length;
        break;
      }
    }
  }
  return { controls, diagnostic, invoke: async (id) => targets.get(id)?.click().then(() => true).catch(() => false) || false };
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
      if (scope.getAttribute('role') === 'dialog' || scope.getAttribute('aria-modal') === 'true' || /cookie|consent|privacy|cookiebot|didomi|usercentrics/i.test(marker)) return { enabled: actionable.getAttribute('aria-disabled') !== 'true' && !(actionable as HTMLButtonElement).disabled, direct: actionable === element };
      scope = parent(scope);
    }
    return null;
  });
}
