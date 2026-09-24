import { describe, expect, it } from 'vitest';
import {
  observeConsentFrameworks,
  observeGppFramework,
  observeTcfFramework,
  observeUspFramework,
  mergeConsentFrameworkObservations,
  type FrameworkApiWindow
} from './framework-observers';
import { ConsentAuditCodes } from './domain-types';

type ApiCall = { command: string; parameter?: unknown };

function tcfFixture(options: { ping?: unknown; events?: unknown[]; omitPingReply?: boolean }) {
  const calls: ApiCall[] = [];
  const api = (command: string, _version: number, callback: (payload: unknown, success?: boolean) => void, parameter?: unknown) => {
    calls.push({ command, parameter });
    if (command === 'ping' && !options.omitPingReply) callback(options.ping, true);
    if (command === 'addEventListener') {
      for (const event of options.events || []) callback(event, true);
    }
  };
  return { runtime: { __tcfapi: api } satisfies FrameworkApiWindow, calls };
}

function gppFixture(ping: unknown, events: unknown[] = []) {
  const calls: ApiCall[] = [];
  const api = (command: string, callback: (payload: unknown, success?: boolean) => void, parameter?: unknown) => {
    calls.push({ command, parameter });
    if (command === 'ping') callback(ping, true);
    if (command === 'addEventListener') for (const event of events) callback(event, true);
  };
  return { runtime: { __gpp: api } satisfies FrameworkApiWindow, calls };
}

const readyGppPing = {
  gppVersion: '1.1',
  cmpStatus: 'loaded',
  cmpDisplayStatus: 'visible',
  signalStatus: 'ready',
  cmpId: 42,
  supportedAPIs: ['tcfeuv2', 'uspv1'],
  sectionList: [2, 7],
  applicableSections: [7],
  gppString: 'must-not-be-persisted'
};

