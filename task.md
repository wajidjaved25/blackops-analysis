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
- [ ] **1.1 Address endpoint** — `GET /api/address/:addr?limit=`
  Returns chain, balance, total in/out, tx count, first/last seen, top counterparties, transfers.
  Validates address (400 on bad input), clamps `limit` ≤ 2000.
- [ ] **1.2 Transaction endpoint** — `GET /api/tx/:chain/:hash`
  From, to, amount, timestamp, block, explorer link.
- [ ] **1.3 Graph endpoint** — `GET /api/graph/:addr?depth=1&fanout=8&from=&to=&min=`
  BFS: top `fanout` counterparties by volume per node, `depth` ≤ 3, `fanout` ≤ 15.
  Optional date range and minimum amount filters. Returns `{ nodes, edges }`; edges aggregated `from→to` with amount + count.
- [ ] **1.4 Path finding** — `GET /api/path?from=&to=&maxHops=4`
  Bidirectional BFS over counterparties; returns the shortest path(s) found or "not found within N hops".

### Frontend
- [ ] **1.5 Search page** — one input, detects chain, routes to `/address/[addr]`; shows an error for invalid addresses.
- [ ] **1.6 Address page** — summary cards, top counterparties table, transfers table (paged), explorer links.
- [ ] **1.7 Graph workspace** — Cytoscape: click to expand a node, edge thickness = volume, node colour = category, side panel with node details, filter controls (date, min amount), re-layout button.
- [ ] **1.8 Transaction page** — details + links to both addresses.
- [ ] **1.9 Path finder UI** — two inputs, draws the resulting path on the graph.

**Phase acceptance:**
- Look up 1 real Tron and 1 real Ethereum USDT wallet; numbers match TronScan / Etherscan for the fetched window.
- Expand a graph 2 hops without hitting rate-limit errors.
- Path finder finds a known 2-hop path.

---

## Phase 2 — Screening & risk

### Infrastructure
- [ ] **2.1 Docker Compose** — Postgres + Redis.
- [ ] **2.2 Prisma** — schema for `Label`, `Transfer`; first migration.

### Labels & sanctions
- [ ] **2.3 OFAC import** — download USDT/TRX/ETH sanctioned-address lists (0xB10C repo, sourced from OFAC SDN), upsert as `source=ofac`; daily refresh job.
- [ ] **2.4 Tether freeze check** — live per-address check (already in `chains.ts`), plus cache result 1 h.
- [ ] **2.5 Tether freeze event import** — index `AddedBlackList` / `RemovedBlackList` events on both chains → `source=tether` labels (so graph nodes show frozen status without a call each).
- [ ] **2.6 Labels API** — `GET/POST/DELETE /api/labels`; validate category against the fixed list in plan.md §5.
- [ ] **2.7 Labels CSV import** — upload `address,chain,name,category,source`; preview → confirm.

### Risk
- [ ] **2.8 Risk service** — implements plan.md §5 exactly (own, direct, indirect, levels, reasons).
- [ ] **2.9 Risk endpoint** — `GET /api/risk/:addr`; risk also included in `/address` response and graph node data.
- [ ] **2.10 Bulk screening** — `POST /api/screen` (JSON list or CSV, ≤ 1000 addresses) → BullMQ job → downloadable CSV result.
- [ ] **2.11 Self-check** — risk scoring cases: clean wallet = 0; sanctioned = 100; 10 % volume with a scam wallet = 9.

### Frontend
- [ ] **2.12 Risk badge + reasons** on address page and graph side panel.
- [ ] **2.13 Bulk screening page** — upload, progress, download results.
- [ ] **2.14 Labels admin page** — list, search, add, delete, import CSV.

**Phase acceptance:** a known OFAC-listed address shows Severe/100 with an "OFAC SDN" reason; a wallet that traded with it shows non-zero exposure; bulk screen of 100 addresses completes and downloads.

✅ **Milestone A reached.**

---

## Phase 3 — Monitoring (KYT equivalent)

- [ ] **3.1 Prisma** — `Watchlist`, `WatchItem`, `Rule`, `Alert`.
- [ ] **3.2 Watchlists API + page** — create lists, add/remove addresses (single or CSV).
- [ ] **3.3 Rules API + page** — `amount_over`, `flagged_counterparty` (min risk level), `volume_spike` (× average).
- [ ] **3.4 Poller job** — every N minutes per watched address: fetch transfers newer than `lastSeenTxTs`, evaluate rules, create alerts. Respect rate limits; stagger addresses.
- [ ] **3.5 Alerts inbox** — list, filter, status changes (open → reviewing → closed), link to graph.
- [ ] **3.6 Notifications** — email (SMTP) and webhook (POST JSON, HMAC-signed) on new alerts.
- [ ] **3.7 Self-check** — each rule type fires on a crafted transfer and stays silent on a clean one.

**Phase acceptance:** add a busy Tron wallet to a watchlist with `amount_over=1000`; an alert appears within one poll cycle and a webhook is received.

---

## Phase 4 — Cases & reports (Storyline equivalent)

- [ ] **4.1 Prisma** — `Case`, `CaseAddress`, `CaseNote`, `CaseFile`, `AuditLog`.
- [ ] **4.2 Cases API + pages** — create, list, status, assign roles to addresses, notes, file uploads.
- [ ] **4.3 Save graph to case** — store Cytoscape JSON; reopen restores the same view.
- [ ] **4.4 Timeline (Storyline) view** — case transfers ordered by time, grouped by hop, readable by non-experts.
- [ ] **4.5 PDF report** — case summary, addresses + roles + risk, graph image, key transfers with tx hashes and explorer links, timestamp and "data source" footer.
- [ ] **4.6 CSV exports** — transfers per address / per case.
- [ ] **4.7 Graph PNG export.**
- [ ] **4.8 Audit log** — record create/update/export actions.

**Phase acceptance:** build a case from a real trace, close the browser, reopen it identical, export a PDF that someone outside the team can follow.

✅ **Milestone B reached.**

---

## Phase 5 — Attribution engine (ongoing)

- [ ] **5.1 Public label imports** — curated exchange hot wallets, community scam lists; each with `source` and `confidence`.
- [ ] **5.2 Deposit-address clustering** — wallet that forwards most inflows to one labelled exchange hot wallet → suggested label `<Exchange> deposit` (`source=cluster`).
- [ ] **5.3 Suggestion review queue** — analyst accepts/rejects cluster suggestions.
- [ ] **5.4 Label propagation** — accepted cluster labels apply to the graph and risk scores.

---

## Phase 6 — Platform

- [ ] **6.1 Auth** — login, sessions, password hashing.
- [ ] **6.2 Orgs + roles** — admin / analyst / viewer; data scoped by org.
- [ ] **6.3 API keys** — create/revoke, per-key rate limits, usage counts.
- [ ] **6.4 Public screening API** — `GET /api/v1/screen/:addr` with API key.
- [ ] **6.5 Deployment** — Dockerfiles, production compose, HTTPS, DB backups.

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
