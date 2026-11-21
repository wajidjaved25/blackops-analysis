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
- [x] **8.8 Analysis job** — per case, background with progress; results stored (`CaseAnalysis`, versioned by run) so reports don't recompute. *Built:* table `CaseAnalysis` (migration `20261120220000_case_analysis`, additive: params, status, stage, progress, result JSON, error, per run); job type `case-analysis`; `POST /cases/:id/analyses` (one run at a time per case), `GET /cases/:id/analyses[/latest|/:aid]`; the UI and the printable report only read stored results. Per-call timeouts (60 s wallet read, 25 s risk/balance) so a saturated free API cannot stall a run.
- [x] **8.9 Counterparty wallets** — per wallet: total, count, first/last, current balance, risk score + reasons, labels; share of total. *Built:* from the statement/pasted rows (`address`, else the on-chain `to`); risk via `RiskService.assess` (not deep), balance via `getBalances`; "unavailable" shown when a lookup failed, never a made-up 0.
- [x] **8.10 Follow the money** — from each counterparty wallet trace N hops (default 2, max 3), fan-out capped (default 5/wallet, max 10), wallet cap (60 onward wallets, max 150), time budget (180 s, max 600), recipients capped at 30. Only transfers made after the funds arrived are followed. **Endpoints are terminal** and never fetched or backfilled: wallets labelled exchange/service/bridge/dex/risk, wallets whose index status is `capped`, and "high-activity" wallets (first page already holds `busyTransfers` = 200 transfers, parameter) with the reason "high-activity wallet (likely exchange/service) — not traced further". Unlabelled wallets that forward ≥ 90 % to a labelled exchange hot wallet with ≥ 3 depositors are shown as *inferred* deposit addresses (cluster.ts heuristic, said so in the text). Result says "traced X of Y wallets" and lists every bound reached. Paths are shown as evidence (wallets + first tx of each hop).
- [x] **8.11 Patterns** — pure rules in `analysis-rules.ts`: repeated identical amounts (≥ 3), amounts just under round thresholds (0.1 % below 10k/15k/50k/100k, configurable), consolidation (≥ 3 traced wallets → one), pass-through (≥ 90 % sent onward within 24 h), unusual hours (night window, time zone is a parameter, default UTC), exposure to sanctioned/frozen/high-risk wallets with the path, exchange endpoints with the "who to send legal process to" wording, high-activity endpoints (no exchange is named), internal exchange transfers (off-chain rows, never traced). Each finding has severity, a plain statement and evidence rows (max 25 shown, total kept).
- [x] **8.12 UI + report** — `components/CaseAnalysis.tsx`: Analysis tab (run form with the bounds, progress, version picker, partial-result notice, summary cards, findings with expandable evidence, endpoints, counterparty wallets with risk reasons, i2-style link chart on the shared Cytoscape style, hour/weekday heatmap, amounts over time, timeline) and an analysis section in the printable report (tables; the link chart is not printed). Run button needs `cases.manage`; reading needs `cases.view`.
- [x] **8.13 Checks** — `npm run check`: ~75 new asserts (every pattern rule on crafted data, pass-through windows, trace stops at an exchange-labelled wallet / a capped wallet / a risk-labelled wallet, no fetch for them, hop / fan-out / wallet-cap / time-budget / busy-page bounds and partial reporting, unreadable wallet reported, path extraction to the exchange endpoint, consolidation, inferred deposit address). Playwright `e2e/analysis.spec.ts` (synthetic statement, runs an analysis from the UI, checks findings/evidence/bounds/report/mobile) and a `globalTeardown` (`e2e/cleanup.ts`) that deletes leftover "E2E …" cases.

