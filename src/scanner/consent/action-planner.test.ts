import { describe, expect, it } from 'vitest';
import { ConsentAuditCodes } from './domain-types';
import { buildRejectStateMachine, createActionPlan, executeActionPlan, type ActionPlan, type InteractionExecutionBridge } from './action-planner';

function plan(action: ActionPlan['action'], strategies: ActionPlan['eligible_strategies'] = ['provider_selector']): ActionPlan {
  return createActionPlan({
    action, provider_or_mechanism: 'fixture', eligible_strategies: strategies,
    target: { surface_type: 'dialog', target_ref: 'opaque-target', accessible_control: true, frame_path: ['top'], shadow_mode: 'none' },
    category: action === 'set_category' ? 'analytics' : null
  });
}

function bridge(overrides: Partial<InteractionExecutionBridge> = {}) {
  const evidence: unknown[] = [];
  const base: InteractionExecutionBridge = {
    inspectTarget: async () => ({ attached: true, visible: true, enabled: true, surface_active: true, frame_path: ['top'], shadow_mode: 'none', navigation_state: 'idle' }),
    executeStrategy: async () => 'executed',
    appendEvidence: (event) => { evidence.push(event); },
    waitForStabilization: async () => ({ state_changed: false, navigation_interrupted: false })
  };
  return { bridge: { ...base, ...overrides }, evidence };
}

describe('consent action planner and executor', () => {
  it('prioritizes documented provider API ahead of every UI strategy', () => {
    expect(plan('reject_all', ['generic_high_confidence', 'keyboard_accessible_control', 'provider_selector', 'documented_provider_api']).eligible_strategies).toEqual([
      'documented_provider_api', 'provider_selector', 'generic_high_confidence', 'keyboard_accessible_control'
    ]);
  });

  it('does not admit keyboard fallback without an identified accessible control', () => {
    const keyboardOnly = createActionPlan({
      ...plan('reject_all', ['keyboard_accessible_control']),
      target: { surface_type: 'dialog', target_ref: null, accessible_control: false, frame_path: ['top'], shadow_mode: 'none' }
    });
    expect(keyboardOnly.eligible_strategies).toEqual([]);
  });

  it('executes a provider API strategy and records its origin', async () => {
    const { bridge: executor } = bridge();
    const result = await executeActionPlan(plan('reject_all', ['documented_provider_api']), executor);
    expect(result).toMatchObject({ strategy: 'documented_provider_api', attempt: { origin: 'provider_api', outcome: 'executed' } });
  });

  it('executes a provider selector strategy', async () => {
    const { bridge: executor } = bridge();
    expect(await executeActionPlan(plan('reject_all'), executor)).toMatchObject({ attempt: { origin: 'provider_selector', outcome: 'executed' } });
  });

  it('records the actual activation timestamp only after an executed action', async () => {
    const before = Date.now();
    const { bridge: executor } = bridge({ executeStrategy: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return 'executed'; } });
    const executed = await executeActionPlan(plan('reject_all'), executor);
    expect(executed.activated_at).toBeGreaterThanOrEqual(before);
    const { bridge: unsupported } = bridge({ inspectTarget: async () => ({ attached: false, visible: false, enabled: false, surface_active: false, frame_path: null, shadow_mode: 'none', navigation_state: 'idle' }) });
    expect((await executeActionPlan(plan('reject_all'), unsupported)).activated_at).toBeNull();
  });

  it('executes an ARIA semantic strategy', async () => {
    const { bridge: executor } = bridge();
    expect(await executeActionPlan(plan('reject_all', ['semantic_accessibility']), executor)).toMatchObject({ attempt: { origin: 'semantic_ui', outcome: 'executed' } });
  });

  it('executes a normalized localized-label strategy only after planning', async () => {
    const { bridge: executor } = bridge();
    const localized = createActionPlan({ ...plan('reject_all', ['normalized_localized_label']), localization_evidence: { locale: 'fr', normalized: true, source: 'localized_label' } });
    expect(await executeActionPlan(localized, executor)).toMatchObject({ attempt: { origin: 'semantic_ui', outcome: 'executed' } });
  });

  it('plans direct Reject before other reject flows', () => {
    expect(buildRejectStateMachine({ direct_reject: plan('reject_all'), only_necessary: plan('only_necessary') })).toMatchObject({ status: 'ready', steps: [expect.objectContaining({ action: 'reject_all' })] });
  });

  it('plans preferences-only Reject through deny optional categories and Save', () => {
    const flow = buildRejectStateMachine({
      open_preferences: plan('open_preferences'), deny_optional_categories: [plan('set_category')], save_preferences: plan('save_preferences')
    });
    expect(flow).toMatchObject({ status: 'ready', steps: [expect.objectContaining({ action: 'open_preferences' }), expect.objectContaining({ action: 'set_category' }), expect.objectContaining({ action: 'save_preferences' })] });
  });

  it('returns closed-shadow-root explicitly', async () => {
    const { bridge: executor } = bridge({ inspectTarget: async () => ({ attached: true, visible: true, enabled: true, surface_active: true, frame_path: ['top'], shadow_mode: 'closed', navigation_state: 'idle' }) });
    expect(await executeActionPlan(plan('reject_all'), executor)).toMatchObject({ attempt: { outcome: 'unsupported', reason_codes: [ConsentAuditCodes.CLOSED_SHADOW_ROOT] } });
  });

  it('returns a detached iframe/frame-path failure explicitly', async () => {
    const framed = createActionPlan({ ...plan('reject_all'), target: { surface_type: 'dialog', target_ref: 'opaque', accessible_control: true, frame_path: ['top', 'cmp-frame'], shadow_mode: 'none' } });
    const { bridge: executor } = bridge({ inspectTarget: async () => ({ attached: false, visible: false, enabled: false, surface_active: false, frame_path: null, shadow_mode: 'none', navigation_state: 'idle' }) });
    expect(await executeActionPlan(framed, executor)).toMatchObject({ attempt: { reason_codes: [ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR] } });
  });

  it('does not act on a disabled target', async () => {
    const { bridge: executor } = bridge({ inspectTarget: async () => ({ attached: true, visible: true, enabled: false, surface_active: true, frame_path: ['top'], shadow_mode: 'none', navigation_state: 'idle' }) });
    expect(await executeActionPlan(plan('reject_all'), executor)).toMatchObject({ attempt: { outcome: 'unsupported', reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED] } });
  });

  it('keeps navigation after Save explicitly interrupted', async () => {
    const { bridge: executor } = bridge({ waitForStabilization: async () => ({ state_changed: false, navigation_interrupted: true }) });
    expect(await executeActionPlan(plan('save_preferences'), executor)).toMatchObject({ attempt: { outcome: 'aborted', reason_codes: [ConsentAuditCodes.NAVIGATION_INTERRUPTED] } });
  });

  it('stops after a successful semantic state transition without retrying fallbacks', async () => {
    const attempted: string[] = [];
    const { bridge: executor } = bridge({
      executeStrategy: async (_plan, strategy) => { attempted.push(strategy); return 'executed'; },
      waitForStabilization: async () => ({ state_changed: true, navigation_interrupted: false })
    });
    const result = await executeActionPlan(plan('reject_all', ['provider_selector', 'semantic_accessibility']), executor);
    expect(result).toMatchObject({ state_changed: true, attempted_strategies: ['provider_selector'] });
    expect(attempted).toEqual(['provider_selector']);
  });
});
