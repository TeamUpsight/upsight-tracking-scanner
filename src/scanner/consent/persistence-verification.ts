import {
  ConsentAuditCodes,
  type ConsentAuditCode,
  type PersistenceResult,
  type VerificationResult
} from './domain-types';

export type PersistenceSemanticChannel = 'provider' | 'tcf' | 'gpp' | 'shopify_privacy' | 'consent_mode';
export type PersistenceSemanticValue = 'accepted' | 'rejected' | 'partial' | 'unanswered' | 'not_applicable' | 'unavailable' | 'ambiguous';
export type PersistenceChannelComparison = 'persisted' | 'reset' | 'ambiguous' | 'unavailable';

/** Metadata-only descriptor. Values, raw consent strings, and cookie payloads are never accepted. */
export interface PersistenceStorageDescriptor {
  storage_type: 'cookie' | 'local_storage' | 'session_storage' | 'indexeddb';
  key_name: string;
  domain: string | null;
  path: string | null;
  expiry_class: 'session' | 'persistent' | 'unknown';
  secure: boolean | null;
  http_only: boolean | null;
  same_site: 'lax' | 'strict' | 'none' | 'unknown' | null;
  exists: boolean;
  value_length?: number;
  fingerprint?: string;
}

export interface PersistenceSnapshot {
  semantic_state: Partial<Record<PersistenceSemanticChannel, PersistenceSemanticValue>>;
  storage: readonly PersistenceStorageDescriptor[];
}

export interface PersistenceVerificationInput {
  /** The executor/verifier determines this before any reload can be attempted. */
  meaningful_action_attempt: boolean;
  semantic_verification: VerificationResult;
  after_action: PersistenceSnapshot;
  settle_timeout_ms?: number;
}

export interface SameContextReloadResult {
  reloaded: boolean;
  same_context: boolean;
  origin_before: string | null;
  origin_after: string | null;
  navigation_interrupted: boolean;
}

export interface PersistenceReloadBridge {
  reloadSameContext(): Promise<SameContextReloadResult>;
  waitForSettle(timeoutMs: number): Promise<'settled' | 'timeout'>;
  readPostReloadSnapshot(): Promise<PersistenceSnapshot | null>;
}

export interface SameContextPersistenceResult extends PersistenceResult {
  scope: 'same_context_same_origin' | 'not_tested';
  semantic_channels: Partial<Record<PersistenceSemanticChannel, PersistenceChannelComparison>>;
  storage_continuity: 'matching' | 'mismatched' | 'unknown';
  /** Explicit lifecycle facts; persistence status alone never implies observation completion. */
  reload_attempted: boolean;
  reload_succeeded: boolean;
  post_reload_observation_completed: boolean;
}

function boundedSettleTimeout(timeoutMs: number | undefined) {
  return Math.max(100, Math.min(timeoutMs || 5_000, 15_000));
}

function sameOrigin(before: string | null, after: string | null) {
  if (!before || !after) return false;
  try {
    return new URL(before).origin === new URL(after).origin;
  } catch {
    return false;
  }
}

function meaningfulValue(value: PersistenceSemanticValue | undefined) {
  return value === 'accepted' || value === 'rejected' || value === 'partial';
}

function compareSemanticChannels(before: PersistenceSnapshot, after: PersistenceSnapshot) {
  const comparisons: Partial<Record<PersistenceSemanticChannel, PersistenceChannelComparison>> = {};
  const channels: PersistenceSemanticChannel[] = ['provider', 'tcf', 'gpp', 'shopify_privacy', 'consent_mode'];
  for (const channel of channels) {
    const beforeValue = before.semantic_state[channel];
    const afterValue = after.semantic_state[channel];
    if (!meaningfulValue(beforeValue)) continue;
    if (afterValue === undefined || afterValue === 'unavailable') {
      comparisons[channel] = 'unavailable';
    } else if (afterValue === beforeValue) {
      comparisons[channel] = 'persisted';
    } else if (afterValue === 'ambiguous' || afterValue === 'not_applicable') {
      comparisons[channel] = 'ambiguous';
    } else {
      comparisons[channel] = 'reset';
    }
  }
  return comparisons;
}

function storageIdentity(descriptor: PersistenceStorageDescriptor) {
  return `${descriptor.storage_type}:${descriptor.key_name}:${descriptor.domain || ''}:${descriptor.path || ''}`;
}

function compareStorage(before: readonly PersistenceStorageDescriptor[], after: readonly PersistenceStorageDescriptor[]) {
  const beforeExisting = before.filter((descriptor) => descriptor.exists);
  if (!beforeExisting.length) return 'unknown' as const;
  const afterByIdentity = new Map(after.map((descriptor) => [storageIdentity(descriptor), descriptor]));
  const matched = beforeExisting.every((descriptor) => {
    const reloaded = afterByIdentity.get(storageIdentity(descriptor));
    if (!reloaded?.exists) return false;
    return descriptor.value_length === undefined || reloaded.value_length === undefined || descriptor.value_length === reloaded.value_length;
  });
  return matched ? 'matching' as const : 'mismatched' as const;
}

