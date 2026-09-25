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
  diagnostic: ProviderSemanticDiscoveryDiagnostic;
  invoke(id: string): Promise<boolean>;
};

export type DiagnosticConsentControlCensusRecord = {
  role: 'button' | 'link' | 'input' | 'other';
  accessible_name: string;
  visible: boolean;
  enabled: boolean;
  direct_actionable_target: boolean;
  location: 'main_frame' | 'iframe' | 'shadow_dom';
  shadow_depth: number;
  consent_scope_corroborated: true;
};

type ProviderSemanticLookupClass = 'role' | 'link' | 'open_shadow' | 'text' | 'direct_action';
type ProviderSemanticRejectionReason = 'not_visible' | 'disabled' | 'not_direct_actionable_target' | 'outside_verified_consent_context' | 'unsupported_semantic_action';
export type ProviderSemanticDiscoveryDiagnostic = {
  attempted: boolean;
  provider: 'cookiebot' | 'didomi' | 'usercentrics' | null;
  role_candidate_count: number;
  link_candidate_count: number;
  open_shadow_candidate_count: number;
  text_candidate_count: number;
  actionable_control_count: number;
  /** Only the Usercentrics Browser UI path uses this bounded identity mismatch count. */
  semantic_identity_conflict_count?: number;
  rejection_counts: Record<ProviderSemanticRejectionReason, number>;
  candidate_samples: Array<{
    lookup_class: ProviderSemanticLookupClass;
    accessible_name: string;
    role: 'button' | 'link' | 'input' | 'other';
    accepted: boolean;
    rejection_reason: ProviderSemanticRejectionReason | null;
  }>;
};

const labels: Record<Extract<CmpAdapterProviderId, 'cookiebot' | 'didomi' | 'usercentrics'>, readonly string[]> = {
  cookiebot: ['ALLE AKZEPTIEREN', 'NUR NOTWENDIGE'],
  didomi: ['Tout accepter', 'Continuer sans accepter', 'Personnaliser'],
  usercentrics: ['Alles akzeptieren', 'Alles ablehnen', 'Einstellungen verwalten']
};

const supported = (provider: CmpAdapterProviderId): provider is keyof typeof labels => provider in labels;

