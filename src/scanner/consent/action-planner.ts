import {
  ConsentAuditCodes,
  type AvailableAction,
  type BannerSurface,
  type ConsentActionType,
  type ConsentAuditCode,
  type ConsentCategory,
  type InteractionAttempt,
  type InteractionOrigin
} from './domain-types';

export type ConsentInteractionStrategy =
  | 'documented_provider_api'
  | 'provider_selector'
  | 'semantic_accessibility'
  | 'normalized_localized_label'
  | 'generic_high_confidence'
  | 'keyboard_accessible_control';

export const INTERACTION_STRATEGY_PRIORITY: readonly ConsentInteractionStrategy[] = [
  'documented_provider_api',
  'provider_selector',
  'semantic_accessibility',
  'normalized_localized_label',
  'generic_high_confidence',
  'keyboard_accessible_control'
] as const;

export type ActionPlanSemanticAction = Exclude<ConsentActionType, 'close'>;
export type ExpectedVerifier = 'provider_state' | 'framework_state' | 'storage_metadata' | 'semantic_state' | 'none';
export type ActionAbortCondition = 'surface_inactive' | 'navigation_started' | 'frame_detached' | 'closed_shadow_root' | 'state_changed';

export interface LocalizationEvidence {
  locale: string | null;
  normalized: boolean;
  source: 'semantic' | 'accessibility' | 'localized_label' | 'none';
}

export interface ActionPlanTarget {
  surface_type: Exclude<BannerSurface, 'none' | 'unknown'>;
  /** Opaque transient bridge reference; never persist a selector or page text here. */
  target_ref: string | null;
  /** Required before keyboard fallback; prevents blind focus traversal. */
  accessible_control: boolean;
  frame_path: string[];
  shadow_mode: 'none' | 'open' | 'closed' | 'unknown';
}

export interface ActionPlan {
  action: ActionPlanSemanticAction;
  provider_or_mechanism: string;
  eligible_strategies: ConsentInteractionStrategy[];
  target: ActionPlanTarget;
  expected_verifier: ExpectedVerifier;
  timeout_ms: number;
  stabilization_ms: number;
  abort_conditions: ActionAbortCondition[];
  localization_evidence: LocalizationEvidence;
  category: ConsentCategory | null;
  /** Availability facts remain distinct even when API interaction is eligible. */
  provider_api_reject_available: boolean;
  user_facing_reject_available: boolean;
}

export interface ActionPlannerInput {
  action: ActionPlanSemanticAction;
  provider_or_mechanism: string;
  target: ActionPlanTarget;
  eligible_strategies: readonly ConsentInteractionStrategy[];
  expected_verifier?: ExpectedVerifier;
  timeout_ms?: number;
  stabilization_ms?: number;
  abort_conditions?: readonly ActionAbortCondition[];
  localization_evidence?: Partial<LocalizationEvidence>;
  category?: ConsentCategory | null;
  provider_api_reject_available?: boolean;
  user_facing_reject_available?: boolean;
  /** User-path audits prioritize a stable visible control over a synthetic API. */
  prefer_user_facing?: boolean;
}

export interface ActionTargetSnapshot {
  attached: boolean;
  visible: boolean;
  enabled: boolean;
  surface_active: boolean;
  frame_path: string[] | null;
  shadow_mode: 'none' | 'open' | 'closed' | 'unknown';
  navigation_state: 'idle' | 'navigating' | 'interrupted';
}

export interface InteractionExecutionBridge {
  inspectTarget(plan: ActionPlan, strategy: ConsentInteractionStrategy): Promise<ActionTargetSnapshot>;
  scrollIntoView?(plan: ActionPlan, strategy: ConsentInteractionStrategy): Promise<boolean>;
  executeStrategy(plan: ActionPlan, strategy: ConsentInteractionStrategy): Promise<'executed' | 'not_executed' | 'timeout' | 'unsupported'>;
  appendEvidence(event: {
    kind: 'interaction_attempt' | 'interaction_result' | 'state_transition';
    action: ActionPlanSemanticAction;
    strategy: ConsentInteractionStrategy | null;
    origin: InteractionOrigin | null;
    reason_codes: ConsentAuditCode[];
  }): void | Promise<void>;
  waitForStabilization(plan: ActionPlan): Promise<{ state_changed: boolean; navigation_interrupted: boolean }>;
}

export interface InteractionExecutionResult {
  attempt: InteractionAttempt;
  strategy: ConsentInteractionStrategy | null;
  attempted_strategies: ConsentInteractionStrategy[];
  state_changed: boolean;
  reason_codes: ConsentAuditCode[];
  /** Actual successful click/API activation, never the attempt-start timestamp. */
  activated_at: number | null;
}

