# Tasks

Working checklist for [plan.md](plan.md). Rules:

- Work **top to bottom**. Don't skip ahead to a later phase.
- Tick `[x]` only when the task's **Done when** is actually true.
- A phase is finished only when its **Phase acceptance** checks pass.
- New idea mid-phase? Add it to **Backlog** at the bottom; don't build it now.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Foundation

- [x] **0.1 Backend config files**
  `backend/package.json`, `tsconfig.json`, `nest-cli.json`, `.env.example`, root `.gitignore`.
- [x] **0.2 Chain adapters** — `backend/src/chains.ts`
  TRC20 + ERC20: transfers, balance, Tether freeze check, address detection, counterparty aggregation, cached + throttled fetch.
- [x] **0.3 Nest bootstrap** — `main.ts`, `app.module.ts`, `/api` prefix, `.env` loading, port 4000, global error handling.
  Done when: `npm run dev` starts and `GET /api/health` returns `{ ok: true }`.
- [x] **0.4 Frontend scaffold** — Next.js app, layout, base CSS, `/api/*` rewrite to `localhost:4000`.
  Done when: `npm run dev` serves the home page on :3000 and `/api/health` proxies through.
- [x] **0.5 Self-check** — `backend/src/selfcheck.ts`, `npm run check`.
  Covers: `detectChain`, `tronToHex20` (USDT contract → `a614f803b6fd780986a42c78ec9c7f77e6ded13c`), `flows`.
- [x] **0.6 Root README** — prerequisites, `.env` keys, how to run both apps.
- [x] **0.7 Git** — `git init`, first commit.

**Phase acceptance:** both apps start; self-check passes; a real Tron address returns transfers from `chains.ts`.

✅ Passed 2026-11-19: health + proxy OK; selfcheck passes; real Tron wallet returned 300 transfers (pagination), balance, counterparties; freeze check `true` on 3 wallets from Tether `AddedBlackList` events, `false` on a clean one.
⚠️ ERC20 path not yet tested live — needs `ETHERSCAN_API_KEY` in `backend/.env`.

---

## Phase 1 — Investigations (Reactor equivalent)

### Backend
- [x] **1.1 Address endpoint** — `GET /api/address/:addr?limit=`
  Returns chain, balance, total in/out, tx count, first/last seen, top counterparties, transfers.
  Validates address (400 on bad input), clamps `limit` ≤ 2000.
- [x] **1.2 Transaction endpoint** — `GET /api/tx/:chain/:hash`
  From, to, amount, timestamp, block, explorer link.
- [x] **1.3 Graph endpoint** — `GET /api/graph/:addr?depth=1&fanout=8&from=&to=&min=`
  BFS: top `fanout` counterparties by volume per node, `depth` ≤ 3, `fanout` ≤ 15.
  Optional date range and minimum amount filters. Returns `{ nodes, edges }`; edges aggregated `from→to` with amount + count.
- [x] **1.4 Path finding** — `GET /api/path?from=&to=&maxHops=4`
  Bidirectional BFS over counterparties; returns the shortest path(s) found or "not found within N hops".

### Frontend
- [x] **1.5 Search page** — one input, detects chain, routes to `/address/[addr]`; shows an error for invalid addresses.
- [x] **1.6 Address page** — summary cards, top counterparties table, transfers table (paged), explorer links.
- [x] **1.7 Graph workspace** — Cytoscape: click to expand a node, edge thickness = volume, node colour = category, side panel with node details, filter controls (date, min amount), re-layout button.
- [x] **1.8 Transaction page** — details + links to both addresses.
- [x] **1.9 Path finder UI** — two inputs, draws the resulting path on the graph.

**Phase acceptance:**
- Look up 1 real Tron and 1 real Ethereum USDT wallet; numbers match TronScan / Etherscan for the fetched window.
- Expand a graph 2 hops without hitting rate-limit errors.
- Path finder finds a known 2-hop path.

