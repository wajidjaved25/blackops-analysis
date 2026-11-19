# USDT Chain Analysis Platform — Plan

A Chainalysis-style investigation and compliance platform for **USDT on Tron (TRC20) and Ethereum (ERC20)**.
Task-level breakdown and progress live in [task.md](task.md). This file is the "what and why"; task.md is the "do this next".

---

## 1. Goal

Give investigators and compliance teams one tool to:

1. **Look up** any USDT wallet (balance, history, counterparties).
2. **Trace** where money came from and went (interactive graph, path finding).
3. **Screen** wallets for risk (sanctions, Tether freezes, scams, exchanges) — singly, in bulk, or by API.
4. **Monitor** wallets continuously and raise alerts.
5. **Build cases** and export evidence reports (PDF/CSV) for police, courts, or compliance.

## 2. Feature parity with Chainalysis

| Chainalysis product | What it does | Our module | Parity |
|---|---|---|---|
| Reactor | Visual fund-flow investigation graph | Investigations | ✅ Full |
| Address Screening | Is this wallet risky? | Screening | ✅ Full |
| Sanctions Screening API | OFAC check by API | Sanctions + public API | ✅ Full (free data) |
| KYT | Real-time transaction monitoring + alerts | Monitoring | ✅ Full (polling first, indexer later) |
| Storyline | Timeline view for non-experts | Case timeline | ✅ Full |
| Case management / reporting | Save work, notes, export | Cases + Reports | ✅ Full |
| Entity attribution | Millions of labelled wallets | Labels DB + clustering + manual tagging | ⚠️ Partial — their dataset is proprietary and built over years; ours grows from public sources + our own tagging |
| Hexagate, training, seizure services | Security monitoring, courses, legal services | — | ❌ Out of scope |

**Honest limit:** the software can match Chainalysis; the *labelled-address database* cannot be copied. Our accuracy depends on how many labels we collect (Phase 5).

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | **NestJS** (TypeScript) | User choice; modules map cleanly to product areas |
| Frontend | **Next.js** (TypeScript, App Router) | User choice; proxies `/api/*` to backend, so no CORS |
| Graph UI | **Cytoscape.js** | Mature, handles thousands of nodes, built-in layouts |
| Database | **PostgreSQL** + **Prisma** | Labels, cases, alerts, watchlists, transfer cache |
| Jobs | **Redis + BullMQ** | Monitoring polls, bulk screening, list refreshes |
| Runtime | Node 24, Docker Compose for Postgres + Redis | Same setup on every machine |

No database/Redis until Phase 2 needs them — Phase 1 runs on an in-memory cache.

## 4. Architecture

```
┌──────────────┐  /api/*   ┌────────────────────────── NestJS ──────────────────────────┐
│  Next.js UI  │ ────────► │ chains   lookup   graph   risk   screen   monitor   cases  │
└──────────────┘           └────┬───────────────────────────┬───────────────┬────────────┘
                                │                           │               │
                 ┌──────────────┴─────────┐          ┌──────┴─────┐   ┌─────┴─────┐
                 │ Data sources            │          │ PostgreSQL │   │  Redis /  │
                 │ • TronGrid  (TRC20)     │          │            │   │  BullMQ   │
                 │ • Etherscan (ERC20)     │          └────────────┘   └───────────┘
                 │ • OFAC address lists    │
                 │ • USDT contract freezes │
                 └─────────────────────────┘
```

### Data strategy
- **Now (Phases 1–4):** on-demand calls to TronGrid / Etherscan, cached and rate-limited per host.
- **Later (Phase 7):** our own **USDT indexer** writing every transfer into Postgres. Needed for true real-time KYT, deep multi-hop traces, and fast path finding. Tron USDT is millions of transfers per day → large disk + paid API or own node.

### Key constants
| | Tron | Ethereum |
|---|---|---|
| USDT contract | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Decimals | 6 | 6 |
| Address format | `T` + 33 base58 chars (case-sensitive) | `0x` + 40 hex (store lowercase) |
| Data API | TronGrid (key optional) | Etherscan v2 (key required) |
| Freeze check | `isBlackListed(address)` via `triggerconstantcontract` | `isBlackListed(address)` = `0xe47d6060` via `eth_call` |

## 5. Risk model

**Score 0–100, always shown with written reasons.** A score without reasons is never shown.

| Category | Weight |
|---|---|
| Sanctioned (OFAC) | 100 |
| Frozen by Tether | 100 |
| Ransomware / darknet / terror financing | 95 |
| Scam / fraud | 90 |
| Mixer | 80 |
| Gambling (unlicensed) | 50 |
| Other flagged | 20 |
| Exchange / service | 0 (informational) |