function normalizeSemanticLabel(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function semanticLabelEquals(candidate: string, expected: string) {
  return normalizeSemanticLabel(candidate) === normalizeSemanticLabel(expected);
}

function semanticLabelPattern(label: string) {
  const words = normalizeSemanticLabel(label).split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*${words.join('\\s+')}\\s*$`, 'i');
}

function emptyDiagnostic(provider: ProviderSemanticDiscoveryDiagnostic['provider'], attempted: boolean): ProviderSemanticDiscoveryDiagnostic {
  return {
    attempted,
    provider,
    role_candidate_count: 0,
    link_candidate_count: 0,
    open_shadow_candidate_count: 0,
    text_candidate_count: 0,
    actionable_control_count: 0,
    rejection_counts: { not_visible: 0, disabled: 0, not_direct_actionable_target: 0, outside_verified_consent_context: 0, unsupported_semantic_action: 0 },
    candidate_samples: []
  };
}

/**
 * A bounded provider-first fallback for vendor templates whose DOM bridge is
 * unable to expose their controls. Locator text matching is exact and only
 * becomes a Consent action after the element's actionable, local Consent
 * context has been verified. Targets remain transient and are never stored.
 */
export async function discoverProviderSemanticControls(page: Page, provider: CmpAdapterProviderId): Promise<ProviderSemanticDiscovery> {
  if (!supported(provider)) return { controls: [], diagnostic: emptyDiagnostic(null, false), invoke: async () => false };
  const frames = page.frames().filter((frame) => frame === page.mainFrame() || frame.parentFrame() === page.mainFrame()).slice(0, 10);
  const targets = new Map<string, Locator>();
  const controls: ProviderSemanticControl[] = [];
  const diagnostic = emptyDiagnostic(provider, true);
  const retainCandidate = (candidate: ProviderSemanticDiscoveryDiagnostic['candidate_samples'][number]) => {
    if (diagnostic.candidate_samples.length < 20) diagnostic.candidate_samples.push(candidate);
    if (candidate.rejection_reason) diagnostic.rejection_counts[candidate.rejection_reason] = Math.min(80, diagnostic.rejection_counts[candidate.rejection_reason] + 1);
  };
  let sequence = 0;
  for (const [frameIndex, frame] of frames.entries()) {
    for (const label of labels[provider]) {
      if (controls.some((control) => control.accessible_name === label)) continue;
      const labelPattern = semanticLabelPattern(label);
      const buttonCandidates = await frame.getByRole('button', { name: labelPattern }).all().catch(() => []);
      const linkCandidates = await frame.getByRole('link', { name: labelPattern }).all().catch(() => []);
      const openShadowCandidates = (await Promise.all((await frame.locator('button, input[type="button"], input[type="submit"], a[href], [role="button"], [role="link"]').all().catch(() => [])).slice(0, 40).map(async (candidate) => ({ candidate, name: await candidate.evaluate((element) => String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '') })))).filter((item) => semanticLabelEquals(item.name, label)).map((item) => item.candidate);
      const directActionCandidates = (await Promise.all((await frame.locator('[onclick]').all().catch(() => [])).slice(0, 40).map(async (candidate) => ({ candidate, name: await candidate.evaluate((element) => String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '') })))).filter((item) => semanticLabelEquals(item.name, label)).map((item) => item.candidate);
      const textCandidates = await frame.getByText(labelPattern).all().catch(() => []);
      diagnostic.role_candidate_count = Math.min(80, diagnostic.role_candidate_count + buttonCandidates.length);
      diagnostic.link_candidate_count = Math.min(80, diagnostic.link_candidate_count + linkCandidates.length);
      diagnostic.open_shadow_candidate_count = Math.min(80, diagnostic.open_shadow_candidate_count + openShadowCandidates.length);
      diagnostic.text_candidate_count = Math.min(80, diagnostic.text_candidate_count + textCandidates.length);
      // The role locators resolve the actual actionable element. Exact text is
      // intentionally secondary and is retained only for directly actionable
      // legacy controls; a text descendant is never persisted as a target.
      const candidates: Array<{ candidate: Locator; lookup_class: ProviderSemanticLookupClass }> = [
        ...buttonCandidates.map((candidate) => ({ candidate, lookup_class: 'role' as const })),
        ...linkCandidates.map((candidate) => ({ candidate, lookup_class: 'link' as const })),
        ...openShadowCandidates.map((candidate) => ({ candidate, lookup_class: 'open_shadow' as const })),
        ...directActionCandidates.map((candidate) => ({ candidate, lookup_class: 'direct_action' as const })),
        ...textCandidates.map((candidate) => ({ candidate, lookup_class: 'text' as const }))
      ].slice(0, 8);
      for (const { candidate, lookup_class } of candidates) {
        const action = semanticActionForConsentLabel(label);
        if (action !== 'accept_all' && action !== 'reject_all' && action !== 'only_necessary' && action !== 'open_preferences') {
          retainCandidate({ lookup_class, accessible_name: label, role: 'other', accepted: false, rejection_reason: 'unsupported_semantic_action' });
          continue;
        }
        const resolved = await resolveActionableConsentTarget(candidate).catch(() => ({ accepted: false as const, rejection_reason: 'not_visible' as const, role: 'other' as const }));
        retainCandidate({ lookup_class, accessible_name: label, role: resolved.role, accepted: resolved.accepted, rejection_reason: resolved.rejection_reason });
        if (!resolved.accepted) continue;
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

/**
 * Diagnostic-only accessibility census. It enumerates bounded actionable
 * roles, keeps only controls corroborated by a local strong Consent scope, and
 * obtains the computed accessible name from Playwright's accessibility tree.
 */
export async function captureDiagnosticConsentControlCensus(page: Page): Promise<DiagnosticConsentControlCensusRecord[]> {
  const frames = page.frames().filter((frame) => frame === page.mainFrame() || frame.parentFrame() === page.mainFrame()).slice(0, 10);
  const visibleCandidates: Array<{ locator: Locator; frame: Frame; sequence: number }> = [];
  const remainingCandidates: Array<{ locator: Locator; frame: Frame; sequence: number }> = [];
  let sequence = 0;
  for (const frame of frames) {
    for (const [visibleLocator, allLocator] of [
      [frame.getByRole('button'), frame.getByRole('button', { includeHidden: true })],
      [frame.getByRole('link'), frame.getByRole('link', { includeHidden: true })]
    ]) {
      const visibleMatches = await visibleLocator.all().catch(() => []);
      const allMatches = await allLocator.all().catch(() => []);
      for (const candidate of visibleMatches.slice(0, 20)) visibleCandidates.push({ locator: candidate, frame, sequence: sequence++ });
      for (const candidate of allMatches.slice(0, 20)) remainingCandidates.push({ locator: candidate, frame, sequence: sequence++ });
    }
  }
  const candidates = [...visibleCandidates, ...remainingCandidates].slice(0, 200);
  const inspected = (await Promise.all(candidates.map(async ({ locator, frame, sequence: order }) => {
    const metadata = await locator.evaluate((element) => {
      const visible = (node: Element) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = getComputedStyle(node); const box = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const enabled = !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true';
      const tag = element.tagName.toLowerCase(); const explicitRole = element.getAttribute('role');
      const role: DiagnosticConsentControlCensusRecord['role'] = tag === 'input' ? 'input'
        : explicitRole === 'button' || tag === 'button' ? 'button'
          : explicitRole === 'link' || tag === 'a' ? 'link' : 'other';
      const direct = element.matches('button, a[href], input[type="button"], input[type="submit"]') || explicitRole === 'button' || explicitRole === 'link';
      let shadowDepth = 0; let root: Node = element;
      while (root.getRootNode() instanceof ShadowRoot && shadowDepth < 4) { root = (root.getRootNode() as ShadowRoot).host; shadowDepth += 1; }
      const parent = (node: Element) => node.parentElement || (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null);
      let scope: Element | null = element; let corroborated = false;
      for (let level = 0; scope && level < 8; level += 1) {
        const style = scope instanceof HTMLElement ? getComputedStyle(scope) : null;
        const marker = `${scope.id} ${scope.getAttribute('class') || ''} ${scope.getAttribute('role') || ''}`;
        const boundedText = String((scope as HTMLElement).innerText || scope.textContent || '').slice(0, 1200);
        const consentSemantics = /cookie|consent|privacy|tracking|cybot/i.test(`${marker} ${boundedText}`);
        const strong = scope.getAttribute('role') === 'dialog' || scope.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky';
        if (scope !== document.body && scope !== document.documentElement && visible(scope) && consentSemantics && strong) { corroborated = true; break; }
        scope = parent(scope);
      }
      return { visible: visible(element), enabled, role, direct, shadowDepth, corroborated };
    }).catch(() => null);
    if (!metadata?.corroborated) return null;
    return { locator, frame, order, ...metadata };
  }))).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const priority = (item: typeof inspected[number]) => item.visible && item.enabled && item.direct ? 0
    : item.visible && item.direct ? 1 : item.visible ? 2 : item.enabled && item.direct ? 3 : 4;
  inspected.sort((left, right) => priority(left) - priority(right) || left.order - right.order);
  const records: DiagnosticConsentControlCensusRecord[] = [];
  const retained = new Set<string>();
  const named = await Promise.all(inspected.slice(0, 40).map(async (item) => {
    const snapshot = await item.locator.ariaSnapshot({ depth: 1, timeout: 500 }).catch(() => '');
    const match = snapshot.trim().split(/\r?\n/, 1)[0]?.match(/^\s*-\s+[^\s:]+(?:\s+"((?:\\.|[^"\\])*)")?/);
    let accessibleName = '';
    if (match?.[1]) {
      try { accessibleName = JSON.parse(`"${match[1]}"`); } catch { accessibleName = match[1]; }
    }
    return { item, accessibleName: accessibleName.replace(/\s+/g, ' ').trim().slice(0, 120) };
  }));
  for (const { item, accessibleName } of named) {
    if (records.length >= 20) break;
    if (!accessibleName) continue;
    const normalizedLocation: DiagnosticConsentControlCensusRecord['location'] = item.shadowDepth > 0 ? 'shadow_dom' : item.frame === page.mainFrame() ? 'main_frame' : 'iframe';
    const key = `${item.role}:${normalizedLocation}:${item.shadowDepth}:${accessibleName}`;
    if (retained.has(key)) continue;
    retained.add(key);
    records.push({ role: item.role, accessible_name: accessibleName, visible: item.visible, enabled: item.enabled, direct_actionable_target: item.direct, location: normalizedLocation, shadow_depth: item.shadowDepth, consent_scope_corroborated: true });
  }
  return records;
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
    const normalizedRole = (node: Element): 'button' | 'link' | 'input' | 'other' => {
      const role = node.getAttribute('role');
      if (role === 'button' || node.tagName.toLowerCase() === 'button') return 'button';
      if (role === 'link' || node.tagName.toLowerCase() === 'a') return 'link';
      if (node.tagName.toLowerCase() === 'input') return 'input';
      return 'other';
    };
    let actionable: Element | null = element;
    for (let level = 0; actionable && level < 5; level += 1) {
      if (interactive(actionable)) break;
      actionable = parent(actionable);
    }
    const role = actionable ? normalizedRole(actionable) : normalizedRole(element);
    if (!actionable || !interactive(actionable) || actionable !== element) return { accepted: false as const, rejection_reason: 'not_direct_actionable_target' as const, role };
    if (!visible(actionable)) return { accepted: false as const, rejection_reason: 'not_visible' as const, role };
    if (actionable.getAttribute('aria-disabled') === 'true' || (actionable as HTMLButtonElement).disabled) return { accepted: false as const, rejection_reason: 'disabled' as const, role };
    let scope: Element | null = actionable;
    for (let level = 0; scope && level < 6; level += 1) {
      const marker = `${scope.id} ${scope.getAttribute('class') || ''} ${scope.getAttribute('role') || ''} ${(scope as HTMLElement).innerText || scope.textContent || ''}`.slice(0, 1200);
      if (scope.getAttribute('role') === 'dialog' || scope.getAttribute('aria-modal') === 'true' || /cookie|consent|privacy|cookiebot|didomi|usercentrics/i.test(marker)) return { accepted: true as const, rejection_reason: null, role };
      scope = parent(scope);
    }
    return { accepted: false as const, rejection_reason: 'outside_verified_consent_context' as const, role };
  });
}
