import type { Page } from 'playwright-core';
import type { ProviderSemanticDiscovery, ProviderSemanticDiscoveryDiagnostic } from './provider-semantic-controls';
import { USERCENTRICS_STANDARD_ROOT } from './usercentrics-adapter';

const phrases = [
  ['Alles akzeptieren', 'accept_all'],
  ['Alles ablehnen', 'reject_all'],
  ['Alle ablehnen', 'reject_all'],
  ['Einstellungen verwalten', 'open_preferences'],
  ['Accept all', 'accept_all'],
  ['Reject all', 'reject_all']
] as const;

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** Only an open, provider-specific root can own an executable UC control. */
export async function discoverUsercentricsSemanticControls(page: Page): Promise<ProviderSemanticDiscovery> {
  const diagnostic: ProviderSemanticDiscoveryDiagnostic = {
    attempted: true, provider: 'usercentrics', role_candidate_count: 0, link_candidate_count: 0,
    open_shadow_candidate_count: 0, text_candidate_count: 0, actionable_control_count: 0,
    rejection_counts: { not_visible: 0, disabled: 0, not_direct_actionable_target: 0, outside_verified_consent_context: 0, unsupported_semantic_action: 0 },
    candidate_samples: []
  };
  const root = page.locator(USERCENTRICS_STANDARD_ROOT);
  if (await root.count().catch(() => 0) !== 1 || !await root.evaluate((element) => Boolean(element.shadowRoot)).catch(() => false)) {
    return { controls: [], diagnostic, invoke: async () => false };
  }
  const candidates = await root.locator('button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"]').all().catch(() => []);
  const matches: Array<{ locator: typeof candidates[number]; action: 'accept_all' | 'reject_all' | 'open_preferences'; label: string; enabled: boolean; visible: boolean; role: 'button' | 'link' }> = [];
  for (const candidate of candidates.slice(0, 40)) {
    const observation = await candidate.evaluate((element, rootSelector) => {
      const host = document.querySelector(rootSelector);
      let current: Node = element; let owned = false;
      for (let depth = 0; depth < 5; depth += 1) {
        const tree = current.getRootNode();
        if (!(tree instanceof ShadowRoot)) break;
        if (tree.host === host) { owned = true; break; }
        current = tree.host;
      }
      return {
        name: String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || ''),
        role: element.matches('a[href], [role="link"]') ? 'link' as const : 'button' as const,
        owned
      };
    }, USERCENTRICS_STANDARD_ROOT).catch(() => null);
    if (!observation) continue;
    const phrase = phrases.find(([label]) => normalize(observation.name) === normalize(label));
    if (!phrase) continue;
    const visible = await candidate.isVisible().catch(() => false);
    const enabled = await candidate.isEnabled().catch(() => false);
    diagnostic.open_shadow_candidate_count = Math.min(80, diagnostic.open_shadow_candidate_count + 1);
    if (!observation.owned) diagnostic.rejection_counts.outside_verified_consent_context += 1;
    else if (!visible) diagnostic.rejection_counts.not_visible += 1;
    else if (!enabled) diagnostic.rejection_counts.disabled += 1;
    if (diagnostic.candidate_samples.length < 20) diagnostic.candidate_samples.push({
      lookup_class: 'open_shadow', accessible_name: phrase[0], role: observation.role,
      accepted: observation.owned && visible && enabled,
      rejection_reason: !observation.owned ? 'outside_verified_consent_context' : !visible ? 'not_visible' : !enabled ? 'disabled' : null
    });
    if (observation.owned) matches.push({ locator: candidate, action: phrase[1], label: phrase[0], enabled, visible, role: observation.role });
  }
  const controls: ProviderSemanticDiscovery['controls'] = [];
  const targets = new Map<string, { locator: typeof candidates[number]; label: string }>();
  for (const action of ['accept_all', 'reject_all', 'open_preferences'] as const) {
    const actionable = matches.filter((item) => item.action === action && item.visible && item.enabled);
    // Duplicate owners make the target ambiguous even when their labels match.
    if (actionable.length !== 1) continue;
    const item = actionable[0];
    const id = `usercentrics-semantic:${action}`;
    targets.set(id, { locator: item.locator, label: item.label });
    controls.push({ id, action, accessible_name: item.label, visible: true, enabled: true, actionable: true,
      surface_id: USERCENTRICS_STANDARD_ROOT, location: 'main_frame', shadow_mode: 'open' });
  }
  diagnostic.actionable_control_count = controls.length;
  return { controls, diagnostic, invoke: async (id) => {
    const target = targets.get(id);
    if (!target || !await root.evaluate((element) => Boolean(element.shadowRoot)).catch(() => false)) return false;
    const current = await target.locator.evaluate((element, rootSelector) => {
      const host = document.querySelector(rootSelector);
      let node: Node = element; let owned = false;
      for (let depth = 0; depth < 5; depth += 1) {
        const tree = node.getRootNode();
        if (!(tree instanceof ShadowRoot)) break;
        if (tree.host === host) { owned = true; break; }
        node = tree.host;
      }
      return { owned, name: String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || '') };
    }, USERCENTRICS_STANDARD_ROOT).catch(() => null);
    if (!current?.owned || normalize(current.name) !== normalize(target.label) || !await target.locator.isVisible().catch(() => false) || !await target.locator.isEnabled().catch(() => false)) return false;
    return target.locator.click().then(() => true).catch(() => false);
  } };
}