function result(
  status: PersistenceResult['status'],
  evidence: string[],
  reasonCodes: ConsentAuditCode[],
  scope: SameContextPersistenceResult['scope'],
  semanticChannels: SameContextPersistenceResult['semantic_channels'] = {},
  storageContinuity: SameContextPersistenceResult['storage_continuity'] = 'unknown',
  lifecycle: Pick<SameContextPersistenceResult, 'reload_attempted' | 'reload_succeeded' | 'post_reload_observation_completed'> = { reload_attempted: false, reload_succeeded: false, post_reload_observation_completed: false }
): SameContextPersistenceResult {
  return {
    status,
    evidence,
    reason_codes: reasonCodes,
    scope,
    semantic_channels: semanticChannels,
    storage_continuity: storageContinuity,
    ...lifecycle
  };
}

/**
 * Compares normalized post-action and post-reload state. Storage metadata is
 * supporting only; a semantic channel is required to confirm persistence.
 */
export function compareSameContextPersistence(input: PersistenceVerificationInput, postReload: PersistenceSnapshot): SameContextPersistenceResult {
  const semanticChannels = compareSemanticChannels(input.after_action, postReload);
  const channelValues = Object.values(semanticChannels);
  const storageContinuity = compareStorage(input.after_action.storage, postReload.storage);
  const evidence = [
    ...Object.entries(semanticChannels).map(([channel, comparison]) => `semantic:${channel}:${comparison}`),
    ...(storageContinuity === 'unknown' ? [] : [`storage:${storageContinuity}`])
  ];

  if (channelValues.includes('persisted') && !channelValues.includes('reset')) {
    return result('confirmed', evidence, [ConsentAuditCodes.PERSISTENCE_CONFIRMED], 'same_context_same_origin', semanticChannels, storageContinuity, { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: true });
  }
  if (channelValues.includes('reset') && !channelValues.includes('persisted')) {
    return result('not_confirmed', evidence, [ConsentAuditCodes.PERSISTENCE_NOT_CONFIRMED], 'same_context_same_origin', semanticChannels, storageContinuity, { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: true });
  }
  return result('inconclusive', evidence, [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'same_context_same_origin', semanticChannels, storageContinuity, { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: true });
}

/**
 * Executes only the reload/read portion of persistence verification. The
 * caller supplies the post-action snapshot, keeping action and reload behavior
 * isolated from the comparison decision.
 */
export async function verifySameContextReloadPersistence(
  input: PersistenceVerificationInput,
  bridge: PersistenceReloadBridge
): Promise<SameContextPersistenceResult> {
  if (!input.meaningful_action_attempt) {
    return result('not_applicable', [], [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE], 'not_tested');
  }

  let reload: SameContextReloadResult;
  try {
    reload = await bridge.reloadSameContext();
  } catch {
    return result('inconclusive', [], [ConsentAuditCodes.NAVIGATION_INTERRUPTED, ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'not_tested', {}, 'unknown', { reload_attempted: true, reload_succeeded: false, post_reload_observation_completed: false });
  }
  if (!reload.reloaded || reload.navigation_interrupted) {
    return result('inconclusive', [], [ConsentAuditCodes.NAVIGATION_INTERRUPTED, ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'not_tested', {}, 'unknown', { reload_attempted: true, reload_succeeded: false, post_reload_observation_completed: false });
  }
  if (!reload.same_context || !sameOrigin(reload.origin_before, reload.origin_after)) {
    return result('not_applicable', [], [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE], 'not_tested', {}, 'unknown', { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: false });
  }
  let settled: 'settled' | 'timeout';
  try {
    settled = await bridge.waitForSettle(boundedSettleTimeout(input.settle_timeout_ms));
  } catch {
    return result('inconclusive', [], [ConsentAuditCodes.INTERACTION_TIMEOUT, ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'same_context_same_origin', {}, 'unknown', { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: false });
  }
  if (settled === 'timeout') {
    return result('inconclusive', [], [ConsentAuditCodes.INTERACTION_TIMEOUT, ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'same_context_same_origin', {}, 'unknown', { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: false });
  }
  let postReload: PersistenceSnapshot | null;
  try {
    postReload = await bridge.readPostReloadSnapshot();
  } catch {
    return result('inconclusive', [], [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'same_context_same_origin', {}, 'unknown', { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: false });
  }
  if (!postReload) {
    return result('inconclusive', [], [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE], 'same_context_same_origin', {}, 'unknown', { reload_attempted: true, reload_succeeded: true, post_reload_observation_completed: false });
  }
  return compareSameContextPersistence(input, postReload);
}
