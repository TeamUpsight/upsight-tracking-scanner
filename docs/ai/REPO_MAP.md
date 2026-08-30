# Repository map

```text
upsight-tracking-scanner-codex/
├── AGENTS.md                       # concise instructions loaded by coding agents
├── README.md                       # product use, commands, status/config overview
├── ARCHITECTURE.md                 # detailed runtime invariants and flow
├── QUALITY_SYSTEM.md               # replay, QA, metrics, fixtures, status semantics
├── ACCESS_RELIABILITY.md           # DNS/proxy/challenge/authorized-access policy
├── DEPLOYMENT.md                   # current Node unit and future Cloudflare split
├── CODEX_HANDOFF.md                # dated implementation history and live observations
├── package.json                    # scripts and runtime/build dependencies
├── .env.example                    # configuration contract and safe example values
├── server.ts                       # Express API, auth, queue, recovery, exports, serving
├── scripts/
│   ├── replay.ts                   # offline Evidence Bundle replay CLI
│   └── access-benchmark.ts         # authorized live access reliability corpus
├── src/
│   ├── main.tsx                    # React entry point
│   ├── App.tsx                     # operations workspace and local UI state
│   ├── index.css                   # Tailwind v4 theme tokens and global styles
│   ├── types.ts                    # persisted/API evidence and audit contracts
│   ├── db.ts                       # PostgreSQL/memory storage and startup DDL
│   ├── scanner.ts                  # compatibility exports over modular scanner code
│   ├── shared/config.ts            # bounded integer environment parsing
│   ├── ui/                         # dashboards, insight panels, API/format helpers
│   └── scanner/
│       ├── audit-runner.ts         # live browser orchestration and finalization
│       ├── navigation.ts           # DNS and ordered access classification
│       ├── browser-session.ts      # default-context reuse and geo alignment
│       ├── browserless-bql.ts      # manual solve/reconnect handoff
│       ├── authorized-access.ts    # exact-domain document-only header injection
│       ├── proxy/decodo.ts         # proxy validation, rotation, health, trace summary
│       ├── evidence/               # bounded normalized capture
│       ├── tracking/               # central GA4 and Meta parsers
│       ├── consent/                # CMP detection and verified state transitions
│       ├── server-side/            # collection/duplicate classification
│       ├── resolver/               # status semantics and finalize-once guard
│       ├── persistence/            # ordered update serialization
│       ├── quality/                # replay, consistency, metrics, QA/debug/reviewer
│       └── scanner-core.test.ts    # deterministic regression/guardrail suite
├── tests/fixtures/                 # sanitized targeted inputs and replay corpus
├── docs/ai/                        # progressive AI context layer
├── dist/                           # generated production output; do not inspect/edit
└── node_modules/                   # installed dependencies; do not inspect/edit
```

## Critical files by question

| Question | Start with |
| --- | --- |
| What does the system guarantee? | `ARCHITECTURE.md`, `src/types.ts` |
| Why did a live scan produce a result? | stored evidence/trace, then `audit-runner.ts`, relevant detector, resolver, consistency |
| How should a detector bug be fixed? | `QUALITY_SYSTEM.md`, matching parser/resolver, targeted fixture/test, replay |
| How is a scan scheduled or recovered? | `server.ts` queue/recovery sections, then `src/db.ts` |
| How is data stored? | `src/types.ts`, `src/db.ts` |
| Which endpoint/UI action is involved? | route in `server.ts`, caller in `src/App.tsx`, `src/ui/api.ts` |
| How does proxy/access behavior work? | `ACCESS_RELIABILITY.md`, `navigation.ts`, `proxy/decodo.ts`, bounded runner phase |
| How is production built/deployed? | `package.json`, `vite.config.ts`, `DEPLOYMENT.md` |

## Search boundaries

Exclude `node_modules/`, `dist/`, `.env`, binary debug artifacts, and `package-lock.json` unless the task explicitly concerns them. Search the relevant symbol or endpoint before opening the large orchestration/UI/server/test files. `CODEX_HANDOFF.md` is dated context; source, tests, evidence, and traces win on conflict.