- **Own risk** = highest weight among the wallet's own labels/flags.
- **Direct exposure** (1 hop) = Σ(weight × volume with flagged counterparty) ÷ total volume.
- **Indirect exposure** (2–3 hops) = same, discounted ×0.5 per extra hop.
- **Final** = max(own, direct, indirect).
- **Levels:** ≥75 Severe · ≥40 High · ≥15 Medium · else Low.

## 6. Data model (Prisma, from Phase 2)

| Table | Key fields |
|---|---|
| `Label` | chain, address, name, category, source (`ofac`/`tether`/`manual`/`import`/`cluster`), confidence |
| `Transfer` | chain, hash, from, to, amount, timestamp (cache now, index later) |
| `Case` | title, status, description, graphJson, createdBy |
| `CaseAddress` | caseId, chain, address, role (suspect/victim/exchange/…), note |
| `CaseNote` / `CaseFile` | caseId, body / file path, author |
| `Watchlist` / `WatchItem` | name / chain, address, lastSeenTxTs |
| `Rule` | type (`amount_over`/`flagged_counterparty`/`volume_spike`), params |
| `Alert` | watchItemId, ruleId, txHash, amount, status (open/reviewing/closed) |
| `User` / `Org` / `ApiKey` | auth, roles, API usage |
| `AuditLog` | userId, action, target, timestamp |

## 7. API surface (all under `/api`)

| Method | Path | Phase |
|---|---|---|
| GET | `/address/:addr` | 1 |
| GET | `/tx/:chain/:hash` | 1 |
| GET | `/graph/:addr?depth&fanout&from&to&min` | 1 |
| GET | `/path?from&to&maxHops` | 1 |
| GET | `/risk/:addr` | 2 |
| POST | `/screen` (bulk, JSON or CSV) | 2 |
| GET/POST/DELETE | `/labels` | 2 |
| CRUD | `/watchlists`, `/rules`, `/alerts` | 3 |
| CRUD | `/cases`, `/cases/:id/notes`, `/cases/:id/files` | 4 |
| GET | `/cases/:id/report.pdf`, `/address/:addr/report.csv` | 4 |
| POST | `/auth/login`, CRUD `/api-keys` | 6 |
| GET | `/v1/screen/:addr` (public, API-key) | 6 |

## 8. Frontend pages

| Page | Phase |
|---|---|
| Search (home) | 1 |
| Address detail | 1 |
| Transaction detail | 1 |
| Graph workspace | 1 |
| Bulk screening | 2 |
| Labels admin | 2 |
| Watchlists / Alerts inbox | 3 |
| Cases list / Case detail + timeline | 4 |
| Login / Settings / API keys | 6 |

## 9. Phases

| # | Phase | Outcome | Estimate |
|---|---|---|---|
| 0 | Foundation | Both apps run, chain adapters work | 2 days |
| 1 | Investigations (Reactor) | Look up + trace any USDT wallet | 1 week |
| 2 | Screening & risk | Sanctions, labels, risk scores, bulk screen | 1 week |
| 3 | Monitoring (KYT) | Watchlists, rules, alerts, webhooks | 1 week |
| 4 | Cases & reports (Storyline) | Saved investigations, PDF evidence reports | 1 week |
| 5 | Attribution engine | Label imports, exchange deposit clustering | ongoing |
| 6 | Platform | Auth, roles, API keys, deployment | 1 week |
| 7 | Scale | Own indexer, cross-chain, more tokens | later |

**Milestone A (end of Phase 2):** usable investigate + screen tool.
**Milestone B (end of Phase 4):** full investigator workflow with evidence export.

## 10. Rules of the road (so we don't run amok)

1. **One phase at a time.** Don't start a phase until the previous one's acceptance checks in task.md pass.
2. **task.md is the source of truth** for what's next. Update its checkboxes as work lands.
3. **No new dependency** without a reason written in the task.
4. **Every risk score shows its reasons.** No black-box numbers — this goes in front of police and courts.
5. **Never fabricate labels.** Every label has a `source`. No guessed exchange/scam addresses.
6. **Secrets only in `.env`**, never committed. `.env.example` lists every key.
7. **Respect free-tier rate limits** — all chain calls go through the cached, throttled fetcher in `chains.ts`.
8. Each phase leaves at least one runnable check (`npm run check`) covering its core logic.

## 11. Open decisions

| # | Question | Default if undecided |
|---|---|---|
| D1 | Data budget: free APIs, or paid TronGrid Pro / Etherscan Pro / own node? | Free tier |
| D2 | Users: just us, or SaaS for outside customers? | Internal team |
| D3 | Hosting: local, VPS, or cloud? | Local + Docker |
| D4 | Order: Phases 0–2 first, then 3–4? | Yes |
