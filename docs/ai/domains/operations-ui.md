# Domain: operations UI

## Responsibility

Provides the internal SPA for creating and monitoring audits, inspecting findings/evidence, exporting/replaying/reviewing results, submitting QA feedback, resolving review candidates, viewing quality analytics, and checking proxy/queue readiness.

## Primary files

- `src/main.tsx` — React root.
- `src/App.tsx` — four views, scan forms, local state, polling, endpoint actions, master/detail workspace.
- `src/ui/api.ts` — Bearer-aware fetch/error wrapper and blob download.
- `src/ui/Analytics.tsx` — quality and proxy dashboards/charts.
- `src/ui/AuditInsights.tsx` — deterministic review/replay panels and trace timeline.
- `src/ui/StatusBadge.tsx`, `format.ts` — shared presentation helpers.
- `src/index.css` — Tailwind v4 import, Upsight theme tokens, focus/cursor/global utilities.
- `index.html`, `vite.config.ts` — SPA shell and React/Tailwind build integration.
- `src/types.ts` — typed audit/finding contracts. Some analytics/operations responses are currently `any`.

## UI architecture

There is no client router or global state store. `App` uses hooks and a local `view` discriminator for Audits, Quality, Review Queue, and Access/Proxy Health. It stores the internal API token in `sessionStorage`, polls active audits, and loads view-specific data on demand. Styling is Tailwind utility-first with a small global theme and reusable `action-button` class.

The Audits view combines scan creation, filtering/selection, bulk actions, audit detail, reruns/cancel/delete/debug export, evidence codes, QA correction, replay/reviewer, and trace. Quality and proxy panels are extracted into `Analytics.tsx`; replay/review display is extracted into `AuditInsights.tsx`.

## API dependencies

The UI calls the versioned endpoints in `server.ts` for scan lifecycle, QA, replay/review, metrics, review candidates, proxy readiness, and queue state. `StorefrontAudit` is shared, but metrics/readiness/queue/reviewer response types are not yet strong contracts. When changing an endpoint, inspect its caller by searching the exact path.

## Common modification points

- Small copy/layout/status change: bounded JSX section in `App.tsx` or the relevant extracted component.
- New audit action: handler near existing request functions, server route, busy/error behavior, and the selected/list refresh path.
- Quality/proxy visualization: `Analytics.tsx`; add a response interface before increasing shape complexity.
- Replay/reviewer/trace presentation: `AuditInsights.tsx`; preserve observed-versus-derived distinction.
- Theme/accessibility: `index.css` tokens and existing focus-visible/button/semantic patterns.
- Larger view work: extract a view component with explicit props as part of the feature rather than rewriting the whole app.

## Validation

```text
npm run typecheck
npm run build
```

Run deterministic tests when changing status semantics or shared formatting logic. Perform a manual rendered smoke for affected views/actions when a safe local API is available; record if visual/e2e validation was not run. Do not edit `dist` to test a UI fix.

## Pitfalls and invariants

- Preserve token handling without logging or rendering the value; production still requires a trusted perimeter.
- Keep all async actions reporting understandable errors and restoring busy state.
- Avoid introducing a second endpoint shape or duplicating status formatting in a component.
- Do not show internal machine codes without the human-readable label/hover pattern where one already exists.
- Destructive delete controls require explicit selection/confirmation behavior; do not make them easier to trigger accidentally.
- Maintain keyboard focus styles, labels, button semantics, external-link safety, and responsive overflow for wide tables.
- Avoid loading large evidence/screenshots into list endpoints or duplicating the sanitized trace inside reviewer results.
