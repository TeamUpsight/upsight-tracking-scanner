import type { ConsentFrameworkObservations } from './framework-observers';
import type {
  GpcBrowserSignal,
  USPrivacyChoice,
  USPrivacyChoiceType,
  USPrivacyObservation,
  USPrivacyRight
} from './domain-types';

type LabelMeaning = {
  canonical_label: string;
  choice: USPrivacyChoiceType;
  rights: USPrivacyRight[];
  evidence: string;
};

/**
 * Deliberately small exact-label lexicon. Normalization handles punctuation,
 * case, whitespace, and diacritics; it does not fuzzy-match arbitrary privacy
 * copy or infer rights from a generic policy link.
 */
const US_PRIVACY_LABELS: Readonly<Record<string, LabelMeaning>> = Object.freeze({
  'do not sell my personal information': {
    canonical_label: 'Do Not Sell My Personal Information', choice: 'opt_out', rights: ['sale'], evidence: 'semantic_us_sale_opt_out'
  },
  'do not sell or share my personal information': {
    canonical_label: 'Do Not Sell or Share My Personal Information', choice: 'opt_out', rights: ['sale', 'sharing'], evidence: 'semantic_us_sale_sharing_opt_out'
  },
  'do not sell or share': {
    canonical_label: 'Do Not Sell or Share', choice: 'opt_out', rights: ['sale', 'sharing'], evidence: 'semantic_us_sale_sharing_opt_out'
  },
  'opt out of sale': {
    canonical_label: 'Opt Out of Sale', choice: 'opt_out', rights: ['sale'], evidence: 'semantic_us_sale_opt_out'
  },
  'opt out of sharing': {
    canonical_label: 'Opt Out of Sharing', choice: 'opt_out', rights: ['sharing'], evidence: 'semantic_us_sharing_opt_out'
  },
  'opt out of targeted advertising': {
    canonical_label: 'Opt Out of Targeted Advertising', choice: 'opt_out', rights: ['targeted_advertising'], evidence: 'semantic_us_targeted_advertising_opt_out'
  },
  'opt out of profiling': {
    canonical_label: 'Opt Out of Profiling', choice: 'opt_out', rights: ['profiling'], evidence: 'semantic_us_profiling_opt_out'
  },
  'your privacy choices': {
    canonical_label: 'Your Privacy Choices', choice: 'manage', rights: [], evidence: 'semantic_us_privacy_choices_manage'
  },
  'your california privacy choices': {
    canonical_label: 'Your California Privacy Choices', choice: 'manage', rights: [], evidence: 'semantic_us_privacy_choices_manage'
  },
  'limit the use of my sensitive personal information': {
    canonical_label: 'Limit the Use of My Sensitive Personal Information', choice: 'limit', rights: ['sensitive_data_use'], evidence: 'semantic_us_sensitive_data_limit'
  }
});

