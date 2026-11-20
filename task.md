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

## Phase 7 — Scale

Plan written 2026-11-20. Default for D1 (data budget) = **free tier**, so the index is *targeted* (the wallets we care about), with full-chain tailing as an opt-in switch for when a paid key / own node exists. Order: 7A → 7B → 7C, one at a time, each verified before the next.

### 7A — Own transfer index (7.1 + 7.2)
- [x] **7.1 `Transfer` table** — chain, asset, hash, seq, from, to, amount (numeric), ts, block. Unique (chain, asset, hash, from, to, amount, seq) — TronGrid's per-account list has no log index, so `seq` = ordinal of identical rows in one tx. Indexes (chain, from, ts) and (chain, to, ts). Plain table, not partitioned: fine to ~100 M rows; monthly partitions when the full-chain tailer is turned on for real. *Built:* `amount` is `numeric(80,6)` (TRC20 USDT has emitted uint256-sized garbage values that overflow `numeric(38,6)`); extra index `(chain, ts)` is not used yet (reserved for time-range scans / partitioning).
- [x] **7.2 `IndexedAddress` coverage** — per wallet: status (pending/backfilling/complete/capped/error), oldest/newest ts, row count, last sync, reason (lookup/watch/case/graph). Backfill job pages the whole history up to `INDEX_MAX_PER_ADDRESS` (default 50 000; above that the wallet is `capped` — exchanges have millions). *Built:* the backfill queue is the status column itself (`pending` → `backfilling` claimed with `FOR UPDATE SKIP LOCKED`, 2 workers, run from `jobs.every`) instead of the generic `Job` table, because the index is global and `Job` is per-org; crash recovery resets `backfilling` to `pending`. Reason `graph` = neighbour nodes: rows are written through but no backfill is queued.
- [x] **7.3 Read-through** — `getTransfers()` is the single choke point: covered + fresh → Postgres; covered + stale → fetch only *newer* rows then Postgres; not covered → API as today, write the page through, queue a backfill. Graph, path, risk, monitoring, cases and attribution all switch over with no other change. *Verified on Tron; the Ethereum path (`startblock`/`endblock` paging) is code-complete but untested without `ETHERSCAN_API_KEY`.*
- [x] **7.4 Lifetime numbers** — address page shows true lifetime in/out/counterparties from SQL when coverage is complete, and says "first N transfers (live API)" when not.
- [x] **7.5 Monitoring on the index** — poller does an incremental sync instead of re-fetching 200 rows.
- [~] **7.6 Full-chain tailer (opt-in)** — `INDEX_TAIL=tron,eth`: Tron via TronGrid contract events, Ethereum via `ETH_RPC_URL` `eth_getLogs`. Cursor table, lag + rows/min metrics. When on, watched wallets alert from the tailer (near real-time). Off by default: free TronGrid cannot keep up with ~2–3 M USDT transfers/day and the UI must say so. *Tron tailer run live for ~6 min (see Status); the Ethereum tailer (`eth_getLogs`) is code-complete but NOT run (no `ETH_RPC_URL`).*
- [x] **7.7 Data index admin page** — totals, coverage table (search, re-sync, backfill, remove), tailer status/lag. New permission `index.manage` (Owner, Admin).
- [x] **7.8 Checks** — self-check: dedupe/seq, read-through decisions, incremental sync; Playwright spec for the admin page. Acceptance: after one backfill, a depth-2 graph on that wallet loads with zero TronGrid calls; index survives a restart; a watchlist alert still fires.

