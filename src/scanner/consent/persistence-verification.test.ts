import { describe, expect, it } from 'vitest';
import { ConsentAuditCodes, type VerificationResult } from './domain-types';
import {
  compareSameContextPersistence,
  verifySameContextReloadPersistence,
  type PersistenceReloadBridge,
  type PersistenceSnapshot
} from './persistence-verification';

const verification: VerificationResult = { status: 'verified', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_VERIFIED] };

function snapshot(state: PersistenceSnapshot['semantic_state'], storage: PersistenceSnapshot['storage'] = []): PersistenceSnapshot {
  return { semantic_state: state, storage };
}

function input(afterAction: PersistenceSnapshot, meaningful = true) {
  return { meaningful_action_attempt: meaningful, semantic_verification: verification, after_action: afterAction };
}

function bridge(overrides: Partial<PersistenceReloadBridge> = {}): PersistenceReloadBridge {
  return {
    reloadSameContext: async () => ({ reloaded: true, same_context: true, origin_before: 'https://store.example/path', origin_after: 'https://store.example/other', navigation_interrupted: false }),
    waitForSettle: async () => 'settled',
    readPostReloadSnapshot: async () => snapshot({ provider: 'rejected' }),
    ...overrides
  };
}

describe('same-context persistence verification', () => {
  it('confirms a semantic state that persists after reload', async () => {
    const result = await verifySameContextReloadPersistence(input(snapshot({ provider: 'rejected' })), bridge());
    expect(result).toMatchObject({ status: 'confirmed', reason_codes: [ConsentAuditCodes.PERSISTENCE_CONFIRMED], semantic_channels: { provider: 'persisted' } });
  });

  it('reports not confirmed when an explicit semantic state resets', () => {
    const result = compareSameContextPersistence(input(snapshot({ provider: 'rejected' })), snapshot({ provider: 'unanswered' }));
    expect(result).toMatchObject({ status: 'not_confirmed', reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_CONFIRMED], semantic_channels: { provider: 'reset' } });
  });

  it('keeps unavailable provider APIs after reload inconclusive', () => {
    const result = compareSameContextPersistence(input(snapshot({ provider: 'rejected' })), snapshot({ provider: 'unavailable' }));
    expect(result).toMatchObject({ status: 'inconclusive', semantic_channels: { provider: 'unavailable' } });
  });

  it('keeps storage continuity without semantic state inconclusive and never exposes its value', () => {
    const storage = [{ storage_type: 'local_storage' as const, key_name: 'cookieyes-consent', domain: 'store.example', path: '/', expiry_class: 'persistent' as const, secure: true, http_only: false, same_site: 'lax' as const, exists: true, value_length: 12 }];
    const result = compareSameContextPersistence(input(snapshot({ provider: 'ambiguous' }, storage)), snapshot({ provider: 'ambiguous' }, storage));
    expect(result).toMatchObject({ status: 'inconclusive', storage_continuity: 'matching' });
    expect(JSON.stringify(result)).not.toContain('raw-consent');
  });

  it('confirms a persisted framework semantic state', () => {
    const result = compareSameContextPersistence(input(snapshot({ tcf: 'rejected' })), snapshot({ tcf: 'rejected' }));
    expect(result).toMatchObject({ status: 'confirmed', semantic_channels: { tcf: 'persisted' } });
  });

  it('keeps sessionStorage-only continuity inconclusive', () => {
    const storage = [{ storage_type: 'session_storage' as const, key_name: 'consent-state', domain: null, path: null, expiry_class: 'session' as const, secure: null, http_only: null, same_site: null, exists: true, value_length: 8 }];
    const result = compareSameContextPersistence(input(snapshot({ provider: 'ambiguous' }, storage)), snapshot({ provider: 'ambiguous' }, storage));
    expect(result).toMatchObject({ status: 'inconclusive', storage_continuity: 'matching' });
  });

  it('keeps navigation failure inconclusive', async () => {
    const result = await verifySameContextReloadPersistence(input(snapshot({ provider: 'rejected' })), bridge({ reloadSameContext: async () => ({ reloaded: false, same_context: true, origin_before: 'https://store.example', origin_after: null, navigation_interrupted: true }) }));
    expect(result).toMatchObject({ status: 'inconclusive', reason_codes: [ConsentAuditCodes.NAVIGATION_INTERRUPTED, ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  });

  it('maps a reload bridge exception to an inconclusive navigation result', async () => {
    const result = await verifySameContextReloadPersistence(input(snapshot({ provider: 'rejected' })), bridge({ reloadSameContext: async () => { throw new Error('navigation failed'); } }));
    expect(result).toMatchObject({ status: 'inconclusive', reason_codes: [ConsentAuditCodes.NAVIGATION_INTERRUPTED, ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  });

  it('does not reload without a meaningful action or verification attempt', async () => {
    let reloaded = false;
    const result = await verifySameContextReloadPersistence(input(snapshot({ provider: 'rejected' }), false), bridge({ reloadSameContext: async () => { reloaded = true; return { reloaded: true, same_context: true, origin_before: 'https://store.example', origin_after: 'https://store.example', navigation_interrupted: false }; } }));
    expect(result).toMatchObject({ status: 'not_applicable', reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] });
    expect(reloaded).toBe(false);
  });
});