export function normalizeUSPrivacyLabel(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyUSPrivacyLabel(value: string): LabelMeaning | null {
  return US_PRIVACY_LABELS[normalizeUSPrivacyLabel(value)] || null;
}

export function isUSPrivacySemanticLabel(value: string) {
  return classifyUSPrivacyLabel(value) !== null;
}

export interface USPrivacySurfaceFact {
  id: string;
  visible: boolean;
  privacy_or_cookie_semantics: boolean;
  intent: string;
  strong_presentation?: boolean;
}

export interface USPrivacyControlFact {
  surface_id?: string;
  accessible_name: string;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  provider_specific?: boolean;
}

export interface BuildUSPrivacyObservationInput {
  geo: 'USA' | 'EU' | 'UK';
  provider: string | null;
  provider_confirmed: boolean;
  surfaces: readonly USPrivacySurfaceFact[];
  controls: readonly USPrivacyControlFact[];
  provider_controls?: readonly USPrivacyControlFact[];
  gpc_signal: GpcBrowserSignal;
  gpc_acknowledgement_observed: boolean | null;
  frameworks: ConsentFrameworkObservations;
}

function choiceFrom(control: USPrivacyControlFact, provider: string | null, source: USPrivacyChoice['source']) {
  if (!control.visible || !control.enabled || !control.actionable) return null;
  const meaning = classifyUSPrivacyLabel(control.accessible_name);
  if (!meaning) return null;
  return {
    choice: meaning.choice,
    rights: [...meaning.rights],
    availability: 'direct' as const,
    evidence: [meaning.evidence],
    accessible_name: meaning.canonical_label,
    source,
    provider
  } satisfies USPrivacyChoice;
}

function boundedSections(values: readonly number[] | undefined) {
  return [...new Set((values || []).filter((value) => Number.isInteger(value) && value >= 0 && value <= 10_000_000))]
    .sort((left, right) => left - right)
    .slice(0, 50);
}

export function buildUSPrivacyObservation(input: BuildUSPrivacyObservationInput): USPrivacyObservation | null {
  if (input.geo !== 'USA') return null;
  const confirmedSurfaceIds = new Set(input.surfaces
    .filter((surface) => surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent' && surface.strong_presentation === true)
    .map((surface) => surface.id));
  const choices: USPrivacyChoice[] = [];
  const retained = new Set<string>();
  const add = (choice: USPrivacyChoice | null) => {
    if (!choice) return;
    const key = `${choice.choice}:${choice.rights.join(',')}:${choice.accessible_name}`;
    if (retained.has(key) || choices.length >= 20) return;
    retained.add(key);
    choices.push(choice);
  };

  if (input.provider_confirmed) {
    for (const control of input.provider_controls || []) add(choiceFrom(control, input.provider, 'provider_control'));
  }
  for (const control of input.controls) {
    if (!control.surface_id || !confirmedSurfaceIds.has(control.surface_id)) continue;
    add(choiceFrom(control, input.provider, 'confirmed_privacy_surface'));
  }

  const sections = boundedSections(input.frameworks.gpp.ping?.applicable_sections);
  const gppPresent = input.frameworks.gpp.present;
  const signalEvidence = input.gpc_signal === 'present'
    ? 'gpc_signal_present' as const
    : input.gpc_signal === 'absent'
      ? 'gpc_signal_absent' as const
      : 'gpc_signal_unavailable' as const;
  return {
    observed: choices.length > 0 || input.gpc_acknowledgement_observed === true || gppPresent,
    jurisdiction: {
      requested_geo: 'USA',
      state_verified: null,
      framework_declared_sections: sections
    },
    choices,
    gpc: {
      browser_signal: input.gpc_signal,
      signal_evidence: signalEvidence,
      gpc_acknowledgement_observed: input.gpc_acknowledgement_observed,
      gpp_present: gppPresent,
      gpp_applicable_sections: sections
    }
  };
}

export function mergeUSPrivacyObservations(
  earlier: USPrivacyObservation | null | undefined,
  later: USPrivacyObservation | null | undefined
): USPrivacyObservation | null {
  if (!earlier && !later) return null;
  if (!earlier) return later!;
  if (!later) return earlier;
  const choices: USPrivacyChoice[] = [];
  const retained = new Set<string>();
  for (const choice of [...earlier.choices, ...later.choices]) {
    const key = `${choice.choice}:${choice.rights.join(',')}:${choice.accessible_name}`;
    if (retained.has(key) || choices.length >= 20) continue;
    retained.add(key);
    choices.push(choice);
  }
  const sections = boundedSections([
    ...earlier.jurisdiction.framework_declared_sections,
    ...later.jurisdiction.framework_declared_sections,
    ...earlier.gpc.gpp_applicable_sections,
    ...later.gpc.gpp_applicable_sections
  ]);
  const browserSignal = later.gpc.browser_signal !== 'unavailable'
    ? later.gpc.browser_signal
    : earlier.gpc.browser_signal;
  return {
    observed: earlier.observed || later.observed,
    jurisdiction: { requested_geo: 'USA', state_verified: null, framework_declared_sections: sections },
    choices,
    gpc: {
      browser_signal: browserSignal,
      signal_evidence: browserSignal === 'present' ? 'gpc_signal_present' : browserSignal === 'absent' ? 'gpc_signal_absent' : 'gpc_signal_unavailable',
      gpc_acknowledgement_observed: earlier.gpc.gpc_acknowledgement_observed === true || later.gpc.gpc_acknowledgement_observed === true
        ? true
        : earlier.gpc.gpc_acknowledgement_observed === false || later.gpc.gpc_acknowledgement_observed === false
          ? false
          : null,
      gpp_present: earlier.gpc.gpp_present || later.gpc.gpp_present,
      gpp_applicable_sections: sections
    }
  };
}