**Status (8B, 2026-11-20):** built; Tron verified live. **Live acceptance** on the real Binance export (kept local, temporary case, deleted afterwards with its stored file; its 10 pending index rows were deleted too): 87 rows (55 on-chain, 32 off-chain), claimed 838,319.77, verified 492,542.07, off-chain 345,777.70; 10 recipient wallets, defaults (2 hops, 5/wallet, 60 wallets, 180 s). Result: 20 of 22 wallets traced (10 of 10 recipients), 0 failed; run wall time 7 min 50 s (it was interrupted and re-run once by a dev-server restart; the final run's own timer says 140.8 s) with the free TronGrid shared with 3 older backfills. Findings 17: 9 pass_through, 5 repeated_amount, 1 near_threshold, 1 busy_endpoint, 1 internal_transfer (0 high, 8 medium, 7 low, 2 info). **No exchange, sanctioned or frozen endpoint was found**: the only endpoints were 9 unlabelled high-activity wallets (kind `busy`, no category); nothing was named as an exchange because none is labelled yet (8C). Bound hit: hop limit (2) only; fan-out, wallet cap and time budget were not reached. `assets.spec` "address page" diagnosed: a test bug, not an app bug (the wallet's USDC is historical; the newest USDC transfer is now #65 in a newest-first table that shows 25 rows per page, so page 1 has no USDC row): the combined-view USDC assertion now uses the Assets card, the USDC filter assertions below it were already correct. Playwright full suite: 26 specs, 22 passed first time; 3 failures were live-API saturation (older big backfills still running on the free TronGrid): attribution (cluster job took > 180 s), data index (backfill took > 120 s) and the transactions report heading; attribution (2.8 min) and transactions (3 specs) pass in isolation, `index.spec` still fails in isolation while 3 old backfills are running (timeout waiting for "complete"; code untouched by 8B); `security posture` was skipped by the serial group and passes alone. Not verified: Ethereum / BNB Chain traces (no key), an exchange-labelled endpoint on real data (no labels yet), the deposit-address inference on real data (crafted data only), the link chart in the printable report (not printed), light theme of the new tab (uses shared tokens, not screenshotted). Jobs are one queue: a long analysis delays verification jobs and vice versa.

### 8C — Automatic exchange / service labels (asked 2026-11-20)
Goal: wallets of Binance and other major exchanges are labelled automatically from public, citable sources, and tracing stops there. 8B already treats exchange/service/capped wallets as terminal.
- [ ] **8.14 Official proof-of-reserves lists** — import the wallet lists that exchanges themselves publish (e.g. Binance, OKX, Bybit, KuCoin, Bitget, HTX where available), on Tron/Ethereum/BNB Chain. `source=official`, `sourceUrl` = the exchange's page, category `exchange`, name "Binance (proof-of-reserves wallet)". Refreshed weekly. Only lists actually fetched and parsed in-session; every address format-checked.
- [ ] **8.15 Explorer tags (opt-in keys)** — Tronscan public tags (needs a free `TRONSCAN_API_KEY`) and Etherscan name tags where the plan allows. Looked up lazily for high-volume counterparties and cached. `source=tronscan|etherscan`, the tag text kept verbatim; mapped to `exchange` only when the tag names a known exchange.
- [ ] **8.16 Deposit addresses follow their exchange** — a wallet that sweeps to an officially labelled exchange hot wallet (existing clustering in cluster.ts/attribution.ts) is auto-labelled "<Exchange> deposit address" with `source=cluster` and the sweep tx as evidence, when the evidence threshold is met; weaker cases stay in the review queue.
- [ ] **8.17 Service-scale heuristic** — wallets above the index cap or with service-scale activity are shown as "likely exchange/service (heuristic)" — not named, not traced, never risk-weighted as an exchange.
- [ ] **8.18 UI + checks** — label source badges (official / explorer / cluster / heuristic) with links; Labels page filters; self-check for list parsers and the tag→category mapping.

---

## Phase 9A — TXID-first investigation, backward tracing, analysis wallets to case

Asked 2026-11-21. No schema change (analysis params and results are JSON), so no migration.
- [x] **9.1 Investigate from one transaction** — tx page button "Investigate this transaction" (`cases.manage`, `components/InvestigateTx.tsx`): dialog picks an open case or creates one, lists sender(s) (default role suspect) and receiver(s) (default intermediary) with a role selector each (first 50 addresses), then creates the case, bulk-adds the addresses, pastes the hash (8A paste/verify), waits up to ~2 min for verification (the recipient wallet is only known after it), starts an analysis with `direction: both` and opens `/cases/:id?tab=analysis` (the case page now honours `?tab=`). The global search already sends a hash to the tx page, so "Start investigation" lives there.
- [x] **9.2 Backward tracing** — `trace(..., 'backward')` in `analysis-rules.ts`; `Params.direction` forward|backward|both (API default forward, UI default both). Follows incoming transfers that arrived at or before the time the funds left the wallet, same bounds and endpoints as forward (labelled exchange/service/bridge/dex/risk, capped, busy). Seeds: senders of case transactions (bounded by tx time) + recipient wallets (bounded by last payment), max 30. New findings `source_exchange` and `source_risk_exposure`, a "Sources of funds" card (endpoints + source paths), link-chart edges coloured by direction, report section. `sources.hit` reports source-side bounds. Self-check: ~30 asserts (stops at exchange and sanctioned wallet without fetching them, time ordering, exchange-as-sender, hop / fan-out / wallet-cap / time-budget reporting, chart direction).
- [x] **9.3 Analysis wallets to case** — per-row "Add to case" and "Add all (N)" with a role selector on the counterparty wallets, endpoints, source endpoints and source paths tables; the note carries the run, hop, amount and path. Backend `POST /cases/:id/addresses/bulk` (max 500, all-or-nothing validation, org-scoped, audited, skips existing and reports how many).
- [x] **9.4 Docs** — `docs/api.md` (bulk endpoint, `direction`, `sources`, finding types).
- [x] **9.5 Checks** — `npm run check` passes; frontend `npm run build`; `e2e/investigate.spec.ts` (bulk endpoint rules; tx page -> case -> analysis -> Sources -> Add all). Also `PW_BASE_URL` now sets the Playwright base URL and the teardown target (it was hard-wired to :3000).

**Status (9A, 2026-11-21):** built on branch `wt-a`. Honest limits: the backward trace was exercised on crafted data in the self-check, and end to end only on one public Tron transaction (its sources may be empty); no real exchange-withdrawal source was observed live. A time-ordering bound is per wallet (latest transfer to the next wallet), so a busy intermediate can still pass funds that were not the case funds: findings say so. Each direction gets the full time budget, so a `both` run can take twice as long. Source tracing does not infer deposit addresses.

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

### 8C — Automatic exchange / service labels (asked 2026-11-20)
Goal: wallets of Binance and other major exchanges are labelled automatically from public, citable sources, and tracing stops there. 8B already treats exchange/service/capped wallets as terminal.
- [~] **8.14 Official proof-of-reserves lists** — import the wallet lists that exchanges themselves publish (e.g. Binance, OKX, Bybit, KuCoin, Bitget, HTX where available), on Tron/Ethereum/BNB Chain. `source=official`, `sourceUrl` = the exchange's page, category `exchange`, name "Binance (proof-of-reserves wallet)". Refreshed weekly. Only lists actually fetched and parsed in-session; every address format-checked.
- [x] **8.15 Explorer tags (opt-in keys)** — Tronscan public tags (needs a free `TRONSCAN_API_KEY`) and Etherscan name tags where the plan allows. Looked up lazily for high-volume counterparties and cached. `source=tronscan|etherscan`, the tag text kept verbatim; mapped to `exchange` only when the tag names a known exchange.
- [x] **8.16 Deposit addresses follow their exchange** — a wallet that sweeps to an officially labelled exchange hot wallet (existing clustering in cluster.ts/attribution.ts) is auto-labelled "<Exchange> deposit address" with `source=cluster` and the sweep tx as evidence, when the evidence threshold is met; weaker cases stay in the review queue.
- [x] **8.17 Service-scale heuristic** — wallets above the index cap or with service-scale activity are shown as "likely exchange/service (heuristic)" — not named, not traced, never risk-weighted as an exchange.
- [x] **8.18 UI + checks** — label source badges (official / explorer / cluster / heuristic) with links; Labels page filters; self-check for list parsers and the tag→category mapping.

**8C status (branch phase-8c):**
- 8.14 [~]: pipeline done (`exchange-labels.ts` `POR_SOURCES`, weekly `por-sync`, `POST /labels/sync {source:'por'}`, generic validated parser) but **`POR_SOURCES` is empty**: on 2026-11-20 no exchange's official wallet list could be fetched (Binance page script-rendered, OKX unreachable, Bybit/KuCoin pages carry no addresses, Bitget's address API needs undocumented params, HTX 404, Gate 403). Add `{ exchange, url }` once a real file URL is verified.
- 8.15: Tronscan lookup built (`POST /labels/explorer-tag`, `TRONSCAN_API_KEY` optional) but live call untested (no key). Etherscan name tags are Pro Plus only: not implemented.
- 8.16: auto-accept when hot wallet is `source=official` and (>= 2 sweeps or one sweep >= 95% of received).
- 8.17: `isServiceScale` (capped, or >= 20,000 indexed rows); address page shows "likely exchange/service (heuristic)".
- 8.19 Binance proof-of-reserves find-and-mark (`backend/src/binance-por.ts`, supersedes the empty `POR_SOURCES` for Binance; decision 2026-11-20: "just find and mark, no need to save such data"): resolves the newest snapshot via Binance's two public endpoints, streams the ~291 MB zip to a temp file (deleted in `finally`), scans `_HotCold.csv` then `_Deposit.csv` for ONLY the addresses asked about, stops early when all are found. **The lists are never stored**; only matches get a global `source=official`, `category=exchange` label (names "Binance hot/cold wallet (proof-of-reserves dd Mon yyyy)" / "Binance deposit address (proof-of-reserves …)", `sourceUrl` = zip URL). A seeded official label is never overwritten. Misses are cached per (snapshot, chain, address) 35 days in Redis. Concurrent callers are single-flighted (batched into one next run). **No match never means "not a Binance customer"**: the deposit list only holds addresses with a balance at the snapshot (17 real case wallets: 0 hits).
  - `POST /labels/exchange-check` (perm `labels.sync`: it writes global labels and can trigger a ~290 MB download) `{addresses:[{chain,address}]}`, max 5,000 -> `{snapshot, url, checked, matched, skippedCached, seconds, matches, timings}`.
  - **Hook for 8B (wire at merge):** `BinancePor.check(addresses: {chain: 'tron'|'eth'|'bsc'; address: string}[]): Promise<PorResult>` (injectable, add `BinancePor` to providers; already in `app.module.ts` on this branch). Call it from the case analysis with ALL wallets (recipients plus traced), then re-read labels (`labels.lookup`). It throws if Binance is unreachable: catch and continue, labelling is best-effort. Dedupes and lowercases 0x itself.
  - Statement labels: importing a Binance statement (`exchangeOfFormat`) upserts, per distinct valid address of each "Off-chain transfer" row, `source=statement`, `category=exchange`, confidence 0.9, name "Binance deposit address (per exchange statement: case #N, "file")", `sourceUrl` null. **Org-scoped** (`orgId` = importing org, never global): a customer statement is case evidence, not a public fact; one row per (address, org), a later statement refreshes the case/file in the name; not removed when the case file is deleted. Attribution (`attribution.ts`) no longer treats `statement` labels or any "deposit address" label as a hot wallet; `exchangeName` strips "hot/cold wallet" / "deposit address".