export interface RejectStateMachineInput {
  direct_reject?: ActionPlan;
  only_necessary?: ActionPlan;
  open_preferences?: ActionPlan;
  deny_optional_categories?: ActionPlan[];
  save_preferences?: ActionPlan;
  /** A visible preference center may expose a direct Reject only after opening. */
  rediscover_after_preferences?: boolean;
}

export interface RejectStateMachinePlan {
  status: 'ready' | 'unsupported';
  steps: ActionPlan[];
  reason_codes: ConsentAuditCode[];
}

function uniqueStrategies(strategies: readonly ConsentInteractionStrategy[], preferUserFacing = false) {
  const priority = preferUserFacing
    ? ['provider_selector', 'semantic_accessibility', 'normalized_localized_label', 'generic_high_confidence', 'keyboard_accessible_control', 'documented_provider_api'] as const
    : INTERACTION_STRATEGY_PRIORITY;
  return [...new Set(strategies)].sort((left, right) => priority.indexOf(left) - priority.indexOf(right));
}

function originFor(strategy: ConsentInteractionStrategy): InteractionOrigin {
  if (strategy === 'documented_provider_api') return 'provider_api';
  if (strategy === 'provider_selector') return 'provider_selector';
  if (strategy === 'keyboard_accessible_control') return 'keyboard';
  return strategy === 'generic_high_confidence' ? 'generic_ui' : 'semantic_ui';
}

function sameFrame(expected: readonly string[], actual: readonly string[] | null) {
  return Boolean(actual && expected.length === actual.length && expected.every((part, index) => part === actual[index]));
}

function unsupportedResult(action: ActionPlanSemanticAction, reasonCodes: ConsentAuditCode[]): InteractionExecutionResult {
  return {
    attempt: { action, origin: 'generic_ui', outcome: 'unsupported', category: null, reason_codes: reasonCodes },
    strategy: null, attempted_strategies: [], state_changed: false, reason_codes: reasonCodes, activated_at: null
  };
}

function result(
  action: ActionPlanSemanticAction,
  strategy: ConsentInteractionStrategy | null,
  outcome: InteractionAttempt['outcome'],
  reasonCodes: ConsentAuditCode[],
  attempted: ConsentInteractionStrategy[],
  stateChanged = false,
  category: ConsentCategory | null = null,
  activatedAt: number | null = null
): InteractionExecutionResult {
  return {
    attempt: { action, origin: strategy ? originFor(strategy) : 'generic_ui', outcome, category, reason_codes: reasonCodes },
    strategy, attempted_strategies: attempted, state_changed: stateChanged, reason_codes: reasonCodes, activated_at: activatedAt
  };
}

/** Creates a bounded, strategy-ordered plan. It does not locate or interact with a target. */
export function createActionPlan(input: ActionPlannerInput): ActionPlan {
  const eligibleStrategies = uniqueStrategies(input.eligible_strategies, input.prefer_user_facing).filter(
    (strategy) => strategy !== 'keyboard_accessible_control' || (input.target.target_ref !== null && input.target.accessible_control)
  );
  return {
    action: input.action,
    provider_or_mechanism: input.provider_or_mechanism,
    eligible_strategies: eligibleStrategies,
    target: { ...input.target, frame_path: [...input.target.frame_path] },
    expected_verifier: input.expected_verifier || 'semantic_state',
    timeout_ms: Math.max(100, Math.min(input.timeout_ms || 3_000, 15_000)),
    stabilization_ms: Math.max(100, Math.min(input.stabilization_ms || 3_000, 15_000)),
    abort_conditions: [...new Set<ActionAbortCondition>(input.abort_conditions || ['surface_inactive', 'navigation_started', 'frame_detached', 'closed_shadow_root', 'state_changed'])],
    localization_evidence: {
      locale: input.localization_evidence?.locale || null,
      normalized: input.localization_evidence?.normalized || false,
      source: input.localization_evidence?.source || 'none'
    },
    category: input.category || null,
    provider_api_reject_available: input.provider_api_reject_available || false,
    user_facing_reject_available: input.user_facing_reject_available || false
  };
}

/** Converts an adapter/generic action candidate into a plan with no speculative strategy. */
export function planFromAvailableAction(
  candidate: AvailableAction,
  input: Omit<ActionPlannerInput, 'action' | 'eligible_strategies'> & { eligible_strategies?: readonly ConsentInteractionStrategy[] }
) {
  if (candidate.action === 'close') return null;
  const strategies = input.eligible_strategies || [];
  return createActionPlan({ ...input, action: candidate.action, eligible_strategies: strategies, category: candidate.category });
}

function preflightFailure(plan: ActionPlan, snapshot: ActionTargetSnapshot): ConsentAuditCode[] | null {
  if (snapshot.shadow_mode === 'closed' || plan.target.shadow_mode === 'closed') return [ConsentAuditCodes.CLOSED_SHADOW_ROOT];
  if (!snapshot.attached || !sameFrame(plan.target.frame_path, snapshot.frame_path)) return [ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR];
  if (snapshot.navigation_state !== 'idle') return [ConsentAuditCodes.NAVIGATION_INTERRUPTED];
  if (!snapshot.visible || !snapshot.enabled || !snapshot.surface_active) return [ConsentAuditCodes.ACTION_NOT_EXPOSED];
  return null;
}

