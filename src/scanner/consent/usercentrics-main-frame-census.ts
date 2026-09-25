import type { Page } from 'playwright-core';
import type { BrowserConsentFacts } from './browser-context-builders';
import { USERCENTRICS_BROWSER_UI_ROOT, USERCENTRICS_STANDARD_ROOT } from './usercentrics-adapter';

export type UsercentricsUiTopology = 'open_shadow_standard' | 'open_shadow_browser_ui' | 'main_frame_provider_owned' | 'main_frame_unowned' | 'closed_shadow' | 'absent' | 'ambiguous';
export type UsercentricsOwnershipReason = 'standard_root' | 'browser_ui_open_shadow_root' | 'provider_specific_main_frame_marker' | 'no_provider_marker' | 'ambiguous_multiple_roots' | 'ambiguous_multiple_first_layers' | 'ambiguous_multiple_surfaces' | 'ambiguous_multiple_controls' | 'unsupported_topology';
type SemanticInventory = Record<'reject_all' | 'accept_all' | 'open_preferences', {
  candidate_count: number; visible_count: number; enabled_count: number; directly_actionable_count: number;
}>;

export interface UsercentricsMainFrameCensus {
  usercentrics_surface_topology: UsercentricsUiTopology;
  main_frame_consent_surface_count: number;
  provider_owned_surface_count: number;
  reject_semantic_candidate_count: number;
  accept_semantic_candidate_count: number;
  preferences_semantic_candidate_count: number;
  provider_owned_reject_candidate_count: number;
  direct_actionable_reject_count: number;
  not_direct_actionable_target_count: number;
  semantic_control_inventory: SemanticInventory;
  browser_ui_root_present: boolean;
  browser_ui_root_count: number;
  browser_ui_shadow_open: boolean;
  first_layer_surface_count: number;
  browser_ui_identity_conflict_count: number;
  ownership_reason: UsercentricsOwnershipReason;
  surfaces: Array<{
    location: 'main_frame';
    element_role: 'dialog' | 'other';
    aria_modal: boolean;
    provider_marker_present: boolean;
    provider_marker_family: 'usercentrics_named_root' | null;
    ancestor_provider_marker_present: boolean;
    ancestor_provider_marker_family: 'usercentrics_named_root' | null;
    descendant_provider_marker_present: boolean;
    // A name prefix is a diagnostic hint only. It is not a certified owner.
    provider_prefix_candidate_present: boolean;
    reject_semantic_candidate_count: number;
    accept_semantic_candidate_count: number;
    preferences_semantic_candidate_count: number;
    direct_actionable_reject_count: number;
    not_direct_actionable_target_count: number;
    semantic_control_inventory: SemanticInventory;
  }>;
}

const EMPTY_INVENTORY: SemanticInventory = {
  reject_all: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 },
  accept_all: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 },
  open_preferences: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 }
};
const EMPTY_COUNTS = {
  main_frame_consent_surface_count: 0, provider_owned_surface_count: 0,
  reject_semantic_candidate_count: 0, accept_semantic_candidate_count: 0,
  preferences_semantic_candidate_count: 0, provider_owned_reject_candidate_count: 0,
  direct_actionable_reject_count: 0, not_direct_actionable_target_count: 0, semantic_control_inventory: EMPTY_INVENTORY,
  browser_ui_root_present: false, browser_ui_root_count: 0, browser_ui_shadow_open: false,
  first_layer_surface_count: 0, browser_ui_identity_conflict_count: 0
};

const BROWSER_UI_FIRST_LAYER = 'div#uc-center-container[role="dialog"][aria-modal="true"][data-testid="uc-tcf-first-layer"]';