describe('Consent framework observers', () => {
  it('reports no framework without treating absence as CMP attribution', () => {
    const frameworks = observeConsentFrameworks({});

    expect(frameworks.tcf.state.lifecycle).toBe('absent');
    expect(frameworks.gpp.state.lifecycle).toBe('absent');
    expect(frameworks.usp).toEqual({ present: false, mode: 'absent', reason_codes: [] });
    expect(JSON.stringify(frameworks)).not.toContain('provider');
  });

  it('distinguishes an unresponsive TCF stub from a loading TCF API', () => {
    const stub = tcfFixture({ omitPingReply: true });
    const loading = tcfFixture({ ping: { cmpLoaded: false, apiVersion: '2.2' } });

    expect(observeTcfFramework(stub.runtime).state.lifecycle).toBe('stub_present');
    expect(observeTcfFramework(loading.runtime).state).toMatchObject({
      lifecycle: 'loading',
      ping: { cmp_loaded: false, api_version: '2.2' }
    });
  });

  it('uses TCF addEventListener for loaded and user-action state changes without retaining a TC string', () => {
    const { runtime, calls } = tcfFixture({
      ping: { cmpLoaded: true, apiVersion: '2.3', gdprApplies: true },
      events: [
        { listenerId: 12, eventStatus: 'cmpuishown' },
        {
          listenerId: 12,
          eventStatus: 'tcloaded',
          cmpId: 101,
          cmpVersion: 4,
          gdprApplies: true,
          tcString: 'raw-tcf-string',
          purpose: { consents: { 1: true, 2: false } },
          vendor: { consents: { 11: true, 22: true, 33: false } }
        },
        {
          listenerId: 12,
          eventStatus: 'useractioncomplete',
          cmpId: 101,
          cmpVersion: 4,
          gdprApplies: true,
          tcString: 'other-raw-tcf-string',
          purpose: { consents: { 1: false, 2: false } },
          vendor: { consents: { 11: false } }
        }
      ]
    });

    const observer = observeTcfFramework(runtime);

    expect(calls.map((call) => call.command)).toEqual(['ping', 'addEventListener']);
    expect(observer.state).toMatchObject({
      lifecycle: 'ready',
      event_count: 3,
      latest_event: {
        event_status: 'useractioncomplete',
        cmp_status: null,
        purpose_consents: { total_count: 2, granted_count: 0, denied_count: 2 },
        vendor_consents: { total_count: 1, granted_count: 0, denied_count: 1 }
      }
    });
    expect(JSON.stringify(observer.state)).not.toContain('raw-tcf-string');
    expect(observer.state).toMatchObject({ listener_registered: true, listener_event_observed: true, listener_registration_failed: false });
    observer.stop();
    expect(calls.at(-1)).toEqual({ command: 'removeEventListener', parameter: 12 });
  });

  it('preserves unknown sanitized consent aggregates instead of reinterpreting zero counters as an empty map', () => {
    const unknown = tcfFixture({
      ping: { cmpLoaded: true, apiVersion: '2.2' },
      events: [{
        listenerId: 1,
        cmpStatus: 'loaded',
        eventStatus: 'cmpuishown',
        purpose: { consents: { known: false, total_count: 0, granted_count: 0, denied_count: 0 } },
        vendor: { consents: { known: false, total_count: 0, granted_count: 0, denied_count: 0 } }
      }]
    });
    const empty = tcfFixture({
      ping: { cmpLoaded: true, apiVersion: '2.2' },
      events: [{ listenerId: 1, cmpStatus: 'loaded', eventStatus: 'cmpuishown', purpose: { consents: {} }, vendor: { consents: {} } }]
    });

    expect(observeTcfFramework(unknown.runtime).state.latest_event).toMatchObject({
      purpose_consents: { known: false, total_count: 0 },
      vendor_consents: { known: false, total_count: 0 }
    });
    expect(observeTcfFramework(empty.runtime).state.latest_event).toMatchObject({
      purpose_consents: { known: true, total_count: 0 },
      vendor_consents: { known: true, total_count: 0 }
    });
  });

  it('keeps cmpuishown pre-choice while recognizing a loaded CMP and usable listener callback', () => {
    const { runtime } = tcfFixture({
      ping: { cmpLoaded: null, apiVersion: '2.2', cmpStatus: 'loading' },
      events: [{ listenerId: 8, eventStatus: 'cmpuishown', cmpStatus: 'loaded', purpose: { consents: { 1: false } }, vendor: { consents: { 2: false } } }]
    });
    const state = observeTcfFramework(runtime).state;
    expect(state).toMatchObject({
      lifecycle: 'ready', listener_registered: true, listener_event_observed: true, event_count: 1,
      latest_event: { event_status: 'cmpuishown', cmp_status: 'loaded', purpose_consents: { known: true, total_count: 1, denied_count: 1 }, vendor_consents: { known: true, total_count: 1, denied_count: 1 } }
    });
  });

  it('reconciles an initial stub ping only after a successful loaded listener event', () => {
    const loaded = tcfFixture({
      ping: { cmpLoaded: false, cmpStatus: 'stub', apiVersion: '2.2' },
      events: [{ listenerId: 11, cmpStatus: 'loaded', eventStatus: 'cmpuishown', purpose: { consents: { 1: false } }, vendor: { consents: { 2: false } } }]
    });
    expect(observeTcfFramework(loaded.runtime).state).toMatchObject({ lifecycle: 'ready', lifecycle_reconciled: true, ping: { cmp_loaded: false }, listener_registered: true, latest_event: { cmp_status: 'loaded', event_status: 'cmpuishown' } });

    const unregistered = tcfFixture({
      ping: { cmpLoaded: false, cmpStatus: 'stub', apiVersion: '2.2' },
      events: [{ cmpStatus: 'loaded', eventStatus: 'cmpuishown', purpose: { consents: { 1: false } }, vendor: { consents: { 2: false } } }]
    });
    expect(observeTcfFramework(unregistered.runtime).state).toMatchObject({ lifecycle: 'stub_present', lifecycle_reconciled: false, listener_registered: false });
  });

  it('keeps a later TCF error authoritative after a loaded listener event', () => {
    const { runtime } = tcfFixture({
      ping: { cmpLoaded: false, cmpStatus: 'stub', apiVersion: '2.2' },
      events: [
        { listenerId: 12, cmpStatus: 'loaded', eventStatus: 'cmpuishown', purpose: { consents: { 1: false } }, vendor: { consents: { 2: false } } },
        { listenerId: 12, cmpStatus: 'error', eventStatus: 'unknown' }
      ]
    });
    expect(observeTcfFramework(runtime).state).toMatchObject({ lifecycle: 'error', lifecycle_reconciled: true, latest_event: { cmp_status: 'error', event_status: 'unknown' } });
  });

  it('records TCF listener registration failure as an error', () => {
    const runtime: FrameworkApiWindow = {
      __tcfapi(command, _version, callback) {
        if (command === 'ping') callback({ cmpLoaded: true, apiVersion: '2.2', cmpStatus: 'loaded' }, true);
        if (command === 'addEventListener') callback({ listenerId: 0, eventStatus: 'cmpuishown' }, false);
      }
    };
    expect(observeTcfFramework(runtime).state).toMatchObject({ lifecycle: 'error', listener_registration_failed: true, listener_registered: false });
  });

  it.each([
    ['stub', 'stub_present', 'stub'],
    ['loading', 'loading', 'loading'],
    ['ready', 'ready', 'loaded'],
    ['error', 'error', 'error']
  ] as const)('normalizes GPP %s lifecycle', (_name, lifecycle, cmpStatus) => {
    const { runtime } = gppFixture({ ...readyGppPing, cmpStatus });
    const observer = observeGppFramework(runtime);

    expect(observer.state.lifecycle).toBe(lifecycle);
    expect(observer.state.reason_codes).toContain(ConsentAuditCodes.GPP_PRESENT);
    if (cmpStatus === 'stub') expect(observer.state.reason_codes).toContain(ConsentAuditCodes.GPP_STUB_PRESENT);
    if (cmpStatus === 'error') expect(observer.state.reason_codes).toContain(ConsentAuditCodes.DETECTION_INCONCLUSIVE);
  });

  it.each(['visible', 'hidden', 'disabled'] as const)('keeps GPP display status %s as framework state only', (display) => {
    const { runtime } = gppFixture({ ...readyGppPing, cmpDisplayStatus: display });
    const observer = observeGppFramework(runtime);

    expect(observer.state.ping?.cmp_display_status).toBe(display);
    expect(JSON.stringify(observer.state)).not.toContain('banner');
  });

  it('uses GPP listener updates and removes the registered listener', () => {
    const { runtime, calls } = gppFixture(
      { ...readyGppPing, cmpStatus: 'loading' },
      [{ listenerId: 'listener-1', eventName: 'signalStatus', pingData: readyGppPing }]
    );
    const observer = observeGppFramework(runtime);

    expect(observer.state).toMatchObject({ lifecycle: 'ready', event_count: 1, ping: { signal_status: 'ready' } });
    expect(JSON.stringify(observer.state)).not.toContain('must-not-be-persisted');
    observer.stop();
    expect(calls.at(-1)).toEqual({ command: 'removeEventListener', parameter: 'listener-1' });
  });

  it('records no applicable section separately from supported and payload sections', () => {
    const { runtime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat'], sectionList: [7], applicableSections: [-1], parsedSections: { usnat: [{ SaleOptOut: 1 }] } });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure).toMatchObject({ supported_sections: [7], present_sections: [7], cmp_declared_applicable_sections: [-1], structural_consistency: 'consistent' });
    expect(structure.sections[0]).toMatchObject({ section_id: 7, supported: true, present: true, cmp_declared_applicable: false, parsed_available: true, state: 'not_declared_applicable' });
  });

  it('normalizes a known applicable US section as technical identity with parsed data available only', () => {
    const { runtime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat'], sectionList: [7], applicableSections: [7], parsedSections: { usnat: [{ SaleOptOut: 1, CmpId: 123, PublisherId: 'private' }] } });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure.sections).toEqual([expect.objectContaining({
      section_id: 7, api_prefix: 'usnat', known: true, family: 'us_national', technical_label: 'US National',
      supported: true, present: true, cmp_declared_applicable: true, parsed_available: true, state: 'parsed_uninterpreted'
    })]);
    expect(JSON.stringify(structure)).not.toMatch(/SaleOptOut|CmpId|PublisherId|private/);
    expect(JSON.stringify(structure)).not.toMatch(/law applies|state_verified/i);
  });

  it('preserves two CMP-declared applicable sections independently', () => {
    const { runtime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat', '8:usca'], sectionList: [7, 8], applicableSections: [7, 8], parsedSections: { usnat: [{}], usca: [{}] } });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure.sections.map((section) => [section.section_id, section.cmp_declared_applicable, section.parsed_available])).toEqual([[7, true, true], [8, true, true]]);
  });

  it('preserves an unknown future section without invalidating known GPP evidence', () => {
    const { runtime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat', '99:usfuture'], sectionList: [7, 99], applicableSections: [99], parsedSections: { usnat: [{}], usfuture: [{}] } });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure.sections.find((section) => section.section_id === 99)).toMatchObject({ section_id: 99, api_prefix: 'usfuture', known: false, supported: true, present: true, cmp_declared_applicable: true, parsed_available: true });
    expect(structure.sections.find((section) => section.section_id === 7)).toMatchObject({ known: true, present: true });
    expect(structure.structural_consistency).toBe('consistent');
  });

  it('flags a ready applicable section missing from the physical section list', () => {
    const { runtime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat'], sectionList: [], applicableSections: [7], parsedSections: { usnat: [{}] } });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure.structural_consistency).toBe('inconsistent');
    expect(structure.reason_codes).toContain('GPP_APPLICABLE_SECTION_MISSING_FROM_PAYLOAD');
    expect(structure.sections[0]).toMatchObject({ present: false, cmp_declared_applicable: true, state: 'unavailable' });
  });

  it('keeps an applicable and present section inconclusive when parsed data is unavailable', () => {
    const { runtime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat'], sectionList: [7], applicableSections: [7], parsedSections: {} });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure.structural_consistency).toBe('inconclusive');
    expect(structure.parsed_sections_available).toBe(false);
    expect(structure.sections[0]).toMatchObject({ present: true, cmp_declared_applicable: true, parsed_available: false, state: 'unavailable' });
    expect(structure.reason_codes).toContain('GPP_APPLICABLE_PARSED_SECTION_UNAVAILABLE');
  });

  it('keeps parsed data incomplete while signalStatus is not ready', () => {
    const { runtime } = gppFixture({ ...readyGppPing, signalStatus: 'not ready', supportedAPIs: ['7:usnat'], sectionList: [7], applicableSections: [7], parsedSections: { usnat: [{ SaleOptOut: 1 }] } });
    const structure = observeGppFramework(runtime).state.structure!;
    expect(structure.structural_consistency).toBe('inconclusive');
    expect(structure.sections[0]).toMatchObject({ parsed_available: true, state: 'incomplete' });
    expect(structure.reason_codes).toContain('GPP_SIGNAL_NOT_READY');
    expect(JSON.stringify(structure)).not.toMatch(/opt_out|opt_in/i);
  });

  it('retains the -1 no-applicable sentinel and resolves not-ready to the final ready event', () => {
    const notReady = { ...readyGppPing, signalStatus: 'not ready', supportedAPIs: ['7:usnat'], sectionList: [7], applicableSections: [-1], parsedSections: { usnat: [{}] } };
    const sectionChange = { ...notReady, applicableSections: [7] };
    const ready = { ...sectionChange, signalStatus: 'ready' };
    const { runtime } = gppFixture(notReady, [
      { listenerId: 'listener-ready', pingData: notReady },
      { listenerId: 'listener-ready', eventName: 'sectionChange', pingData: sectionChange },
      { listenerId: 'listener-ready', pingData: ready }
    ]);
    const observer = observeGppFramework(runtime);
    expect(observer.state.ping?.applicable_sections).toEqual([7]);
    expect(observer.state.structure?.sections[0]).toMatchObject({ cmp_declared_applicable: true, state: 'parsed_uninterpreted' });
    expect(observer.state.event_count).toBe(3);
  });

  it('does not multiply cumulative GPP event counts when the same page is sampled again', () => {
    const { runtime } = gppFixture(readyGppPing, [{ listenerId: 1, pingData: readyGppPing }]);
    const gpp = observeGppFramework(runtime).state;
    const observation = observeConsentFrameworks({ __gpp: runtime.__gpp });
    const merged = mergeConsentFrameworkObservations({ tcf: observeTcfFramework({}).state, gpp, usp: observeUspFramework({}) }, {
      tcf: observation.tcf.state, gpp: observation.gpp.state, usp: observation.usp
    });
    expect(merged.gpp.event_count).toBe(1);
  });

  it('uses the bridge cumulative event count when replaying its latest event', () => {
    const { runtime } = gppFixture(readyGppPing, [{ listenerId: 1, pingData: readyGppPing, eventCount: 7 }]);
    expect(observeGppFramework(runtime).state.event_count).toBe(7);
  });

  it('preserves a completed GPP structure when a later sample is not ready', () => {
    const { runtime: readyRuntime } = gppFixture({ ...readyGppPing, supportedAPIs: ['7:usnat'], sectionList: [7], applicableSections: [7], parsedSections: { usnat: [{}] } });
    const { runtime: pendingRuntime } = gppFixture({ ...readyGppPing, signalStatus: 'not ready', supportedAPIs: [], sectionList: [], applicableSections: [] });
    const empty = {
      tcf: observeTcfFramework({}).state,
      gpp: observeGppFramework({}).state,
      usp: observeUspFramework({})
    };
    const ready = observeGppFramework(readyRuntime).state;
    const pending = observeGppFramework(pendingRuntime).state;
    const merged = mergeConsentFrameworkObservations(
      { ...empty, gpp: ready },
      { ...empty, gpp: pending }
    );
    expect(merged.gpp.ping?.signal_status).toBe('ready');
    expect(merged.gpp.structure?.sections[0]).toMatchObject({ section_id: 7, cmp_declared_applicable: true, parsed_available: true });
  });

  it('preserves a loaded TCF listener lifecycle across a later stub-only sample and accepts a later error', () => {
    const loaded = observeTcfFramework(tcfFixture({
      ping: { cmpLoaded: false, cmpStatus: 'stub', apiVersion: '2.2' },
      events: [{ listenerId: 2, cmpStatus: 'loaded', eventStatus: 'cmpuishown', purpose: { consents: { 1: false } }, vendor: { consents: { 2: false } } }]
    }).runtime).state;
    const stub = observeTcfFramework(tcfFixture({ ping: { cmpLoaded: false, cmpStatus: 'stub', apiVersion: '2.2' } }).runtime).state;
    const empty = { tcf: observeTcfFramework({}).state, gpp: observeGppFramework({}).state, usp: observeUspFramework({}) };
    const retained = mergeConsentFrameworkObservations({ ...empty, tcf: loaded }, { ...empty, tcf: stub });
    expect(retained.tcf).toMatchObject({ lifecycle: 'ready', ping: { cmp_loaded: false }, latest_event: { cmp_status: 'loaded' }, lifecycle_reconciled: true });

    const errored = observeTcfFramework(tcfFixture({ ping: { cmpLoaded: false, cmpStatus: 'error', apiVersion: '2.2' } }).runtime).state;
    expect(mergeConsentFrameworkObservations({ ...empty, tcf: loaded }, { ...empty, tcf: errored }).tcf.lifecycle).toBe('error');
  });

  it('treats USP as legacy read-only evidence without converting it into GPP', () => {
    const usp = observeUspFramework({ __uspapi: () => {} });

    expect(usp).toEqual({
      present: true,
      mode: 'legacy_read_only',
      reason_codes: [ConsentAuditCodes.USP_PRESENT]
    });
  });

  it('keeps simultaneous TCF and GPP observations independent', () => {
    const { runtime: tcfRuntime } = tcfFixture({ ping: { cmpLoaded: true, apiVersion: '2.3' } });
    const { runtime: gppRuntime } = gppFixture(readyGppPing);
    const frameworks = observeConsentFrameworks({ ...tcfRuntime, ...gppRuntime, __uspapi: () => {} });

    expect(frameworks.tcf.state.reason_codes).toEqual([ConsentAuditCodes.TCF_PRESENT]);
    expect(frameworks.gpp.state.reason_codes).toEqual([ConsentAuditCodes.GPP_PRESENT]);
    expect(frameworks.usp.reason_codes).toEqual([ConsentAuditCodes.USP_PRESENT]);
  });
});
