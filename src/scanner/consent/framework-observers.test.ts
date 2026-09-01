import { describe, expect, it } from 'vitest';
import {
  observeConsentFrameworks,
  observeGppFramework,
  observeTcfFramework,
  observeUspFramework,
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
        purpose_consents: { total_count: 2, granted_count: 0, denied_count: 2 },
        vendor_consents: { total_count: 1, granted_count: 0, denied_count: 1 }
      }
    });
    expect(JSON.stringify(observer.state)).not.toContain('raw-tcf-string');
    observer.stop();
    expect(calls.at(-1)).toEqual({ command: 'removeEventListener', parameter: 12 });
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