**Status (7A, 2026-11-20):** built and verified on live Tron data; Ethereum code paths untested. Measurements (wallet `TWVNcs5uDiPAivNNmiPyQ2HsaBpLR6v6rK`, dormant frozen wallet, 7,131 transfers): full backfill ≈ 40–65 s (36 pages at free-TronGrid pace), `IndexedAddress` complete with `rowCount = 7131` = API row count; survives a backend restart; depth-2 graph: root read from Postgres (0 TronGrid calls mentioning the root; neighbours still hit the API: 8 wallets, ~19–20 HTTP attempts incl. 429 retries) — cold run 34 s (one cold run returned 502 from TronGrid 429s after the 4 back-offs, the pre-existing free-tier limit), 3.7 s once neighbours are in the Redis cache. Incremental sync = 1 call with `min_timestamp`. Watchlist alert fires through the index (3 alerts via sync-then-db). Tron tailer: ≈1.9 k rows/min (≈2.7 M/day), lag ≈ 2 min (the confirmation floor), kept up on free TronGrid for ~6 min. Tailer is OFF by default. Neighbour (graph) wallets are *not* backfilled automatically — that would queue ~70 backfills per depth-2 graph.

### 7B — More assets and chains (7.4 in the old list)
- [x] **7.9 Asset registry** — `backend/src/assets.ts`: {chain, asset, contract, decimals, issuer}. All six contracts verified live on 2026-11-20 (Tron via TronGrid `triggerconstantcontract`, Ethereum/BSC via public RPC `eth_call`): Tron USDT/USDC `USDT`/`USDC` 6, Ethereum USDT/USDC 6, BSC USDT/USDC 18 (BSC symbols `USDT`/`USDC`) — all agree with the brief. `asset` flows through address, report.csv, graph, path, risk, `/v1/screen`, bulk screening, monitoring rules, alerts, cases timeline and the `Transfer` table. Decimals parsed with BigInt (`parseUnits`).
- [~] **7.10 BSC** — `chain` parameter everywhere (default Ethereum, `bsc` explicit, shape mismatch = 400); chain selector (shown only for 0x input) on dashboard search, address, graph, screening, watchlist add, case add, index admin, tx page; cases remember the chain per address and saved graphs carry theirs. *Partial:* the BSC/Ethereum data paths are code-complete + unit-checked but **not live-tested** (no `ETHERSCAN_API_KEY`); the top-bar quick search always opens 0x input as Ethereum (switch on the page).
- [x] **7.11 Freeze/blacklist per asset** — Tether `isBlackListed` (Tron, Ethereum) and Circle `isBlacklisted(address)` selector `0xfe575a87` (Tron USDC confirmed through TronGrid, Ethereum USDC contract answers the call) as live checks; Circle `Blacklisted`/`UnBlacklisted` events synced into `source=circle` labels (Tron live, 30-min job + `POST /labels/sync {source:'circle'}`; Ethereum code-complete, needs the key). BSC: `null` = "not applicable" in API and UI. Topics/selectors were produced with a one-off keccak256 implementation that reproduced the already-live Tether constants; the Circle ones were checked against TronGrid's event-name / function-selector lookups.
- [~] **7.12 UI** — asset chips (All/USDT/USDC) on address, graph, alerts (monitoring) and the screening form (screening *results* show the asset the job used: rows are per wallet, not per asset, so there is nothing to filter); rule form has an asset selector; edges coloured by asset (auto when non-USDT edges are present, legend entry), per-asset balances + freeze table, "historical only" for Tron USDC, USD-equivalent wording. *Partial:* Ethereum/BNB Chain views were only checked for the UI flow and the "key missing" message, not with data.
- [x] **7.12a 7A follow-up** — failed backfills retry automatically (1/2/4/8/16 min, `retries`/`retryAt` columns); wallets that failed before this existed are re-queued once at the next poll.