/**
 * Executes at most one successful browser activation. Fallback strategies are
 * tried only when an earlier strategy cannot execute; a state change always
 * stops the sequence immediately.
 */
export async function executeActionPlan(plan: ActionPlan, bridge: InteractionExecutionBridge): Promise<InteractionExecutionResult> {
  if (!plan.eligible_strategies.length) return unsupportedResult(plan.action, [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED]);
  const attempted: ConsentInteractionStrategy[] = [];
  for (const strategy of plan.eligible_strategies) {
    const snapshot = await bridge.inspectTarget(plan, strategy);
    const failure = preflightFailure(plan, snapshot);
    if (failure) {
      await bridge.appendEvidence({ kind: 'interaction_result', action: plan.action, strategy, origin: originFor(strategy), reason_codes: failure });
      return result(plan.action, strategy, failure.includes(ConsentAuditCodes.NAVIGATION_INTERRUPTED) ? 'aborted' : 'unsupported', failure, attempted, false, plan.category);
    }
    if (bridge.scrollIntoView) {
      const scrolled = await bridge.scrollIntoView(plan, strategy);
      if (!scrolled) {
        const codes = [ConsentAuditCodes.ACTION_NOT_EXPOSED];
        await bridge.appendEvidence({ kind: 'interaction_result', action: plan.action, strategy, origin: originFor(strategy), reason_codes: codes });
        return result(plan.action, strategy, 'not_executed', codes, attempted, false, plan.category);
      }
    }
    attempted.push(strategy);
    await bridge.appendEvidence({ kind: 'interaction_attempt', action: plan.action, strategy, origin: originFor(strategy), reason_codes: [] });
    // A provider may synchronously emit consent commands or tracking requests
    // while its control handler runs. Capture the activation boundary first so
    // those browser events are never misclassified as pre-choice evidence.
    const activatedAt = Date.now();
    const execution = await bridge.executeStrategy(plan, strategy);
    if (execution === 'timeout') {
      const codes = [ConsentAuditCodes.INTERACTION_TIMEOUT];
      await bridge.appendEvidence({ kind: 'interaction_result', action: plan.action, strategy, origin: originFor(strategy), reason_codes: codes });
      return result(plan.action, strategy, 'timeout', codes, attempted, false, plan.category);
    }
    if (execution === 'unsupported') continue;
    if (execution === 'not_executed') continue;

    const stabilization = await bridge.waitForStabilization(plan);
    if (stabilization.navigation_interrupted) {
      const codes = [ConsentAuditCodes.NAVIGATION_INTERRUPTED];
      await bridge.appendEvidence({ kind: 'interaction_result', action: plan.action, strategy, origin: originFor(strategy), reason_codes: codes });
      return result(plan.action, strategy, 'aborted', codes, attempted, false, plan.category, activatedAt);
    }
    const codes = [ConsentAuditCodes.ACTION_EXECUTED];
    await bridge.appendEvidence({ kind: stabilization.state_changed ? 'state_transition' : 'interaction_result', action: plan.action, strategy, origin: originFor(strategy), reason_codes: codes });
    return result(plan.action, strategy, 'executed', codes, attempted, stabilization.state_changed, plan.category, activatedAt);
  }
  const codes = [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED];
  await bridge.appendEvidence({ kind: 'interaction_result', action: plan.action, strategy: null, origin: null, reason_codes: codes });
  return unsupportedResult(plan.action, codes);
}

/**
 * Reject flow only contains explicit reject/necessary/preferences/category/save
 * operations. Close, dismiss, escape, and similar actions cannot enter it.
 */
export function buildRejectStateMachine(input: RejectStateMachineInput): RejectStateMachinePlan {
  if (input.direct_reject?.action === 'reject_all') return { status: 'ready', steps: [input.direct_reject], reason_codes: [] };
  if (input.only_necessary?.action === 'only_necessary') return { status: 'ready', steps: [input.only_necessary], reason_codes: [] };
  const optionalCategories = (input.deny_optional_categories || []).filter((plan) => plan.action === 'set_category');
  if (input.open_preferences?.action === 'open_preferences' && optionalCategories.length && input.save_preferences?.action === 'save_preferences') {
    return { status: 'ready', steps: [input.open_preferences, ...optionalCategories, input.save_preferences], reason_codes: [] };
  }
  if (input.open_preferences?.action === 'open_preferences' && input.rediscover_after_preferences) {
    return { status: 'ready', steps: [input.open_preferences], reason_codes: [] };
  }
  return { status: 'unsupported', steps: [], reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] };
}