Status 2026-11-19:
- ✅ Tron: address, tx, graph (depth 2 = 24 nodes in 6.6 s, no rate-limit errors), path finder found a real 2-hop path in 1.4 s. Pages render with live data (checked by headless-browser screenshots).
- ✅ Backend selfcheck covers graph BFS, fanout, directed path search, hop limit, expansion cap.
- ⏳ Ethereum: not tested — needs `ETHERSCAN_API_KEY` in `backend/.env`.
- ⏳ Manual spot-check of numbers against TronScan / Etherscan by a person.
- ⏳ Path finder UI clicked through by a person (API verified, UI only rendered).

---

## Phase 2 — Screening & risk

### Infrastructure
- [x] **2.1 Infra** — local Postgres 17 + Redis (Docker not installed on dev machine; compose file written in 6.5, untested).
- [x] **2.2 Prisma** — full schema + migrations. `Transfer` table deliberately skipped: chain data is cached in Redis; a stored transfer index is Phase 7.1.

### Labels & sanctions
- [x] **2.3 OFAC import** — download USDT/TRX/ETH sanctioned-address lists (0xB10C repo, sourced from OFAC SDN), upsert as `source=ofac`; daily refresh job.
- [x] **2.4 Tether freeze check** — live per-address check (already in `chains.ts`), plus cache result 1 h.
- [x] **2.5 Tether freeze event import** — index `AddedBlackList` / `RemovedBlackList` events on both chains → `source=tether` labels (so graph nodes show frozen status without a call each).
- [x] **2.6 Labels API** — `GET/POST/DELETE /api/labels`; validate category against the fixed list in plan.md §5.
- [x] **2.7 Labels CSV import** — upload `address,chain,name,category,source`; preview → confirm.

### Risk
- [x] **2.8 Risk service** — implements plan.md §5 exactly (own, direct, indirect, levels, reasons).
- [x] **2.9 Risk endpoint** — `GET /api/risk/:addr`; risk also included in `/address` response and graph node data.
- [x] **2.10 Bulk screening** — `POST /api/screen` (JSON list or CSV, ≤ 1000 addresses) → BullMQ job → downloadable CSV result.
- [x] **2.11 Self-check** — risk scoring cases: clean wallet = 0; sanctioned = 100; 10 % volume with a scam wallet = 9.

### Frontend
- [x] **2.12 Risk badge + reasons** on address page and graph side panel.
- [x] **2.13 Bulk screening page** — upload, progress, download results.
- [x] **2.14 Labels admin page** — list, search, add, delete, import CSV.

**Phase acceptance:** a known OFAC-listed address shows Severe/100 with an "OFAC SDN" reason; a wallet that traded with it shows non-zero exposure; bulk screen of 100 addresses completes and downloads.

✅ **Milestone A reached.**

---

## Phase 3 — Monitoring (KYT equivalent)

- [x] **3.1 Prisma** — `Watchlist`, `WatchItem`, `Rule`, `Alert`.
- [x] **3.2 Watchlists API + page** — create lists, add/remove addresses (single or CSV).
- [x] **3.3 Rules API + page** — `amount_over`, `flagged_counterparty` (min risk level), `volume_spike` (× average).
- [x] **3.4 Poller job** — every N minutes per watched address: fetch transfers newer than `lastSeenTxTs`, evaluate rules, create alerts. Respect rate limits; stagger addresses.
- [x] **3.5 Alerts inbox** — list, filter, status changes (open → reviewing → closed), link to graph.
- [x] **3.6 Notifications** — email (SMTP) and webhook (POST JSON, HMAC-signed) on new alerts.
- [x] **3.7 Self-check** — each rule type fires on a crafted transfer and stays silent on a clean one.

**Phase acceptance:** add a busy Tron wallet to a watchlist with `amount_over=1000`; an alert appears within one poll cycle and a webhook is received.

---

## Phase 4 — Cases & reports (Storyline equivalent)