**Status (7B, 2026-11-20):** Tron built and verified live; Ethereum / BNB Chain **code-complete, unit-checked, not live-tested** (no `ETHERSCAN_API_KEY`; Etherscan's free tier may not cover BNB Chain). Evidence: `npm run check` green (registry decimals incl. 18-decimal BigInt parsing, 0x chain resolution, Circle/Tether event parsing on crafted logs, asset filtering, per-asset graph edges, per-asset rules, coverage-per-asset, retry back-off); frontend build green; Playwright 19 specs pass (15 old + 4 new in `e2e/assets.spec.ts`; they passed across two runs, not one clean run: three specs timed out in the first run while 3 huge wallet backfills (37-54 k rows) saturated free TronGrid and the Next dev proxy cut a >30 s request; they passed when rerun). Live acceptance on Tron wallet `TE6JpQerB4JsHzVHk4isufZi5oHwX2t9Le` (49 USDC + ~200+ USDT transfers): address page `asset=usdt|usdc|all` give separate/combined history (`byAsset`, per-asset table), graph shows USDT and USDC edges together (fanout 15: 19 USDT + 4 USDC edges; ids `a>b` and `a>b:usdc`). Circle sync on Tron: 1,846 Blacklisted/UnBlacklisted events -> 563 `source=circle` labels; four sampled labels confirmed by live `isBlacklisted`. Existing USDT pages: cold wallets 2.0-3.9 s with `asset=usdt` and 2.0-2.9 s with `all` in the quiet sample (one `all` request 502 from TronGrid 429 under contention); under heavy backfill load the same pages took 14-30 s. Backfill retry: pre-existing 7A `error` wallets were re-queued automatically; one went 1 -> complete after a retry, two kept hitting 429 and stopped after 5 retries. Known limits: `all` doubles TronGrid calls per wallet (USDT + USDC); the retry restarts a backfill from the newest page (ponytail); Circle ended Tron USDC support in 2024 yet transfers were still seen on 2026-11-20.

**Fix on review (2026-11-20):** the uint256-max "transfers" were token *Approval* events — TronGrid's per-account TRC20 list mixes them in, and they had been stored as transfers since Phase 1 (fake volume and fake counterparties in graphs/risk). `chains.ts` now keeps only `type === 'Transfer'`; the test-only index (218,724 rows, 32 wallets) was truncated so it rebuilds clean; labels untouched. Tron USDC note reworded to "issuer support ended" (tokens still move).
- Solana: **not in this phase** — different address/account model (SPL token accounts) and needs a Solana RPC; parked in Backlog.

### 7C — Cross-chain
- [x] **7.13 Categories** `bridge` and `dex` (weight 0, informational, like exchange). *Built:* both are in `WEIGHTS`/`CATEGORIES` (so label create, CSV import, filters and the graph legend/colours/icon know them). Two seeds taken from vendor pages fetched in-session, stored with the page as `Label.sourceUrl` and the new `source = official` (one nullable column, migration `20261120180000_label_source_url`): **SunSwap Universal Router** `TSJEtPuqHpvSaVnSwvCsngaeBxrGUzp95Q` (dex; https://sunio.zendesk.com/hc/en-us/articles/54899665032601, the SUN.io help centre page that lists it) and **Allbridge Core USDT OFT interface** `TWPziSAroSacAjDuL52ByQzU86s9mP2gPr` (bridge; https://docs-core.allbridge.io/llms-full.txt, "OFT Interface Contracts" table). Both answered TronGrid `/wallet/getcontract` with a deployed contract. Permit2 (on the same SUN.io page) is not seeded: it is an approval helper, not a swap venue. No Ethereum/BNB Chain seeds (nothing fetched/verified for them; no Etherscan key to confirm they are contracts). UI: labels page shows "source page" links and an `official` source filter; the add-label dialog has a chain choice for 0x; CSV takes an optional 5th `chain` column (`bsc`).
- [x] **7.14 Swap detection** — `swap.ts` (pure): a wallet's *net* stablecoin outflow in one tx plus, in the same tx, its net native inflow (internal call value) or a payment to a `dex`-labelled wallet; also stablecoin received from a `dex`. Tx page "Swap detected" card with summary + evidence; `GET /address/:addr/swaps` (bounded, paged, cached) feeds a "Check for swaps" node action that puts a terminal marker on the graph node ("left USDT here → TRX", orange double ring, kept in saved graphs). Bound: one tx lookup per outgoing tx, 4 per request, 2 requests per click (8 newest outgoing txs), tx detail cached 24 h; it says "checked N of M". Limits: internal-call TRX/ETH/BNB only (a swap ending in a wrapped token with no native payout is missed); native-to-stablecoin swaps are detected only when the stablecoin side comes from a labelled dex.
- [~] **7.15 Bridge hop finder** — `bridge-hop.ts` (pure ranking) + `GET /crosschain/hops` (window/tolerance params, defaults 60 min / 1 %, evidence and confidence per candidate, never auto-asserted; `sides` reports "no bridge labels" / fetch errors). Time-windowed reads added to `chains.ts` (`windowTransfers`: Tron min/max_timestamp, verified live; EVM getblocknobytime + startblock/endblock). *Partial:* no candidate has been produced from real two-sided data: only one bridge wallet (Tron) is seeded and the other chains have no bridge labels, and the Ethereum/BNB side needs `ETHERSCAN_API_KEY` (code-complete, unit-checked, not live-tested).
- [~] **7.16 Multi-chain graph** — node ids carry the chain as `chain:address` for any chain other than the graph's own (bare ids stay valid, so old saved graphs load unchanged); dashed "cross-chain (heuristic)" edges with an evidence panel; "Find cross-chain continuation" on bridge nodes (modal with deposit picker, window, tolerance, target chain, candidates with reasons); "Add to graph" and "Save to case" (`cases.manage`; case address with its chain, role intermediary, evidence in the note). Expanding a foreign-chain node calls the graph API with that chain. *Partial:* the candidate in the e2e/acceptance run is crafted (mocked API response); expanding a real Ethereum/BNB node is not live-tested (no key). Case timelines ignore prefixed ids.
- [x] **7.17 Checks** — `npm run check`: swap detection on a crafted `gettransactioninfobyid` (shape of the real tx; rejected/no-value internal calls ignored, pass-through router, dex paths, failed tx) and bridge matching/ranking (window, tolerance, overshoot, same chain, protocol, crowding, asset change). Playwright `e2e/crosschain.spec.ts` (3 specs): tx page swap card on the real tx, graph bridge action + real hop search + crafted candidate saved to a case and accepted into a graph that is saved (checks `eth:` ids and `xchain` in the stored graph), labels page seeds.

**Status (7C, 2026-11-20):** Tron built and verified live; Ethereum / BNB Chain parts code-complete and unit-checked only (no `ETHERSCAN_API_KEY`). Live acceptance: Tron tx `987c9423…` (SunSwap Universal Router): wallet sold 23 USDT and received 73.99327 TRX in the same tx; detected by `GET /tx/tron/:hash` and shown on the tx page; `GET /address/:addr/swaps` found 8 such swaps for that wallet (up to ~60 s for 5 uncached tx lookups while 2 big backfills shared the free TronGrid budget, hence the chunked UI). Hop finder on real Tron deposit `d99920ed…` into the seeded Allbridge wallet: ~10 s, both other chains report `no_bridge_labels`, 0 candidates (honest: nothing to search without labels / Etherscan key). Candidate ranking + save to case + saved multi-chain graph were exercised with a **crafted** candidate. Playwright: 22 specs, all passing but across several runs (first run: 4 failures from TronGrid saturation by the backfills the older specs queue, a stale 7B assertion in assets.spec.ts fixed to match the reworded note, and a users table that outgrew its first page after 26 leftover e2e users, which were deleted). No new dependencies.

**Phase acceptance:** see each block. Ethereum/BSC parts are code-complete but only live-tested once `ETHERSCAN_API_KEY` is set.

---

## Phase 8 — Case transactions, statement import, case analysis

Asked 2026-11-20 after reviewing a real Binance withdrawal export: 87 rows, 55 with on-chain hashes, 32 "Off-chain transfer", 17 destination wallets. Real exports are personal financial data: never commit them (`*.xlsx`, `*.xls` and `/evidence/` are gitignored). Tests use synthetic fixtures only.

### 8A — Transactions in cases + statement import
- [x] **8.1 `CaseTransaction`** — caseId, chain, hash (null for off-chain rows), claimed fields from the statement (time, coin, network, amount, fee, address, exchange ref, raw row JSON), source (manual / import + file id), and verification: status (pending / verified / mismatch / not_found / off_chain / error), on-chain from/to/amount/asset/ts, mismatch reasons. Unique (caseId, chain, hash) for on-chain rows. *Built:* model `CaseTransaction` (migration `20261120200000_case_transactions`, one new table, additive); `chain` is null only when a statement's network is unknown (such rows are skipped, not stored); `fileId` points at the stored statement (`SetNull` if the file is deleted).
- [x] **8.2 Add by paste** — paste hashes one per line (Tron 64-hex, 0x… for Ethereum, with a chain choice), de-duplicated, each verified. *Built:* `POST /cases/:id/transactions`; junk and duplicate hashes are reported back, not an error.
- [~] **8.3 Import Excel/CSV** — upload .xlsx/.xls/.csv (size + row caps); built-in detectors for Binance withdrawal and deposit history; generic column mapping (hash, address, amount, time, coin, network) for anything else; preview with per-row problems, then confirm. The original file is stored as a case file (evidence). New dependency: ExcelJS, to read .xlsx. *Built:* `statements.ts` (pure) + `case-tx.ts`; preview (stores nothing) then import (same upload again); 5 MB / 5,000 rows / zip-bomb guard; formulas reduced to values. *Partial:* **`.xls` is refused** (ExcelJS reads `.xlsx` only), user must save as `.xlsx`/`.csv`; the Binance deposit-history detector is built from the expected header shape, **no real deposit export was seen**; CSV row numbers count non-blank rows. ExcelJS 4.4.0 (written reason: the only maintained pure-JS .xlsx reader/writer, also used by the check and the e2e to build synthetic files).
- [x] **8.4 Verification job** — background, throttled: fetch the tx and match the claimed address, amount (fee-aware), coin and time (timezone given on import). Network → chain mapping (TRX/TRC20→tron, ETH/ERC20→eth, BSC/BEP20→bsc). Off-chain rows are kept as records with the "request records from the exchange" note. *Built:* job type `verify-tx` (`jobs.ts`), one `getTx` per row through the throttled/cached fetcher, rows updated as they finish (the UI polls the summary). Tron verified live; Ethereum/BNB Chain are code-complete: with no Etherscan key (local) or BNB Chain on the free plan the row gets status `error` with the upstream message, never a crash (the missing-key path was exercised locally, the paid-plan refusal was not).
- [x] **8.5 Case wallets from statements** — destination/source wallets added as case addresses (role chosen at import, e.g. recipient), with the note linking back to the import. *Built:* import option `walletRole` (the existing case roles; there is no `recipient` role, so `other`/`intermediary`/… is chosen); only on-chain rows, deduplicated, existing case wallets kept as they are.
- [x] **8.6 UI** — Transactions tab on the case: status chips, filters, totals (claimed vs verified), mismatch details, links to tx/address pages, re-verify, delete; import wizard. RBAC: cases.view to see, cases.manage to add/import. *Built:* `components/CaseTransactions.tsx` (tab + paste dialog + 3-step wizard: upload -> detected format / column mapping / timezone / tolerance / wallet role -> import -> progress on the tab), CSV button (`export.data`), a Transactions section in the printable report. Checked in dark at desktop and at 390 px width (no horizontal page scroll); the light theme uses the shared tokens and was not separately screenshotted for this tab.
- [x] **8.7 Checks** — self-check: Binance detector + parsers on synthetic rows, network mapping, matching rules (fee, decimals, timezone); Playwright: paste + import flow with a synthetic file. *Built:* ~45 new asserts in `selfcheck.ts` (detector for withdrawal/deposit/generic, timezone parse, network mapping, row problems, off-chain classification, fee/tolerance/multi-transfer/time/coin matching, a real xlsx round trip with formula cells); `e2e/transactions.spec.ts` (3 specs: paste, synthetic xlsx import through the wizard to verified/mismatch/off-chain + wallets + stored file + mobile + report, CSV mapping and upload guards).

**Status (8A, 2026-11-20):** built; Tron verified live. Live acceptance on the real Binance export (kept local, never committed): detected `binance_withdrawal`, sheet "Withdrawals", tz UTC+5 from the header; 87 rows = 55 on-chain + 32 off-chain, 0 row problems; claimed total 838,319.77 USDT (equals the file's own Summary sheet). Verification of the 55 on-chain rows took 79 s (job record, free TronGrid + key): **55 verified, 0 mismatch / not_found / error**; verified 492,542.07, off-chain 345,777.70 (not verifiable on-chain). 10 distinct on-chain destination wallets (17 including off-chain rows). The temporary case and its stored file were deleted afterwards. Mismatch, fee-gross, time and BNB Chain `error` paths were exercised live with a synthetic CSV on public txs. Playwright: new spec 3/3 passing alone; in the full 25-spec run 5 specs failed on live-network flakiness (TronGrid 429 / `fetch failed` in the backend log; 3 of them, plus the new report assertion, are Tron-data-bound pages; `assets.spec` "address page" still fails on its live-data assertion when run alone: the address page is untouched by 8A, cause not investigated) and 7 serial specs did not run after the first failure in `features.spec`. Not verified: Ethereum / BNB Chain verification with a key, a real Binance deposit export, `.xls`.

### 8B — Case analysis
- [ ] **8.8 Analysis job** — per case, background with progress; results stored (`CaseAnalysis`, versioned by run) so reports don't recompute.
- [ ] **8.9 Counterparty wallets** — per wallet: total, count, first/last, current balance, risk score + reasons, labels; share of total.
- [ ] **8.10 Follow the money** — from each counterparty wallet trace N hops (default 2, fan-out capped): exposure to sanctioned/frozen/scam, and **where funds ended at exchanges** (labelled wallets + deposit-address clustering), with the path shown as evidence.
- [ ] **8.11 Patterns** — repeated identical amounts, amounts just under round thresholds, consolidation (many → one), pass-through wallets (in and out within a short time), unusual hours. Each finding shows its evidence rows; nothing without reasons (rule 4).
- [ ] **8.12 UI + report** — Analysis tab (summary cards, wallets table, findings, timeline, hour/day heatmap, amounts over time, case link chart) and a section in the printable case report.
- [ ] **8.13 Checks** — self-check for pattern rules on crafted data; Playwright for running an analysis and seeing results.

---

## Backlog (ideas parked here, not in scope yet)

- Auto-detect other exchange exports (OKX, Bybit, KuCoin) once samples are available.
- Solana (SPL USDT/USDC) — needs Solana RPC and token-account model.
- Native-coin tracing after a swap (follow TRX/ETH onward).
-

## Open decisions (see plan.md §11)

- [ ] D1 data budget · [ ] D2 users · [ ] D3 hosting · [ ] D4 phase order

## Status 2026-11-20 — staging (https://analysis.publicvm.com)
Deployed with PM2 + Apache (`deploy/DEPLOY-pm2-apache.md`). **Ethereum was live-tested for the first time on staging, with keys set:**
- USDT and USDC transfers, balances, tx detail and live `isBlackListed` all work.
- Freeze/sanctions syncs on Ethereum: Tether 1,516 events → 1,086 frozen labels; Circle 1,192 events → 712 labels; OFAC 127.
- **BNB Chain:** Etherscan's free plan refuses `chainid=56` ("Free API access is not supported for this chain"), so BNB Chain needs a paid Etherscan plan or another data source.