- 8.18: Labels page source badges + source/exchange filters, address-page exchange banner, selfcheck asserts, `frontend/e2e/exchange-labels.spec.ts`.


## Phase 9D - AI investigation assistant (feature-flagged, "Coming soon" on staging)
Decision 2026-11-21: build it fully, ship OFF (`AI_ENABLED=false`). New dependency: `@anthropic-ai/sdk` 1.12.0 (official SDK: auth, retries, timeouts and typed errors for the Messages API; a hand-rolled fetch client would re-implement those). Loaded lazily, only when the flag is on.
- [x] `backend/src/ai.ts`: flag, `GET /ai/status`, `POST /ai/address-summary`, `/ai/case-summary`, `/ai/ask`; permission `ai.use` (Owner/Admin/Analyst)
- [x] Bounded context builders (address, case analysis), untrusted-text sanitising + escaped data block, strict system prompt (cite ids, "not in the data", no identity claims)
- [x] Citation extraction verified against the context (unverified ids reported, never linked)
- [x] Per-input-hash cache 1 h, per-user rate limit, audit log without prompt bodies, input and output caps
- [x] Disabled path: 503 `ai_disabled`, no client created, no network call (asserted in `npm run check`)
- [x] Frontend `AiPanel` on the address page and the case Analysis tab: Coming-soon state (disabled button + badge, no AI calls), enabled state with citation links, notice, copy, loading/error, Ask box
- [x] `npm run check` (mocked client), frontend `npm run build`, `frontend/e2e/ai.spec.ts` (disabled state, both pages, mobile width, no AI calls)
- [ ] Live model calls: **untested** (no API key in this environment). The enabled UI path was not exercised in a browser; prompt quality and the real SDK response shape are unverified.
- [ ] Streaming (optional, not built); prompt caching (not used: results are cached per input instead)

