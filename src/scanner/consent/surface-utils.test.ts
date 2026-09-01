import { describe, expect, it, vi } from 'vitest';
import {
  discoverSurfaceCandidates,
  frameLocatorForIframe,
  framePath,
  inspectShadowBoundary,
  inspectSurfaceVisibility,
  locatorInOpenShadow,
  resolveContentFrame
} from './surface-utils';

function fixtureLocator(input: {
  attached?: boolean;
  visible?: boolean;
  enabled?: boolean;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  occluded?: boolean | null;
  role?: string | null;
  accessibleName?: string | null;
  shadowOpen?: boolean;
  contentFrame?: unknown;
} = {}) {
  const evaluations = [input.shadowOpen ?? true, input.occluded ?? false];
  const locator: Record<string, any> = {
    first: vi.fn(() => locator),
    locator: vi.fn(),
    count: vi.fn().mockResolvedValue(input.attached === false ? 0 : 1),
    isVisible: vi.fn().mockResolvedValue(input.visible ?? true),
    isEnabled: vi.fn().mockResolvedValue(input.enabled ?? true),
    boundingBox: vi.fn().mockResolvedValue(input.bounds === undefined ? { x: 10, y: 20, width: 120, height: 40 } : input.bounds),
    evaluate: vi.fn().mockImplementation(async () => evaluations.shift()),
    click: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn().mockImplementation(async (name: string) => name === 'role' ? input.role ?? null : input.accessibleName ?? null),
    elementHandle: vi.fn().mockResolvedValue(input.contentFrame === undefined ? null : { contentFrame: vi.fn().mockResolvedValue(input.contentFrame) })
  };
  return locator;
}

function fixtureFrame(name: string, parent: any, locators: Record<string, any> = {}) {
  return {
    name: () => name,
    parentFrame: () => parent,
    locator: vi.fn((selector: string) => locators[selector] || fixtureLocator({ attached: false }))
  };
}

describe('Consent surface utilities', () => {
  it('covers top DOM, same-origin iframe, and cross-origin-style frame fixtures with ancestry', async () => {
    const topDialog = fixtureLocator({ role: 'dialog', accessibleName: 'Visible consent dialog' });
    const sameAction = fixtureLocator();
    const crossAction = fixtureLocator();
    const top = fixtureFrame('', null, { '[role="dialog"]': topDialog });
    const same = fixtureFrame('same-frame', top, { '#same-action, #cross-action': sameAction });
    const cross = fixtureFrame('cross-frame', top, { '#same-action, #cross-action': crossAction });
    const frameLocator = { locator: vi.fn() };
    const page = { frames: () => [top, same, cross], frameLocator: vi.fn(() => frameLocator) };

    const discovery = await discoverSurfaceCandidates(page as any, [
      { selector: '[role="dialog"]', surface_type: 'dialog' },
      { selector: '#same-action, #cross-action', surface_type: 'unknown', action_target: true }
    ]);

    expect(discovery.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ frame_path: ['top'], role: 'dialog', accessible_name: 'Visible consent dialog' }),
      expect.objectContaining({ frame_path: ['top', 'same-frame'], visibility: expect.objectContaining({ actionable: true }) }),
      expect.objectContaining({ frame_path: ['top', 'cross-frame'], visibility: expect.objectContaining({ actionable: true }) })
    ]));
    expect(frameLocatorForIframe(page as any, 'iframe[name="same-frame"]')).toBe(frameLocator);
  });

  it('covers open and nested open shadow fixtures with normal locators, plus a closed boundary', async () => {
    const nestedAction = fixtureLocator();
    const nestedHost = fixtureLocator({ shadowOpen: true });
    nestedHost.locator.mockReturnValue(nestedAction);
    const openHost = fixtureLocator({ shadowOpen: true });
    openHost.locator.mockReturnValue(nestedHost);
    const closedHost = fixtureLocator({ shadowOpen: false });

    expect(await inspectShadowBoundary(openHost as any)).toEqual({ mode: 'open', error_code: null });
    expect(locatorInOpenShadow(locatorInOpenShadow(openHost as any, '#nested-host'), '#nested-action')).toBe(nestedAction);
    expect(await inspectShadowBoundary(closedHost as any)).toEqual({ mode: 'closed', error_code: 'CLOSED_SHADOW_ROOT' });
  });

  it('covers hidden dialog and disabled button fixtures through visibility and actionability', async () => {
    const hidden = await inspectSurfaceVisibility(fixtureLocator({ visible: false, bounds: null }) as any);
    const disabled = await inspectSurfaceVisibility(fixtureLocator({ enabled: false }) as any, { actionTarget: true });

    expect(hidden.visibility).toMatchObject({ attached: true, visible: false, non_zero_dimensions: false });
    expect(disabled.visibility).toMatchObject({ attached: true, visible: true, enabled: false, actionable: false });
  });

  it('covers detached frame access without coordinate fallbacks', async () => {
    const top = fixtureFrame('', null);
    const same = fixtureFrame('same-frame', top);
    const resolved = await resolveContentFrame(fixtureLocator({ contentFrame: same }) as any);
    const detached = await resolveContentFrame(fixtureLocator({ contentFrame: null }) as any);
    const detachedLocator = fixtureLocator();
    detachedLocator.count.mockRejectedValue(new Error('Frame was detached'));
    const discovery = await discoverSurfaceCandidates({
      frames: () => [fixtureFrame('', null, { '#surface': detachedLocator })]
    } as any, [{ selector: '#surface', surface_type: 'dialog' }]);

    expect(framePath(resolved.frame!)).toEqual(['top', 'same-frame']);
    expect(detached).toMatchObject({ frame: null, error_code: 'CROSS_ORIGIN_FRAME_ERROR' });
    expect(discovery.diagnostics).toEqual(['CROSS_ORIGIN_FRAME_ERROR']);
  });
});
