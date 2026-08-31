import { describe, expect, it } from 'vitest';
import {
  CONSENT_AUDIT_RESULT_CODES,
  ConsentAuditCodes,
  isConsentAuditCode,
  type FinalConsentAuditResult
} from './domain-types';

describe('Consent Audit V2 domain taxonomy', () => {
  it('keeps result codes enumerable and type-guards known values', () => {
    expect(CONSENT_AUDIT_RESULT_CODES).toContain(ConsentAuditCodes.CMP_DETECTED);
    expect(CONSENT_AUDIT_RESULT_CODES).toContain(ConsentAuditCodes.BLOCKED_OR_CHALLENGED);
    expect(new Set(CONSENT_AUDIT_RESULT_CODES).size).toBe(CONSENT_AUDIT_RESULT_CODES.length);
    expect(isConsentAuditCode('ACTION_VERIFIED')).toBe(true);
    expect(isConsentAuditCode('UNRELATED_REASON')).toBe(false);
  });

  it('models detection, interaction, verification, and persistence independently', () => {
    const result: FinalConsentAuditResult = {
      context_clean: { status: 'verified', evidence: [], reason_codes: [] },
      geo_verified: { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.GEO_UNVERIFIED] },
      mechanisms: [{
        mechanism: 'cmp',
        detection: { status: 'verified', evidence: ['provider_signal'], reason_codes: [ConsentAuditCodes.CMP_DETECTED] },
        provider: {
          attribution: 'identified',
          confidence: 'high',
          candidates: [{ provider_name: 'Example CMP', attribution: 'identified', confidence: 'high', evidence: [], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }],
          reason_codes: [ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
        },
        adapter_maturity: 'unvalidated'
      }],
      banner: { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] },
      available_actions: [{ action: 'reject_all', availability: 'direct', category: null, evidence: [], reason_codes: [ConsentAuditCodes.REJECT_AVAILABLE] }],
      initial_state: { decision: 'unanswered', categories: [], evidence: [], reason_codes: [] },
      resulting_state: { decision: 'rejected', categories: [], evidence: [], reason_codes: [] },
      interactions: [{ action: 'reject_all', origin: 'semantic_ui', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] }],
      rejection_verification: { status: 'not_verified', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_NOT_VERIFIED] },
      persistence: { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] },
      frameworks: { tcf: 'not_present', gpp: 'unknown', usp: 'not_present', evidence: [], reason_codes: [] },
      google_consent_mode: { presence: 'not_present', defaults_observed: null, updates_observed: null, evidence: [], reason_codes: [] },
      storage_changes: [{ storage_type: 'cookie', key_name: 'consent_state', change: 'updated' }],
      network_signals: [],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED]
    };

    expect(result.interactions[0].outcome).toBe('executed');
    expect(result.rejection_verification.status).toBe('not_verified');
    expect(result.persistence.status).toBe('inconclusive');
  });
});