**9D status:** done on branch wt-d, flag OFF. To enable on staging: set `AI_ENABLED=true`, `ANTHROPIC_API_KEY`, optionally `AI_MODEL`, restart, then try a summary and read the first answers critically before announcing it.

## Phase 9B — Named graph snapshots with remarks, risk-change alerts (branch wt-b, 2026-11-21)
Asked: a case kept ONE saved graph (`Case.graphJson`) with no name and no remarks; watched wallets were only checked for new transfers.
- [x] **9B.1 `CaseGraph` model + migration** (`20261121b000000_case_graphs`): id, caseId (cascade), name, remarks, chain, rootAddress, depth, filters, graphJson, graphPng, nodeCount, edgeCount, createdBy, createdAt, updatedAt; org scope through the case. **Data migration in the same file:** each case's existing `graphJson` (+ `graphPng`) becomes one snapshot "Saved graph (migrated)" (counts/root/chain computed in SQL, same rules as `graphStats()`); tested on a database holding legacy rows (object graph, JSON-string graph, no graph).
- [ ] **9B.1b Later cleanup:** `Case.graphJson` / `Case.graphPng` are kept but no longer written or read (`PUT /cases/:id/graph` now creates a snapshot). A later migration must drop both columns once production has run 9B and the migrated snapshots are confirmed.
- [x] **9B.2 API** — `GET/POST /cases/:id/graphs`, `GET /cases/:id/graphs/latest`, `GET/PATCH/DELETE /case-graphs/:id`; saving never overwrites; rename / remarks edit / delete need `cases.manage`; audited. `GET /cases/:id` returns `graphs` (summaries) instead of `graphJson`/`graphPng`.
- [x] **9B.3 UI** — graph page "Save to case" dialog (case, name suggested from root wallet + date, remarks); case Graph tab (`components/CaseGraphs.tsx`): list with name, remarks, root, counts, author, date; View (read-only picture), Open in workspace (`/graph?case=&snapshot=`), rename / edit remarks, delete. Opening a snapshot then saving creates a new one.
- [x] **9B.4 Every `graphJson` reader uses the snapshots** (grep'd: `cases.ts` timeline, GET case, save; `timeline.ts` `graphAddresses`; graph page; case page; report page; `e2e/crosschain.spec.ts`; docs). Timeline reads ALL snapshots, de-duplicated. The printable report lists every snapshot with name, remarks, counts, author, date (pictures for the newest 6).
- [x] **9B.5 Risk-change alerts** — rule type `risk_change` (`monitor-rules.ts`: `riskSnap`, `evaluateRiskChange`, pure), `MonitorService.riskCheck` (reuses `RiskService.assess`, `deep: false`; `RISK_RECHECK_SEC` default 3600 per wallet, `RISK_MAX_PER_POLL` default 5), state on `WatchItem.lastRisk*`; alert text holds before / after and reasons; same inbox / email / webhook pipeline. Monitoring UI: "Risk change" rule type with enable switch, last-score column.
- [x] **9B.6 Timeline bounded** — `CasesService.timeline` now reads wallets through `boundedMap` (4 at once, 25 s per wallet, 120 s total) and returns partial data plus `warnings`. **API shape change:** `GET /cases/:id/timeline` is `{ transfers, warnings }` (was an array); the Timeline tab shows the warning. (The 500 itself was the 30 s proxy cut, fixed earlier by `proxyTimeout`.)
- [x] **9B.7 Checks** — `npm run check` (+ ~45 asserts: `graphStats` on every saved shape, `boundedMap` timeout / error / budget, `riskSnap`, every `risk_change` trigger and non-trigger); Playwright `e2e/snapshots.spec.ts` (2 specs); the Playwright config and `cleanup.ts` take `E2E_BASE`.

**Status (9B):** built and checked on ports 4200 / 3200 against a copy database. Verified: data migration on legacy rows; the snapshot API and UI flow end to end (create x3, list, view, rename, remarks, open, save-as-new, report, delete, 404); timeline response shape; risk_change end to end against the live backend (baseline stored, then a scam label added to the wallet raised exactly one alert "risk level rose from Low (0) to Severe (90); now labelled high-risk" with the reasons, a repeat re-score raised none; run by calling `MonitorService.riskCheck` in a Nest application context, plus one baseline stored by the real `poll()` loop; the `poll()` throttle and per-pass cap were not exercised live). Not verified: email and webhook delivery of a risk_change alert (no SMTP here; webhook targets must be public URLs); the "frozen", "sanctioned" and "new flagged counterparty" triggers only in unit asserts, not against live chain data; the timeline's 25 s per-wallet timeout was exercised with `boundedMap` asserts, not by a real slow chain call (a timed-out `getTransfers` keeps running in the background, it cannot be aborted); Ethereum / BNB Chain wallets in `risk_change` (no key / plan). A graph's other-chain nodes (`eth:0x...` ids) are still not picked up by the timeline (`graphAddresses` only reads ids that are plain addresses), unchanged from before.

## Phase 9C — exchange-owned vs customer deposit labels, stored exchange wallet lists, wallet grouping (2026-11-21, branch wt-c)
Problem: importing a Binance deposit/withdrawal history labelled the suspects' own deposit addresses (and other customers' addresses) as category `exchange`, so the UI called them "Binance" and the trace ended there as if they were Binance wallets.
- [x] **9C.1 Separate exchange-owned from exchange customer addresses** — new category `exchange_deposit` (weight 0), display "<Exchange> customer account (deposit address)"; statement / PoR-deposit / cluster labels re-categorised by migration `20261121c00000_exchange_deposit_labels` and in code; deposit-history rows "Binance deposit address of the statement holder (case #N)", withdrawal off-chain recipients "Binance customer deposit address (internal transfer in case #N statement)"; case role shown before the label on the address page and in the analysis wallet table; `stopOf`: customer account ends the trace with "funds entered a Binance customer account — request account holder records from Binance", but a case seed is still traced; findings `exchange_endpoint` (exchange wallet) vs `exchange_customer_endpoint`. Self-check asserts.
- [x] **9C.2 Stored exchange wallet lists + daily check** — `exchange-lists.ts`: Binance hot/cold (all HotCold rows on TRX/ETH/BSC, `source=official`, `sourceUrl` = zip) and HTX; job `exchange-lists` every 24 h; the check is the snapshot-list request (Binance) / HTTP ETag (HTX); download only when newer; labels of the old list that dropped out are removed (own name prefix only); status on the Labels page; `POST /labels/exchange-lists/sync`. The ~10 M Binance deposit list is not stored.
- [~] **9C.2b Other exchanges** — HTX shipped. OKX, Bybit, KuCoin, Bitget, Gate NOT shipped (see status note).
- [x] **9C.3 Wallet grouping** — `wallet-groups.ts` (common funder within 24 h, shared `exchange_deposit` address, round trip within 72 h), on-demand `GET /address/:addr/groups` + "Possibly same owner" card on the address page, `possible_same_owner` findings in case analysis. Heuristics with evidence, never stored or asserted.
- [x] **9C.4 Docs** — docs/api.md "Phase 9C".
- [~] **9C.5 Checks** — backend `npm run check` passes (new asserts), frontend `next build`, Playwright `exchange-customer.spec.ts`; live Binance hot/cold sync run. NOT verified: a Binance DEPOSIT-history file (none available; covered by crafted rows only), a real wallet-group hit on live data (only crafted data + one live call that found no signal), the daily job firing on its own (only the same code path via the endpoint), light theme.