- [x] **4.1 Prisma** — `Case`, `CaseAddress`, `CaseNote`, `CaseFile`, `AuditLog`.
- [x] **4.2 Cases API + pages** — create, list, status, assign roles to addresses, notes, file uploads.
- [x] **4.3 Save graph to case** — store Cytoscape JSON; reopen restores the same view.
- [x] **4.4 Timeline (Storyline) view** — case transfers ordered by time, grouped by hop, readable by non-experts.
- [x] **4.5 PDF report** — case summary, addresses + roles + risk, graph image, key transfers with tx hashes and explorer links, timestamp and "data source" footer.
- [x] **4.6 CSV exports** — transfers per address / per case.
- [x] **4.7 Graph PNG export.**
- [x] **4.8 Audit log** — record create/update/export actions.

**Phase acceptance:** build a case from a real trace, close the browser, reopen it identical, export a PDF that someone outside the team can follow.

✅ **Milestone B reached.**

---

## Phase 5 — Attribution engine (ongoing)

- [~] **5.1 Public label imports** (CSV import + import-from-URL built and tested; no third-party exchange/scam lists bundled — choose trusted sources) — curated exchange hot wallets, community scam lists; each with `source` and `confidence`.
- [x] **5.2 Deposit-address clustering** — wallet that forwards most inflows to one labelled exchange hot wallet → suggested label `<Exchange> deposit` (`source=cluster`).
- [x] **5.3 Suggestion review queue** — analyst accepts/rejects cluster suggestions.
- [x] **5.4 Label propagation** — accepted cluster labels apply to the graph and risk scores.

---

## Phase 6 — Platform

- [x] **6.1 Auth** — login, sessions, password hashing.
- [x] **6.2 Orgs + roles** — admin / analyst / viewer; data scoped by org.
- [x] **6.3 API keys** — create/revoke, per-key rate limits, usage counts.
- [x] **6.4 Public screening API** — `GET /api/v1/screen/:addr` with API key.
- [~] **6.5 Deployment** (files written: Dockerfiles, docker-compose.yml, Caddyfile, scripts/backup.sh — NOT built or run, Docker unavailable) — Dockerfiles, production compose, HTTPS, DB backups.

---

## Status 2026-11-20 (Phases 2–6)

Verified on live Tron data unless noted. Full Playwright suite: 14/14 passing (screens dark/light/mobile, flows, rbac, features).

- ✅ Screening & risk: OFAC (478) + Tether freeze sync (8,287 frozen Tron wallets), risk scoring with reasons, 100-address bulk screen (5 min, 0 errors).
- ✅ Monitoring: watchlists, 3 rule types, alerts inbox, webhook (HMAC verified) + email (Mailpit verified).
- ✅ Cases: addresses/roles, notes, files, saved graph, timeline, printable report, CSV.
- ✅ Attribution: deposit-address clustering + review queue; label CSV / URL import.
- ✅ Platform: permission-based RBAC (20 permissions, system + custom roles), TOTP 2FA + recovery codes, sessions, org policies, API keys + public `/v1/screen`, filtered audit log, CSRF/headers hardening, Redis cache + rate limits.
- ✅ UI: enterprise shell, dark/light, permission-aware, i2-style link graph, radial activity heatmap.
- ⏳ Ethereum (ERC20): untested everywhere — needs `ETHERSCAN_API_KEY`.
- ⏳ Deployment files never run (no Docker here).
- ⏳ Speed: cold graph depth 2 on busy wallets 18–32 s — free TronGrid is the bottleneck; add `TRONGRID_API_KEY`.
- Deferred (see docs/api.md): global label sync/import is visible to all orgs (fine single-tenant); no CSP header; set `APP_SECRET` in production to encrypt 2FA secrets.

---

## Phase 7 — Scale (later)

- [ ] **7.1 USDT indexer** — stream all TRC20/ERC20 USDT transfers into Postgres (partitioned by month).
- [ ] **7.2 Switch graph/path/monitoring** to read from the index.
- [ ] **7.3 Cross-chain** — bridges, USDT↔TRX/ETH swaps.
- [ ] **7.4 More assets/chains** — USDC, BSC, Solana.

---

## Backlog (ideas parked here, not in scope yet)

-

## Open decisions (see plan.md §11)

- [ ] D1 data budget · [ ] D2 users · [ ] D3 hosting · [ ] D4 phase order