/** The exact named Browser UI root is inspected before the generic main-frame census. */
async function captureBrowserUiCensus(page: Page): Promise<UsercentricsMainFrameCensus | null> {
  const observed = await page.evaluate(({ browserRoot, legacyRoot, layerSelector }) => {
    const roots = Array.from(document.querySelectorAll(browserRoot)).slice(0, 21);
    if (!roots.length) return null;
    const root = roots.length === 1 ? roots[0] : null;
    const shadow = root?.shadowRoot || null;
    const layers = shadow ? Array.from(shadow.querySelectorAll(layerSelector)).slice(0, 21) : [];
    const visible = (element: Element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const currentLayers = layers.filter(visible);
    const layer = currentLayers.length === 1 ? currentLayers[0] : null;
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const identities = [
      { action: 'reject_all', testId: 'uc-deny-all-button', labels: ['alles ablehnen', 'alle ablehnen', 'reject all'] },
      { action: 'accept_all', testId: 'uc-accept-all-button', labels: ['alles akzeptieren', 'accept all'] },
      { action: 'open_preferences', testId: 'uc-customize-button', labels: ['einstellungen verwalten'] }
    ] as const;
    const inventory = {
      reject_all: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 },
      accept_all: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 },
      open_preferences: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 }
    };
    let ownedReject = 0; let conflicts = 0; let notDirect = 0;
    for (const control of shadow ? Array.from(shadow.querySelectorAll('button[data-testid]')).slice(0, 40) : []) {
      const identity = identities.find((item) => item.testId === control.getAttribute('data-testid'));
      if (!identity) continue;
      const label = normalize(String(control.getAttribute('aria-label') || control.textContent || ''));
      const agrees = identity.labels.some((item) => normalize(item) === label);
      if (!agrees) {
        const descendantExpected = Boolean(control.getAttribute('aria-label')) &&
          identity.labels.some((item) => normalize(item) === normalize(String(control.textContent || '')));
        if (descendantExpected) notDirect = Math.min(20, notDirect + 1);
        else conflicts = Math.min(20, conflicts + 1);
        continue;
      }
      if (!(layer && control.getRootNode() === shadow && control.closest(layerSelector) === layer)) continue;
      const count = inventory[identity.action];
      const isVisible = visible(control);
      const isEnabled = !(control as HTMLButtonElement).disabled && control.getAttribute('aria-disabled') !== 'true';
      count.candidate_count = Math.min(20, count.candidate_count + 1);
      if (isVisible) count.visible_count = Math.min(20, count.visible_count + 1);
      if (isEnabled) count.enabled_count = Math.min(20, count.enabled_count + 1);
      if (isVisible && isEnabled) count.directly_actionable_count = Math.min(20, count.directly_actionable_count + 1);
      if (identity.action === 'reject_all') ownedReject = Math.min(20, ownedReject + 1);
    }
    return {
      rootCount: Math.min(20, roots.length), legacyRootCount: Math.min(20, document.querySelectorAll(legacyRoot).length),
      shadowOpen: Boolean(shadow), firstLayerCount: Math.min(20, currentLayers.length),
      inventory, ownedReject, conflicts, notDirect
    };
  }, { browserRoot: USERCENTRICS_BROWSER_UI_ROOT, legacyRoot: USERCENTRICS_STANDARD_ROOT, layerSelector: BROWSER_UI_FIRST_LAYER });
  if (!observed) return null;
  const duplicateControls = Object.values(observed.inventory).some((item) => item.candidate_count > 1);
  const ambiguousRoots = observed.rootCount !== 1 || observed.legacyRootCount > 0;
  const ambiguousLayers = observed.firstLayerCount > 1;
  const qualified = observed.shadowOpen && observed.firstLayerCount === 1 && !ambiguousRoots;
  const ambiguous = ambiguousRoots || ambiguousLayers || duplicateControls;
  const topology: UsercentricsUiTopology = ambiguous ? 'ambiguous' : !observed.shadowOpen ? 'closed_shadow'
    : qualified ? 'open_shadow_browser_ui' : 'absent';
  const reason: UsercentricsOwnershipReason = ambiguousRoots ? 'ambiguous_multiple_roots'
    : ambiguousLayers ? 'ambiguous_multiple_first_layers' : duplicateControls ? 'ambiguous_multiple_controls'
      : qualified ? 'browser_ui_open_shadow_root' : 'unsupported_topology';
  return {
    ...EMPTY_COUNTS,
    usercentrics_surface_topology: topology, ownership_reason: reason,
    provider_owned_surface_count: qualified && !ambiguous ? 1 : 0,
    browser_ui_root_present: true, browser_ui_root_count: observed.rootCount,
    browser_ui_shadow_open: observed.shadowOpen, first_layer_surface_count: observed.firstLayerCount,
    browser_ui_identity_conflict_count: observed.conflicts,
    not_direct_actionable_target_count: observed.notDirect,
    reject_semantic_candidate_count: observed.inventory.reject_all.candidate_count,
    accept_semantic_candidate_count: observed.inventory.accept_all.candidate_count,
    preferences_semantic_candidate_count: observed.inventory.open_preferences.candidate_count,
    provider_owned_reject_candidate_count: qualified && !ambiguous ? observed.ownedReject : 0,
    direct_actionable_reject_count: observed.inventory.reject_all.directly_actionable_count,
    semantic_control_inventory: observed.inventory,
    surfaces: []
  };
}