**Status note (9C):**
- Live sync on a DB copy (2026-11-21): Binance snapshot 2026-11-12 (zip `wallet_address_20261111.zip`), 232 labels: tron 46, eth 111, bsc 75; 1 upstream row skipped (an ETH-network row holding a non-0x address, balance 0); download+parse 24 s; an unchanged re-check takes 0.3 s (no download). HTX: tron 15, eth 5, 0.2 s.
- Relabel check on the real withdrawal export (temporary case, deleted with its labels): 87 rows, 32 off-chain, 7 distinct recipient addresses labelled `exchange_deposit` (name "Binance customer deposit address (internal transfer in case #N statement)"), 0 labels on the 10 on-chain destinations.
- Other exchanges (researched 2026-11-21 with plain GET / a real browser): **OKX** list exists (`static.okx.com/cdn/okx/por/chain/por_csv_2026110100_V1.zip`, 111 MB zip, 474,530 Tron + 33,695 EVM rows) but is ~500 k OKX-controlled addresses including per-user deposit addresses, not a small owned-wallet list: not stored (same reason as Binance's deposit list); the www.okx.com host is blocked from this network. **Bybit, KuCoin**: only Hacken audit PDFs list wallets (no CSV/JSON); a PDF parser was not added. **Bitget, Gate**: only per-coin totals are public (Bitget's wallet-list endpoint needs undocumented parameters; Gate's API is Akamai-blocked to non-browsers). Revisit if a machine-readable list appears.
