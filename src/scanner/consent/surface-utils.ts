import type { Frame, FrameLocator, Locator, Page } from 'playwright-core';
import { ConsentAuditCodes, type ConsentAuditCode } from './domain-types';

export type ConsentSurfaceType = 'banner' | 'dialog' | 'drawer' | 'preference_center' | 'unknown';
export type ShadowMode = 'none' | 'open' | 'closed' | 'unknown';

export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceVisibility {
  attached: boolean;
  connected: boolean | null;
  visible: boolean;
  non_zero_dimensions: boolean;
  enabled: boolean | null;
  occluded: boolean | null;
  actionable: boolean | null;
  error_code: ConsentAuditCode | null;
}

export interface SurfaceCandidate {
  surface_type: ConsentSurfaceType;
  locator: Locator;
  frame: Frame;
  frame_path: string[];
  shadow_mode: ShadowMode;
  bounds: SurfaceBounds | null;
  role: string | null;
  accessible_name: string | null;
  visibility: SurfaceVisibility;
}

export interface SurfaceQuery {
  selector: string;
  surface_type: ConsentSurfaceType;
  role?: string;
  shadow_mode?: ShadowMode;
  action_target?: boolean;
}

export interface ContentFrameResolution {
  frame: Frame | null;
  frame_path: string[] | null;
  error_code: ConsentAuditCode | null;
}

export interface ShadowBoundary {
  mode: 'open' | 'closed';
  error_code: ConsentAuditCode | null;
}

export interface SurfaceDiscoveryResult {
  candidates: SurfaceCandidate[];
  diagnostics: ConsentAuditCode[];
}

function safeFrameName(frame: Frame, depth: number) {
  const name = frame.name().trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,80}$/.test(name) ? name : `frame_${depth}`;
}

function surfaceErrorCode(error: unknown): ConsentAuditCode | null {
  const message = String((error as Error)?.message || error).toLowerCase();
  return /frame.*detached|frame was detached|execution context.*destroyed|target.*closed|not attached/.test(message)
    ? ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR
    : null;
}

function boundedAccessibleName(value: string | null) {
  if (!value) return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 160) : null;
}

export function framePath(frame: Frame) {
  const ancestry: Frame[] = [];
  let current: Frame | null = frame;
  while (current) {
    ancestry.unshift(current);
    current = current.parentFrame();
  }
  return ancestry.map((entry, index) => index === 0 ? 'top' : safeFrameName(entry, index));
}

export function frameLocatorForIframe(page: Page, iframeSelector: string): FrameLocator {
  return page.frameLocator(iframeSelector);
}

export async function resolveContentFrame(iframe: Locator): Promise<ContentFrameResolution> {
  try {
    const handle = await iframe.elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) return { frame: null, frame_path: null, error_code: ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR };
    return { frame, frame_path: framePath(frame), error_code: null };
  } catch (error) {
    return { frame: null, frame_path: null, error_code: surfaceErrorCode(error) || ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR };
  }
}

/**
 * Playwright locators pierce open shadow roots, including nested roots. This
 * keeps discovery and interaction in the normal locator/actionability path.
 */
export function locatorInOpenShadow(shadowHost: Locator, selector: string): Locator {
  return shadowHost.locator(selector);
}

export async function inspectShadowBoundary(shadowHost: Locator): Promise<ShadowBoundary> {
  try {
    const open = await shadowHost.evaluate((element) => Boolean((element as HTMLElement).shadowRoot));
    return open
      ? { mode: 'open', error_code: null }
      : { mode: 'closed', error_code: ConsentAuditCodes.CLOSED_SHADOW_ROOT };
  } catch (error) {
    return { mode: 'closed', error_code: surfaceErrorCode(error) || ConsentAuditCodes.CLOSED_SHADOW_ROOT };
  }
}

export async function inspectSurfaceVisibility(
  locator: Locator,
  options: { actionTarget?: boolean; actionabilityTimeoutMs?: number } = {}
): Promise<{ visibility: SurfaceVisibility; bounds: SurfaceBounds | null }> {
  try {
    if (await locator.count() === 0) {
      return {
        visibility: { attached: false, connected: false, visible: false, non_zero_dimensions: false, enabled: null, occluded: null, actionable: null, error_code: null },
        bounds: null
      };
    }
    const connected = await locator.evaluate((element) => element.isConnected);
    const visible = connected && await locator.isVisible();
    const box = visible ? await locator.boundingBox() : null;
    const bounds = box && box.width > 0 && box.height > 0
      ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : null;
    const nonZeroDimensions = Boolean(bounds);
    const enabled = options.actionTarget ? await locator.isEnabled() : null;
    let occluded: boolean | null = null;
    if (visible && bounds) {
      occluded = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (!top) return null;
        if (top === element || element.contains(top) || top.contains(element)) return false;
        const root = element.getRootNode();
        return root instanceof ShadowRoot && root.host.contains(top) ? false : true;
      }).catch(() => null);
    }
    let actionable: boolean | null = null;
    if (options.actionTarget) {
      actionable = Boolean(visible && nonZeroDimensions && enabled && occluded !== true);
      if (actionable) {
        try {
          await locator.click({ trial: true, timeout: options.actionabilityTimeoutMs || 750 });
        } catch {
          actionable = false;
        }
      }
    }
    return {
      visibility: {
        attached: true,
        connected,
        visible: Boolean(visible),
        non_zero_dimensions: nonZeroDimensions,
        enabled,
        occluded,
        actionable,
        error_code: null
      },
      bounds
    };
  } catch (error) {
    return {
      visibility: {
        attached: false,
        connected: null,
        visible: false,
        non_zero_dimensions: false,
        enabled: null,
        occluded: null,
        actionable: null,
        error_code: surfaceErrorCode(error) || ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR
      },
      bounds: null
    };
  }
}

export async function discoverSurfaceCandidates(page: Page, queries: SurfaceQuery[], maxCandidates = 100) {
  const candidates: SurfaceCandidate[] = [];
  const diagnostics: ConsentAuditCode[] = [];
  for (const frame of page.frames()) {
    let path: string[];
    try {
      path = framePath(frame);
    } catch (error) {
      const code = surfaceErrorCode(error) || ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR;
      if (!diagnostics.includes(code)) diagnostics.push(code);
      continue;
    }
    for (const query of queries) {
      if (candidates.length >= maxCandidates) return { candidates, diagnostics };
      const locator = frame.locator(query.selector).first();
      const { visibility, bounds } = await inspectSurfaceVisibility(locator, { actionTarget: query.action_target });
      if (!visibility.attached) {
        if (visibility.error_code && !diagnostics.includes(visibility.error_code)) diagnostics.push(visibility.error_code);
        continue;
      }
      const [role, accessibleName] = await Promise.all([
        query.role || locator.getAttribute('role').catch(() => null),
        locator.getAttribute('aria-label').catch(() => null)
      ]);
      candidates.push({
        surface_type: query.surface_type,
        locator,
        frame,
        frame_path: path,
        shadow_mode: query.shadow_mode || 'none',
        bounds,
        role,
        accessible_name: boundedAccessibleName(accessibleName),
        visibility
      });
    }
  }
  return { candidates, diagnostics } satisfies SurfaceDiscoveryResult;
}