/** Diagnostic only. Its output is never an invoke_control input or target reference. */
export async function captureUsercentricsMainFrameCensus(page: Page, facts: BrowserConsentFacts, bannerVisible: boolean): Promise<UsercentricsMainFrameCensus> {
  const browserUi = await captureBrowserUiCensus(page);
  if (browserUi) return browserUi;
  if (facts.usercentrics.present && facts.usercentrics.shadow_mode === 'open')
    return { ...EMPTY_COUNTS, usercentrics_surface_topology: 'open_shadow_standard', ownership_reason: 'standard_root', surfaces: [] };
  if (facts.usercentrics.present && facts.usercentrics.shadow_mode === 'closed')
    return { ...EMPTY_COUNTS, usercentrics_surface_topology: 'closed_shadow', ownership_reason: 'unsupported_topology', surfaces: [] };
  if (!bannerVisible)
    return { ...EMPTY_COUNTS, usercentrics_surface_topology: 'absent', ownership_reason: 'unsupported_topology', surfaces: [] };

  // These indexes refer only to the same bounded generic-surface enumeration in
  // captureBrowserConsentFacts. Recheck visibility in the page for DOM churn.
  const qualified = facts.generic.surfaces.map((surface, index) => ({ surface, index }))
    .filter(({ surface }) => surface.location === 'main_frame' && surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent' && surface.strong_presentation);
  const indexes = qualified.slice(0, 8).map(({ index }) => index);
  const surfaces = await page.evaluate(({ indexes }) => {
    const selector = '[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i]';
    const enumerated = Array.from(document.querySelectorAll(selector)).slice(0, 30);
    const cap = (count: number) => Math.min(20, count);
    const visible = (element: Element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
    const semantic = (name: string) => {
      const value = normalize(name);
      if (value === 'alles ablehnen' || value === 'alle ablehnen' || value === 'reject all') return 'reject';
      if (value === 'alles akzeptieren' || value === 'accept all') return 'accept';
      if (value === 'einstellungen verwalten') return 'preferences';
      return null;
    };
    // The only verified marker is the existing exact standard root. A full
    // "usercentrics-" prefix is reported only as a candidate for later review.
    const exactRoot = (element: Element) => element.matches('aside#usercentrics-cmp-ui');
    const prefixCandidate = (element: Element) => {
      const tokens = [element.id, ...Array.from(element.classList)];
      return tokens.some((token) => /^usercentrics[-_]/i.test(token)) ||
        Array.from(element.attributes).some((attribute) => /^data-usercentrics(?:[-_]|$)/i.test(attribute.name));
    };
    return indexes.map((index) => {
      const surface = enumerated[index];
      if (!surface || !visible(surface)) return null;
      let ancestor: Element | null = surface.parentElement;
      let ancestorMarker = false; let ancestorPrefix = false;
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        ancestorMarker ||= exactRoot(ancestor);
        ancestorPrefix ||= prefixCandidate(ancestor);
      }
      const descendants = Array.from(surface.querySelectorAll('*')).slice(0, 100);
      const descendantMarker = descendants.some(exactRoot);
      const prefix = prefixCandidate(surface) || ancestorPrefix || descendants.some(prefixCandidate);
      const counts = { reject: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 },
        accept: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 },
        preferences: { candidate_count: 0, visible_count: 0, enabled_count: 0, directly_actionable_count: 0 }, notDirect: 0 };
      const controls = Array.from(surface.querySelectorAll('button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"]')).slice(0, 40);
      for (const control of controls) {
        const aria = control.getAttribute('aria-label');
        const name = String(aria || (control instanceof HTMLInputElement ? control.value : '') || control.textContent || '');
        const action = semantic(name);
        const descendantAction = aria ? semantic(String(control.textContent || '')) : null;
        if (!action && descendantAction) counts.notDirect = cap(counts.notDirect + 1);
        if (!action) continue;
        const count = counts[action];
        const isVisible = visible(control);
        const isEnabled = !(control as HTMLButtonElement).disabled && control.getAttribute('aria-disabled') !== 'true';
        count.candidate_count = cap(count.candidate_count + 1);
        if (isVisible) count.visible_count = cap(count.visible_count + 1);
        if (isEnabled) count.enabled_count = cap(count.enabled_count + 1);
        if (isVisible && isEnabled) count.directly_actionable_count = cap(count.directly_actionable_count + 1);
      }
      return {
        location: 'main_frame' as const, element_role: surface.getAttribute('role') === 'dialog' ? 'dialog' as const : 'other' as const,
        aria_modal: surface.getAttribute('aria-modal') === 'true',
        provider_marker_present: exactRoot(surface), provider_marker_family: exactRoot(surface) ? 'usercentrics_named_root' as const : null,
        ancestor_provider_marker_present: ancestorMarker, ancestor_provider_marker_family: ancestorMarker ? 'usercentrics_named_root' as const : null,
        descendant_provider_marker_present: descendantMarker, provider_prefix_candidate_present: prefix,
        reject_semantic_candidate_count: counts.reject.candidate_count, accept_semantic_candidate_count: counts.accept.candidate_count,
        preferences_semantic_candidate_count: counts.preferences.candidate_count, direct_actionable_reject_count: counts.reject.directly_actionable_count,
        not_direct_actionable_target_count: counts.notDirect,
        semantic_control_inventory: { reject_all: counts.reject, accept_all: counts.accept, open_preferences: counts.preferences }
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
  }, { indexes });
  const sum = (key: 'reject_semantic_candidate_count' | 'accept_semantic_candidate_count' | 'preferences_semantic_candidate_count' | 'direct_actionable_reject_count' | 'not_direct_actionable_target_count') =>
    Math.min(20, surfaces.reduce((count, surface) => count + surface[key], 0));
  const inventory = (action: keyof SemanticInventory) => ({
    candidate_count: Math.min(20, surfaces.reduce((count, surface) => count + surface.semantic_control_inventory[action].candidate_count, 0)),
    visible_count: Math.min(20, surfaces.reduce((count, surface) => count + surface.semantic_control_inventory[action].visible_count, 0)),
    enabled_count: Math.min(20, surfaces.reduce((count, surface) => count + surface.semantic_control_inventory[action].enabled_count, 0)),
    directly_actionable_count: Math.min(20, surfaces.reduce((count, surface) => count + surface.semantic_control_inventory[action].directly_actionable_count, 0))
  });
  const count = Math.min(20, qualified.length);
  // No checked-in evidence certifies a second main-frame owner. Even an exact
  // named root without its open shadow is unsupported for executable controls.
  const unsupportedNamedRoot = surfaces.some((surface) => surface.provider_marker_present || surface.ancestor_provider_marker_present || surface.descendant_provider_marker_present);
  const ambiguous = count > 1 || sum('direct_actionable_reject_count') > 1 || unsupportedNamedRoot;
  return {
    ...EMPTY_COUNTS,
    usercentrics_surface_topology: ambiguous ? 'ambiguous' : 'main_frame_unowned',
    main_frame_consent_surface_count: count, provider_owned_surface_count: 0,
    reject_semantic_candidate_count: sum('reject_semantic_candidate_count'),
    accept_semantic_candidate_count: sum('accept_semantic_candidate_count'),
    preferences_semantic_candidate_count: sum('preferences_semantic_candidate_count'),
    provider_owned_reject_candidate_count: 0,
    direct_actionable_reject_count: sum('direct_actionable_reject_count'),
    not_direct_actionable_target_count: sum('not_direct_actionable_target_count'),
    semantic_control_inventory: { reject_all: inventory('reject_all'), accept_all: inventory('accept_all'), open_preferences: inventory('open_preferences') },
    ownership_reason: count > 1 ? 'ambiguous_multiple_surfaces' : sum('direct_actionable_reject_count') > 1 ? 'ambiguous_multiple_controls' : unsupportedNamedRoot ? 'unsupported_topology' : 'no_provider_marker',
    surfaces
  };
}
