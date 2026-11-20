# API contract

Single source of truth for the NestJS backend (`backend/`) and the Next.js frontend (`frontend/`).
Base path `/api` (the frontend proxies `/api/*` to `http://localhost:4000/api/*`).
**Status:** ✅ built and tested · 🟡 written, not yet wired/tested · ⬜ to build.

## Conventions

- JSON in/out. Errors: `{ "statusCode": 4xx, "message": "human readable", "error": "..." }` — show `message` to the user.
- Auth: session cookie `sid` (HttpOnly, set by login/setup). Every route needs it unless marked **public** or **api-key**.
  - `401` → frontend redirects to `/login?next=<path>`.
  - `403` → show "You don't have permission for this". The frontend also **hides or disables** UI for actions the user lacks permission for, using `permissions` from `/auth/me` (never rely on hiding alone — the backend enforces).
- **Access control is permission-based (RBAC)** — see "Roles & permissions" below. Each route requires one permission; the table rows say which (`perm:`).
- Addresses: Tron `T` + 33 base58 chars; EVM `0x` + 40 hex (backend stores lowercase). Tron is auto-detected. **A `0x` address exists on every EVM chain, so it is Ethereum by default and the caller says `chain=bsc` for BNB Chain** (see "Assets & chains" below) — the UI asks only for `0x` input.
- Amounts are token units with the token's decimals already applied (USDT and USDC are both ≈ 1 USD, so volumes of different assets are simply added wherever a response says USD-equivalent: risk exposure, node/edge totals, balances with `asset=all`). Timestamps are **milliseconds since epoch** unless the field is an ISO `createdAt`/`updatedAt`.
- Risk levels: `severe` (≥75) · `high` (≥40) · `medium` (≥15) · `low`. Label categories and weights: `sanctioned 100, frozen 100, ransomware 95, darknet 95, terrorism 95, scam 90, fraud 90, mixer 80, gambling 50, other 20, exchange 0, service 0`.
- Lists are capped/paginated as noted. Slow endpoints (live chain data) take 2–15 s — the UI must show loading states.

---

## Roles & permissions (Phase 6, enterprise RBAC) ✅

Permission keys (fixed list, defined once in the backend and returned by `GET /permissions`):

| Key | Allows |
|---|---|
| `investigate.view` | address, tx, graph, path, risk pages |
| `export.data` | CSV downloads, case reports |
| `screen.run` | create bulk screening jobs (viewing results needs `investigate.view`) |
| `labels.view` / `labels.manage` / `labels.sync` | see labels / create, delete, import / run OFAC, Tether & Circle sync, import-url |
| `monitor.view` / `monitor.manage` | see watchlists & rules / create & edit them |
| `alerts.triage` | change alert status |
| `cases.view` / `cases.manage` / `cases.delete` | see cases / create & edit (addresses, notes, files, graph) / delete cases |
| `attribution.run` / `attribution.review` | run clustering / accept or reject suggestions |
| `notify.manage` | email/webhook targets |
| `users.manage` | invite/create, disable, change role, reset 2FA, revoke sessions of users |
| `roles.manage` | create/edit/delete custom roles |
| `apikeys.manage` | create/revoke API keys |
| `audit.view` | audit log |
| `index.manage` | data index admin: coverage, backfill, re-sync, remove, tailer status |
| `org.manage` | org settings (name, require 2FA, session lifetime, password policy) |

Built-in (system) roles, created per org, not editable or deletable:
- **Owner** — all permissions; the setup user. Must always be ≥ 1 active Owner.
- **Admin** — all except `org.manage` (so it includes `index.manage`).
- **Analyst** — investigate, export, screen, labels.view+manage, monitor.view+manage, alerts.triage, cases.view+manage, attribution.run+review.
- **Viewer** — investigate.view, labels.view, monitor.view, cases.view.
Admins can create **custom roles** with any subset (cannot grant a permission they don't hold themselves).

| Method | Path | perm | Notes |
|---|---|---|---|
| GET | `/permissions` | any signed-in | `[{ key, group, label, description }]` |
| GET | `/roles` | `users.manage` or `roles.manage` | `[{ id, name, description, system: boolean, permissions: string[], users: number }]` |
| POST | `/roles` | `roles.manage` | `{ name, description?, permissions: string[] }` |
| PATCH | `/roles/:id` | `roles.manage` | same fields; 400 for system roles |
| DELETE | `/roles/:id` | `roles.manage` | 400 if system or still assigned |

## Auth, users & platform (Phase 6) ✅

| Method | Path | perm | Notes |
|---|---|---|---|
| GET | `/health` | public | `{ ok: true }` |
| GET | `/auth/status` | public | `{ setupNeeded: boolean }` |
| POST | `/auth/setup` | public, first run | `{ orgName, name, email, password }` → creates org, system roles, Owner user; sets cookie |
| POST | `/auth/login` | public | `{ email, password, totp? }` → sets cookie. 401 wrong credentials · 403 `{ message, code: 'USER_DISABLED' }` · 401 `{ code: 'TOTP_REQUIRED' }` when 2FA is on and `totp` missing/wrong (UI then shows the code step) · 429 too many attempts. |
| POST | `/auth/logout` | signed-in | |
| GET | `/auth/me` | signed-in | `{ id, email, name, role: { id, name }, permissions: string[], totpEnabled, mustEnrollTotp, org: { id, name, require2fa } }` |
| POST | `/auth/password` | signed-in | `{ current, next }` — policy: ≥ 12 chars, not equal to email |
| POST | `/auth/2fa/setup` | signed-in | → `{ secret, otpauthUrl }` (UI shows QR of `otpauthUrl` + the secret) |
| POST | `/auth/2fa/enable` | signed-in | `{ code }` → `{ recoveryCodes: string[] }` (shown once) |
| POST | `/auth/2fa/disable` | signed-in | `{ password }` (blocked when org requires 2FA) |
| GET | `/auth/sessions` | signed-in | own sessions `[{ id, current, createdAt, lastSeenAt, ip, userAgent }]` |
| DELETE | `/auth/sessions/:id` | signed-in | revoke own session |
| GET | `/users` | `users.manage` | `[{ id, email, name, role: { id, name }, status: active\|disabled, totpEnabled, lastLoginAt, createdAt }]` |
| POST | `/users` | `users.manage` | `{ email, name, roleId, password }` (admin sets initial password; user must change it at first login: `mustChangePassword`) |
| PATCH | `/users/:id` | `users.manage` | `{ name?, roleId?, status? }` — cannot disable/demote self or the last Owner |
| POST | `/users/:id/reset-2fa` | `users.manage` | |
| POST | `/users/:id/revoke-sessions` | `users.manage` | |
| DELETE | `/users/:id` | `users.manage` | |
| GET | `/org` · PATCH `/org` | `org.manage` | `{ name, require2fa, sessionDays (1–90) }` |
| GET | `/api-keys` | `apikeys.manage` | `[{ id, name, prefix, rateLimitPerMin, usageCount, lastUsedAt, revokedAt, createdAt, createdBy }]` |
| POST | `/api-keys` | `apikeys.manage` | `{ name, rateLimitPerMin? }` → `{ id, key }` (**key shown once**) |
| DELETE | `/api-keys/:id` | `apikeys.manage` | revoke |
| GET | `/audit?action=&userId=&from=&to=&page=0` | `audit.view` | `{ rows: [{ id, action, target, detail, createdAt, user, ip }], total, page, pageSize: 50 }` |
| GET | `/v1/screen/:addr?deep=true` | **api-key** (`X-API-Key`) | `{ address, chain, riskScore, riskLevel, frozenByTether, labels[], reasons[], exposures[], transfersChecked, checkedAt }`. 429 over the key's per-minute limit. ✅ |

## Investigation (Phase 1) ✅

| Method | Path | Notes |
|---|---|---|
| GET | `/address/:addr?limit=200&deep=false&chain=&asset=all` | `{ chain, address, balance, frozen, totalIn, totalOut, txCount, truncated, firstSeen, lastSeen, risk: Assessment, counterparties: [{ address, in, out, inCount, outCount, label: {name, category} \| null }], transfers: [{ hash, from, to, amount, asset: 'usdt'\|'usdc', timestamp }] }`. **Phase 7B additions:** `chain` (`tron`\|`eth`\|`bsc`, only needed for `bsc`), `asset` (`usdt`\|`usdc`\|`all`, default `all`; 400 otherwise) and the response fields `asset` (echo), `assets: [{ asset, symbol, decimals, issuer: 'tether'\|'circle'\|null, note }]` (the registry for this chain; `note` is the Tron USDC "historical only" text), `balances: { usdt, usdc }` (always both), `balance` (USD-equivalent of the *selected* assets), `byAsset: { usdt?: { in, out, count }, usdc?: … }` (the returned window), `frozenBy: ['Tether'\|'Circle']`, `frozenAssets: { usdt, usdc }` with `true`/`false` from the issuer's on-chain blacklist or `null` = no issuer freeze exists (BSC pegged tokens — show "not applicable"). `frozen` is true when any issuer froze the wallet (live check or a `tether`/`circle` frozen label). `coverage` also carries `assets` (csv of assets whose full history is stored). `totalIn/totalOut/counterparties` add all selected assets (USD-equivalent). `truncated=true` → totals cover only the latest `txCount` transfers. **Default `limit=200` (one TronGrid page, ~2 s); max 2000.** **Phase 7A additions:** `coverage: { status: 'pending'\|'backfilling'\|'complete'\|'capped'\|'error', rowCount, newestTs, lastSyncAt } \| null` (null = wallet not in our index) and `lifetime: { in, out, inCount, outCount, counterparties, firstSeen, lastSeen } \| null` — **only non-null when `coverage.status = 'complete'`**, computed in SQL over the wallet's whole history (self-transfers excluded). `totalIn/totalOut/txCount/truncated` keep their old meaning (the returned window). `risk` is the *shallow* assessment (own labels, direct exposure, freeze check; `indirect` = 0) unless `deep=true`. The UI shows this at once, then loads `GET /risk/:addr` for the 2-hop result and offers "Load more history" (`limit=1000`, ~5 pages, 10–20 s on busy wallets). Balance, transfers and the freeze check run concurrently. |
| GET | `/address/:addr/report.csv?chain=&asset=` | CSV download (summary + all transfers). **7B:** per-asset `balance_usdt`/`balance_usdc` rows, `frozen_by_issuer`, transfer columns `time_utc, direction, from, to, asset, amount, tx_hash` (was `amount_usdt`). |
| GET | `/tx/:chain/:hash` | chain `tron`\|`eth`\|`bsc` → `{ chain, hash, block, timestamp, success, transfers: [{ from, to, amount, asset }], nativeSymbol: 'TRX'|'ETH'|'BNB', native: [{ from, to, amount }], swaps: Swap[] }` (USDT and USDC transfers of the registry only; **7C:** `native` = value-carrying internal calls of the tx, failed ones excluded; `swaps` see Cross-chain (Phase 7C) below; tx detail is cached 24 h). A 0x hash exists on both EVM chains, so the caller picks `eth` or `bsc`. |
| GET | `/graph/:addr?depth=1&fanout=8&from=&to=&min=&chain=&asset=all` | depth 1–3, fanout 1–15, from/to ISO date or ms, min = amount in token units → `{ chain, asset, nodes: [{ id, root?, expanded, in?, out?, label?, category? }], edges: [{ id, source, target, amount, count, asset }] }`. **7B:** one edge per (direction, asset): a USDT edge keeps the id `source>target` (old saved graphs stay valid), every other asset appends `:asset` (e.g. `source>target:usdc`). Node `in/out/volume` are USD-equivalent over the shown assets. With `asset=usdc` only USDC transfers are read and drawn. |
| GET | `/graph/:addr?…&transfers=true` | ✅ same, plus each edge gets `transfers: [{ hash, amount, timestamp, asset }]` (newest first, max 50 per edge) so the UI can draw one link per transfer and label it with amount/date. Nodes also get `volume` (in+out within the window) for sizing. |
| GET | `/path?from=&to=&maxHops=4&fanout=10&chain=&asset=all` | directed money path → `{ chain, found, path: string[], nodes, edges, expansions, limitReached }`; `chain` applies to both ends (400 if they are not the same chain); `edges` lists every asset's edge between consecutive hops. |

`Assessment` = `{ chain, address, score, level, own, direct, indirect, reasons: string[], exposures: [{ address, name, category, weight, volume, share }], labels: [{ name, category, source, confidence }], frozen, frozenBy: string[], transfersChecked }`. **7B:** reasons add up USDT + USDC as USD-equivalent ("USDT and USDC are both ≈ 1 USD, so their volumes are added") and a freeze reads `Frozen by Tether and/or Circle (issuer blacklist)`.

## Screening & labels (Phase 2) ✅

| Method | Path | Notes |
|---|---|---|
| GET | `/risk/:addr?chain=&asset=all` | `Assessment` with 2-hop indirect exposure, scored on the latest 200 transfers (same page the address summary reads, so it is a cache hit) + the top 5 unflagged counterparties' latest 200 (fetched concurrently). 5–20 s cold. |
| POST | `/screen` | `{ name?, addresses?: string[], chain?, asset? }` or `{ name?, csv: string, … }` (any cell that is an address), max 1000 → `{ id, total }`. Runs in background. `chain` (`eth` default \| `bsc`) applies to every 0x address in the request (400 if `tron`); `asset` (`usdt`\|`usdc`\|`all`) is what exposure is measured in. |
| GET | `/screen` | latest 50 jobs `[{ id, name, asset, status: queued\|running\|done\|failed, progress, total, createdAt, updatedAt, error }]` |
| GET | `/screen/:id` | `{ id, status, progress, total, error, asset, rows: [{ chain, address, score, level, frozen, frozenBy, labels, reasons, error? }] }` — poll every 2–3 s while running |
| GET | `/screen/:id/csv` | CSV download; columns `address, chain, risk_score, risk_level, frozen, frozen_by, labels, reasons, error` (7B: `frozen_by_tether` → `frozen` + `frozen_by`) |
| GET | `/labels?q=&category=&source=&page=0` | `{ rows: Label[], total, page, pageSize: 100 }` |
| GET | `/labels/status` | `{ counts: { ofac, tether, circle, official, manual, import, cluster }, ofacLastSync, tetherLastSync, circleLastSync, etherscanKey, categories: string[] }` |
| GET | `/labels/address/:addr` | `Label[]` for one address |
| POST | `/labels` | `{ address, name, category, chain? }` → manual label (org-private). `chain` (`eth`|`bsc`) only matters for 0x addresses (default Ethereum); 7C: categories now include `bridge` and `dex` |
| DELETE | `/labels/:id` | own org labels only (global OFAC/Tether → 403) |
| POST | `/labels/import` | `{ csv, dryRun: boolean }`; CSV columns `address,name,category[,confidence[,chain]]` (5th column `bsc`/`eth` for 0x rows, default Ethereum). dryRun → `{ total, valid, errors: [{ line, address, error }], preview }`; else `{ inserted, skipped }` |
| POST | `/labels/sync` | admin → `{ source: 'ofac' \| 'tether' \| 'circle' }` (a full Tether/Circle sync can take minutes). Circle: `Blacklisted`/`UnBlacklisted` events of the USDC contract on Tron (TronGrid) and Ethereum (Etherscan, needs the key) → labels `source=circle`, category `frozen`, name `Frozen by Circle`; also runs automatically every 30 min. |

`Label` = `{ id, orgId (0 = global), chain, address, name, category, source: ofac|tether|circle|manual|import|cluster, confidence, createdAt, updatedAt }`

## Monitoring (Phase 3) ✅

| Method | Path | Notes |
|---|---|---|
| GET | `/watchlists` | `[{ id, name, createdAt, items, rules, openAlerts }]` |
| POST | `/watchlists` | `{ name }` |
| GET | `/watchlists/:id` | `{ id, name, items: [{ id, chain, address, note, lastSeenTs, lastCheckedAt, _count: { alerts } }], rules: Rule[] }` |
| DELETE | `/watchlists/:id` | |
| POST | `/watchlists/:id/items` | `{ addresses?: string[], csv?: string, note?, chain? }` → `{ added, skipped }`; `chain` (`eth` default \| `bsc`) applies to the 0x addresses |
| DELETE | `/watch-items/:id` | |
| POST | `/watchlists/:id/rules` | `{ type, params }`: `amount_over {amount}` · `flagged_counterparty {minWeight=50}` · `volume_spike {factor=5}`, each with optional `asset: 'usdt'\|'usdc'\|'all'` (default `all`; rules created before 7B have none and watch every asset). Amounts are token units; a volume spike with `all` adds USDT + USDC (USD-equivalent). |
| PATCH | `/rules/:id` | `{ enabled?, params? }` |
| DELETE | `/rules/:id` | |
| GET | `/alerts?status=open&watchlistId=&page=0&asset=all` | `asset=usdt\|usdc` filters on `Alert.asset` (`all` = no filter; an alert from a rule that spans every asset, e.g. a volume spike, has `asset: 'all'` and only shows under All). `Alert` gains `asset: 'usdt'\|'usdc'\|'all'`; non-USDT alert `dedupKey` = `<hash>:<asset>`. `{ rows: [Alert & { rule: { type }, watchItem: { note, watchlist: { id, name } } }], total, page, pageSize: 50 }` |
| PATCH | `/alerts/:id` | `{ status: open\|reviewing\|closed }` |
| POST | `/monitor/run` | run one poll now → `{ checked, alerts }` (normally automatic every `MONITOR_INTERVAL_SEC`, default 120) |
| GET/POST/DELETE | `/notify-targets` (`/:id`) | admin. POST `{ type: email\|webhook, target }` → webhook gets a generated `secret` |
| POST | `/notify-targets/:id/test` | admin → sends a sample notification |

`Alert` = `{ id, chain, address, counterparty, amount, txHash, detail, status, createdAt, updatedAt, ruleId, watchItemId }`.
First poll of a new watched address only records a baseline — alerts start from the next new transfer.
Webhook: POST JSON `{ event: 'alert.created', alert }`, header `X-USDT-Trace-Signature: sha256=<HMAC-SHA256(secret, rawBody) hex>`.

## Cases (Phase 4) ✅

| Method | Path | Notes |
|---|---|---|
| GET | `/cases?status=` | `[{ id, title, status, createdAt, updatedAt, addresses: number, notes: number, files: number }]` |
| POST | `/cases` | `{ title, description? }` → Case |
| GET | `/cases/:id` | `{ id, title, description, status, createdAt, updatedAt, graphJson, graphPng, addresses: CaseAddress[], notes: [{ id, body, authorId, author, createdAt }], files: [{ id, name, size, mime, createdAt }] }` |
| PATCH | `/cases/:id` | `{ title?, description?, status?: open\|closed }` |
| DELETE | `/cases/:id` | admin |
| POST | `/cases/:id/addresses` | `{ address, chain?, role: suspect\|victim\|exchange\|intermediary\|other, note? }` — `chain` `eth` (default) \| `bsc`; the case stores the chain per address (that is how a case "remembers" Ethereum vs BNB Chain). A saved graph payload carries its `chain` for the same reason. |
| PATCH | `/case-addresses/:id` | `{ role?, note? }` |
| DELETE | `/case-addresses/:id` | |
| POST | `/cases/:id/notes` | `{ body }` |
| DELETE | `/case-notes/:id` | |
| POST | `/cases/:id/files` | multipart field `file`, max 20 MB |
| GET | `/case-files/:id` | download |
| DELETE | `/case-files/:id` | |
| PUT | `/cases/:id/graph` | `{ elements: CytoscapeElementsJson, png: 'data:image/png;base64,…' }` (≤ 8 MB) |
| GET | `/cases/:id/timeline` | `[{ hash, from, to, amount, asset, timestamp, hop }]` — USDT and USDC transfers between the case's addresses (+ saved graph nodes), oldest first; `hop` = distance from the first victim/suspect |
| GET | `/cases/:id/report` | `{ case, addresses: [CaseAddress & { risk: { score, level, reasons } }], timeline, totals: { transfers, volume }, generatedAt, generatedBy }` (for the printable report page; audited) |
| GET | `/cases/:id/transfers.csv` | timeline as CSV |
| GET | `/cases/:id/transactions?status=&q=&limit=200&offset=0` | `cases.view`. `{ summary: { total, pending, byStatus: { <status>: { count, amount } }, claimed, verified }, count, rows: CaseTx[] }`; `CaseTx` = `{ id, chain, hash, source: manual\|import, fileId, rowNo, claimedAt, coin, network, amount, fee, address, ref, status, onFrom, onTo, onAmount, onAsset, onAt, reasons: string[], verifiedAt }`. `status` = `pending\|verified\|mismatch\|not_found\|off_chain\|error`; `q` = substring of hash, address or exchange reference; `limit` max 1000. `claimed`/`verified` are sums of `amount` (USDT + USDC, both about one dollar). Poll while `summary.pending > 0`. |
| POST | `/cases/:id/transactions` | `cases.manage`. Paste: `{ hashes: string \| string[], chain?: eth\|bsc, timeTolMin? }` (one per line / whitespace / comma; max 200). Tron = 64 hex; `0x` + 64 hex is Ethereum unless `chain=bsc`. -> `{ added, skipped: [{ value, reason }], jobId }`: invalid and duplicate hashes are skipped, not an error. Each added row is verified by a background job. |
| POST | `/cases/:id/transactions/preview` | `cases.manage`. Multipart: `file` (.xlsx or .csv, max 5 MB, max 5,000 data rows) + optional `mapping` (JSON `{ hash, amount, address, time?, coin?, network?, fee?, status? }` -> 0-based column index), `tz` (`UTC+5`, `UTC-3:30`), `defaultChain` (`tron\|eth\|bsc`, used when there is no network column). Parses and validates, **stores nothing**: `{ file, format: binance_withdrawal\|binance_deposit\|generic, sheet, headers, mapping, tz (minutes east of UTC), tzDetected, counts: { rows, onChain, offChain, withProblems }, claimed, wallets, rows: [{ row, chain, hash, ref, offChain, address, amount, fee, coin, claimedAt, problems: string[] }] }`. |
| POST | `/cases/:id/transactions/import` | `cases.manage`. Same multipart as preview plus `walletRole` (`none` default, or a case role) and `timeTolMin` (default 120). Rows without problems are imported; the file is stored as a case file (evidence); on-chain rows are verified by a background job; with a `walletRole`, each distinct destination wallet of the on-chain rows becomes a case address whose note names the file. -> `{ fileId, format, imported, offChain, alreadyInCase, skipped, wallets, jobId }`. |
| POST | `/cases/:id/transactions/verify` | `cases.manage`. `{ ids?: number[], timeTolMin? }` -> `{ queued, jobId }`; resets the on-chain rows (all, or `ids`) to `pending` and re-runs the verification job. Off-chain rows are never re-verified. |
| DELETE | `/case-transactions/:id` | `cases.manage` |
| GET | `/cases/:id/transactions.csv` | `export.data`. Every row with claimed and on-chain fields and reasons; formula-injection safe (`toCsv`). The printable report page reads `GET /cases/:id/transactions?limit=1000` for its Transactions section. |
| POST | `/cases/:id/analyses` | `cases.manage`. Starts a case analysis (background job `case-analysis`, one at a time per case: 409 while one is queued/running; 400 when the case has no transactions). Body, all optional (clamped): `hops` 1..3 (2), `fanout` 1..10 (5, onward wallets followed per wallet), `maxWallets` 10..150 (60, onward wallets in total), `budgetSec` 30..600 (180), `thresholds` (array or comma text, up to 10 positive numbers; default 10000,15000,50000,100000), `thresholdPct` (0.1: "just under" = within this % below), `repeatMin` (3), `consolidationMin` (3), `passShare` (0.9), `passHours` (24), `nightFrom`/`nightTo` (0/6 local hours), `nightShare` (0.4), `nightMin` (5), `tzMin` (minutes east of UTC for the hour rules, 0), `busyTransfers` 50..500 (200: a wallet whose first fetched page already holds this many transfers is "high-activity wallet (likely exchange/service) — not traced further"). -> the run `{ id, caseId, status: queued\|running\|done\|failed, stage, params, progress, total, error, createdAt, finishedAt }`. Recipient wallets (at most 30, largest first) are read with the full-backfill reason; onward hops never queue backfills; wallets labelled exchange/service/bridge/dex/risk, wallets whose index status is `capped`, and high-activity wallets are endpoints and are never fetched or expanded. Only transfers made after the funds arrived are followed. |
| GET | `/cases/:id/analyses` | `cases.view`. Runs, newest first (max 50), without `result`. Poll while any is `queued`/`running` (`progress` = wallets traced so far). |
| GET | `/cases/:id/analyses/latest` | `cases.view`. The newest `done` run with `result` (404 when none): what the printable report reads. |
| GET | `/cases/:id/analyses/:aid` | `cases.view`. One run with `result` (null until done). `result` = `{ version, params, bounds, totals: { rows, claimed, verified, offChain: { count, amount }, onChain, wallets, byStatus }, wallets: [{ chain, address, total, verified, count, first, last, share, balance\|null, traced, stopReason, error, labels, risk: { score, level, reasons[], frozen }\|null }], trace: { walletsTotal, walletsTraced, failed, notFollowed, hopLimit, fanoutCut, walletCap, timedOut, seedsTotal, seedsTraced, hit: string[], partial, durationMs }, findings: [{ type, severity: high\|medium\|low\|info, title, statement, evidence: [{ kind: tx\|wallet, chain, hash, ref, address, amount, at, note }] (max 25), evidenceTotal }], findingsBySeverity, endpoints: [{ kind: exchange\|service\|bridge\|dex\|risk\|deposit\|busy, chain, address, name, category, source, reason, hop, amount, path }], chart: { nodes, edges }, notes, points: [[ms, amount, offChain 0\|1]], timeline (first 500 dated rows), timelineTotal }`. Finding types: `repeated_amount`, `near_threshold`, `consolidation`, `pass_through`, `unusual_hours`, `risk_exposure`, `exchange_endpoint` (names who to send legal process to; says when a deposit address is inferred), `busy_endpoint`, `internal_transfer`. Off-chain statement rows count in the totals and in `internal_transfer` but are never traced. `trace.partial` / `trace.hit` list every bound that was reached ("traced X of Y wallets"). |

`CaseAddress` = `{ id, chain, address, role, note }`

## Attribution (Phase 5) ✅

| Method | Path | Notes |
|---|---|---|
| POST | `/attribution/run` | `{ labelId? }` — cluster deposit addresses for one exchange-category label, or all visible exchange labels (max 20) → `{ jobId }` (job type `cluster`) |
| GET | `/attribution/jobs` | latest cluster jobs `[{ id, status, progress, total, createdAt, error }]` |
| GET | `/attribution/suggestions?status=pending` | `[{ id, chain, address, name, category, confidence, evidence: { hotWallet, outToHot, totalOut, depositors }, status, createdAt }]` |
| POST | `/attribution/suggestions/:id/accept` | creates org label `source=cluster` |
| POST | `/attribution/suggestions/:id/reject` | |
| POST | `/labels/import-url` | admin → `{ url, dryRun }` — fetch a CSV (same columns as `/labels/import`) and import as global `source=import` |

## Data index (Phase 7A, own transfer index) ✅

Global chain data (not org-scoped). All routes need `index.manage` and the mutating ones are audit-logged (`index.backfill`, `index.sync`, `index.remove`). Every feature reads address history through `getTransfers()`, which serves a wallet from Postgres once its history is stored; see the rules below.

| Method | Path | Notes |
|---|---|---|
| GET | `/index/status` | `{ transfers: { count, approx }, addresses: { complete?, capped?, pending?, backfilling?, error? }, tailer: [{ chain: 'tron'\|'eth', enabled, cursorTs, lagMs, rowsTotal, rowsPerMin, error, needs }], reads: { db, sync, api }, upstream: { calls, byHost, recent: [{ t, url }] }, config: { maxPerAddress, freshSec } }`. `reads` and `upstream` are counters since process start; `upstream.calls` counts real HTTP attempts to explorer APIs (cache hits and Postgres reads excluded; 429 retries included), `recent` = last 100 URLs (API keys masked). `transfers.approx` is true above 1 M rows (planner estimate). `needs: 'ETH_RPC_URL'` when the Ethereum tailer is enabled without an RPC URL. |
| GET | `/index/addresses?q=&status=&limit=50&offset=0` | `{ total, rows: [{ id, chain, address, status, assets, retries, retryAt, reason: 'lookup'\|'watch'\|'case'\|'manual', rowCount, oldestTs, newestTs, lastSyncAt, error, createdAt }] }` (`assets` = csv of stored assets, e.g. `usdt,usdc`), newest first; `q` = substring of the address |
| POST | `/index/addresses` | `{ address, chain? }` — add a wallet (reason `manual`) or re-queue a full backfill for a listed one; `409` while its backfill is running |
| POST | `/index/addresses/:addr/sync?chain=` | incremental sync now (only transfers at/after the newest stored); `409` unless status is `complete`/`capped`; `404` if not indexed |
| DELETE | `/index/addresses/:addr?chain=` | drops the coverage row (reads go back to the live API); stored transfers are kept; `409` while backfilling |

**Read-through rules** (`getTransfers(chain, addr, max, fresh, reason)`): wallet `complete` (or `capped` and `max` ≤ rows held) and synced within `INDEX_FRESH_SEC` → Postgres only. Covered but stale, or `fresh` (monitoring) → fetch only newer rows (`min_timestamp` on Tron, `startblock` on Ethereum), then Postgres. Anything else (unknown, `pending`, `backfilling`, `error`) → live API as before; the page is written through and, unless the caller is a graph/risk/attribution neighbour (`reason: 'graph'`), the wallet is queued for a background backfill (`INDEX_MAX_PER_ADDRESS`, default 50 000, then `capped` = newest N kept). With `INDEX_TAIL` on and the tailer within 3 min of real time, a wallet synced after the tailer started needs no API call even when `fresh`.

**Full-chain tailer** (`INDEX_TAIL=tron,eth`, off by default): Tron via TronGrid USDT `Transfer` events in 60 s windows kept 2 min behind real time (the confirmation floor), Ethereum via `ETH_RPC_URL` `eth_getLogs` (12 confirmations). Starts at "now"; older history comes from per-wallet backfills. The Ethereum paths are code-complete but not live-tested.

## Assets & chains (Phase 7B, USDT + USDC on Tron / Ethereum / BNB Chain)

Registry (`backend/src/assets.ts`; each contract's `symbol()` and `decimals()` were read live on 2026-11-20, see task.md 7B):

| Chain | Asset | Contract | Decimals | Issuer freeze |
|---|---|---|---|---|
| `tron` | USDT | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | 6 | Tether `isBlackListed` |
| `tron` | USDC | `TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8` | 6 | Circle `isBlacklisted` — Circle ended Tron USDC support in 2024, so the UI marks it historical-only |
| `eth` | USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` | 6 | Tether `isBlackListed` |
| `eth` | USDC | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | 6 | Circle `isBlacklisted` |
| `bsc` | USDT | `0x55d398326f99059ff775485246999027b3197955` | 18 | none (bridge-issued) → "not applicable" |
| `bsc` | USDC | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | 18 | none → "not applicable" |

- **`asset` parameter** (`usdt`\|`usdc`\|`all`, default `all`) on address, report.csv, graph, path, risk, `/v1/screen`; request body field on `POST /screen`; rule param on monitoring rules; alert filter. An unknown value is `400`. `Transfer.asset` is stored per row.
- **`chain` parameter** (`tron`\|`eth`\|`bsc`) on the same endpoints, in the body of `POST /screen`, `/watchlists/:id/items`, `/cases/:id/addresses`, `/index/addresses`. Omitted = autodetect (`T…` → Tron, `0x…` → **Ethereum**), so every URL that worked before still works. A chain that cannot own the address shape (`chain=tron` with a 0x address, `chain=bsc` with a T address) is `400`.
- **Labels on BNB Chain:** labels are stored per chain (`tron`, `eth`, `bsc`). A BNB Chain lookup also sees the Ethereum-keyed OFAC / manual / import / cluster labels (the same 0x key), but never the Tether / Circle freeze labels, which are specific to the Ethereum contracts.
- **Index coverage** stays per `(chain, address)` and covers *all* assets of that chain: `IndexedAddress.assets` lists what is stored. When the registry gains an asset, `complete` wallets are re-queued at boot and fetch only the missing asset (capped wallets are left alone: their reads of the new asset stay live). A read is served from Postgres only for assets the coverage stores. The full-chain tailer follows USDT only; USDC (and all of BNB Chain) enter through per-wallet backfills.
- **Failed backfills** (typically TronGrid 429) retry automatically after 1, 2, 4, 8, 16 min (`retries`, `retryAt`), then stay `error` until re-queued by hand (`POST /index/addresses`).
- **Ethereum and BNB Chain need `ETHERSCAN_API_KEY`** (Etherscan v2, `chainid=1` / `56`); without it they return `400` saying so. The BNB Chain paths are code-complete and unit-checked but not live-tested; Etherscan's free tier may not include BNB Chain (check your plan).

---

## Cross-chain (Phase 7C)

Labels: categories `bridge` and `dex` (weight 0, informational: they never raise a risk score). `Label` has a nullable `sourceUrl` and a new `source = official` for addresses taken from a vendor's own page; the two shipped seeds (`backend/src/official-labels.ts`, upserted at boot as global labels) are SunSwap Universal Router (`dex`) and Allbridge Core USDT OFT interface (`bridge`), both on Tron, each with its source page. Everything else is added by users via the Labels page (single label, CSV, import-from-URL); for BNB Chain pick the chain in the dialog / CSV 5th column. The hop finder reads labels on the *exact* chain (no Ethereum -> BNB Chain carry-over).

`Swap` = `{ wallet, direction: 'out'|'in', asset, amount, native?: { symbol, amount }, dex?: { address, name }, summary, reasons: string[] }`. `out` = the wallet's **net** stablecoin outflow in this tx and, in the same tx, either its net native inflow (`native`) or a payment to a `dex`-labelled wallet; `in` = net stablecoin inflow from a `dex`-labelled wallet. Failed txs never produce swaps. Evidence from one tx only; a swap that ends in a wrapped token with no native payout is not detected.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/address/:addr/swaps?chain=&max=8&offset=0` | investigate.view | On-demand swap scan of the wallet's **outgoing** transactions, newest first, `max` per call (1..20, default 8) from `offset`, drawn from the newest 200 transfers. → `{ chain, address, outgoingTx, scanned, offset, nextOffset: number|null, swaps: (Swap & { hash, timestamp })[], errors: [{ hash, error }], note }`. Each tx lookup is one chain call (cached 24 h), so the UI pages in chunks of 4; failed lookups are listed in `errors`, never dropped. |
| GET | `/crosschain/hops?chain=&hash=&to=&windowMin=60&tolerancePct=1&target=` | investigate.view | Bridge hop finder. `hash` = a tx on `chain` that paid the `bridge`-labelled wallet `to` (400 if `to` is not labelled bridge, the tx failed, or it has no stablecoin transfer into `to`). `windowMin` 1..1440 (default 60), `tolerancePct` 0.01..10 (default 1), `target` = one other chain (default all others). → `{ source: { chain, hash, from, bridge, bridgeName, amount, asset, timestamp }, params: { windowMin, tolerancePct, defaults }, sides: [{ chain, status: 'ok'|'no_bridge_labels'|'error', bridges, scanned, truncated, error? }], candidates: [{ chain, hash, bridge, bridgeName, to, amount, asset, ts, amountDelta, amountDeltaPct, timeDeltaSec, bridgePair: { from, to }, confidence (0..0.95), level, reasons: string[] }], etherscanKey, note }`. |

Hop rules (`bridge-hop.ts`): candidate = an outflow of a bridge-labelled wallet on another chain with `0 <= payout time - deposit time <= window` and `-0.1% <= (deposit - payout)/deposit <= tolerance`. Confidence = 0.35 amount closeness + 0.25 time closeness + 0.2 same protocol (first word of the two bridge labels) + 0.2 uniqueness (1/number of candidates), x0.8 if the asset differs, capped at 0.95; `level` high >= 0.7, medium >= 0.45. **Bounds:** at most 6 bridge wallets per chain, 600 transfers per wallet (`truncated` says when hit), top 10 candidates. A side with no bridge labels or a failed fetch (e.g. no `ETHERSCAN_API_KEY`) is reported in `sides`, so an empty `candidates` is never mistaken for "no hop". Hops are never auto-asserted; accepted ones are saved with the existing `POST /cases/:id/addresses` (`cases.manage`), `{ chain, address: <recipient>, role: 'intermediary', note: <evidence> }`.

Graph node ids (frontend + saved case graphs): a bare address belongs to the graph's own chain (every pre-7C graph stays valid); a wallet on another chain is `chain:address` (e.g. `eth:0x…`). Cross-chain links are edges with `xchain: true` and an `evidence` object, drawn dashed. Case timelines ignore prefixed ids (they are not same-chain transfers); add the wallet as a case address to keep it.

## Implementation notes (backend, verified against the running server on Tron)

- **Upstream throttling:** chain calls share a per-host pool (max 2 in flight, 350 ms start gap without a `TRONGRID_API_KEY`); a 429 pauses the whole host with exponential back-off; identical concurrent requests are de-duplicated; responses are cached in Redis for 15 min. Unauthenticated TronGrid is the bottleneck (1–5 s per call) — set `TRONGRID_API_KEY` to remove most of the wait. Graph levels are fetched concurrently.
- **Route guard** fails closed: a route with no permission decorator is refused. API keys work only on `/v1/*`; a session cookie does not work there.
- **Restricted sessions** (extra to the contract): `GET /auth/me` also returns `mustChangePassword`. While `mustChangePassword` is true every route except `/auth/me`, `/auth/password`, `/auth/logout`, `/auth/2fa/*`, `/auth/sessions*`, `/permissions` returns `403 { code: 'PASSWORD_CHANGE_REQUIRED' }`; while the org requires 2FA and the user has not enrolled, the same routes are open and everything else returns `403 { code: 'TOTP_ENROLL_REQUIRED' }`. A disabled user's existing session returns `401 { code: 'USER_DISABLED' }`.
- `POST /auth/password` also signs out the user's other sessions. TOTP codes cannot be replayed (a used step is rejected); a recovery code can be typed into the `totp` field of `/auth/login` instead of an app code (one use each).
- `GET /audit` `action` is a prefix match (`user` matches `user.create`, `user.update`, …). Logged: all auth events (login, failed login, 2FA, password), user/role/org/api-key changes, labels, watchlists, rules, alerts, cases (incl. file download, report, export), screening, attribution.
- `GET /notify-targets` does not return `secret`; it is returned once by `POST /notify-targets`.
- Webhook and `/labels/import-url` URLs must be http(s) and must not resolve to private/loopback addresses (SSRF guard); redirects are not followed. `ALLOW_PRIVATE_URLS=true` disables this for local development.
- `GET /graph` and `GET /path` accept `transfers=true` (both exercised). Without the flag the response is unchanged. Edge `transfers` are newest first, max 50, respect the from/to/min filters; `volume` on a node = in+out for expanded nodes, otherwise the sum of its edges' amounts.
- **Cases:** uploads are limited to 20 MB and to pdf, png, jpg, jpeg, gif, webp, docx, xlsx, txt, csv, json, md (content signature checked where the format has one; stored mime comes from the extension, not the client). Downloads are `attachment` with `nosniff`. `PUT /cases/:id/graph`: `png` is optional.
- **Timeline** `hop`: distance in transfers, ignoring direction, from the first `victim` (else first `suspect`, else the first address) among the case's wallets: a transfer touching that wallet is hop 1, the next layer hop 2. `null` = not connected to it. Wallets in the saved graph also count; at most 25 wallets are checked (live chain calls). `GET /cases/:id/report` additionally returns `warnings: string[]` (wallets that could not be fetched, truncation).
- **Case transactions (Phase 8A):**
  - *Formats* are detected from the header row, never the file name. Binance withdrawal = `Time (UTC+n)`, `Coin`, `Network`, `Amount`, `Fee`, `Address`, `TXID`, `Status` (a ninth unnamed column is ignored); a header set without `Fee` is read as a Binance deposit history. The first sheet whose headers match wins, so a `Summary` sheet is ignored. Anything else needs the column mapping. `.xls` is refused (ExcelJS reads `.xlsx` only); save as `.xlsx` or `.csv`. CSV row numbers count non-blank rows.
  - *Timezone:* taken from `(UTC+5)` in the time header; `tz` overrides it; with neither, times are read as UTC and the preview says `tzDetected: false`.
  - *Network -> chain:* TRX / TRC20 / TRON -> tron; ETH / ERC20 -> eth; BSC / BEP20 / BNB -> bsc. Any other network (or coin other than USDT / USDC, or a status other than completed) is a row problem and the row is skipped.
  - *Off-chain rows:* TXID `Off-chain transfer <n>` -> status `off_chain`, `hash` null, `ref` = the text, reason "Internal exchange transfer — no on-chain trace; request records from the exchange". Never sent to a chain API, never added as a case wallet.
  - *Matching* (`statements.ts matchTx`): Binance `Amount` is the net amount received on-chain, `Fee` is separate. Verify against the on-chain transfer **to the claimed address** (a tx with several transfers matches that one). Amount tolerance 1e-6; time tolerance `timeTolMin` (default 120 = ±2 h, after the timezone conversion); coin must match. No reasons = `verified`; otherwise `mismatch` with explicit strings (`Amount differs: …`, `… equals statement Amount … plus Fee …`, `Time differs by … h …`, `No transfer to the claimed address … in this transaction`, `Coin differs …`, `Transaction failed on-chain …`). `not_found` = the chain has no such transaction; `error` = the lookup failed (e.g. Etherscan key missing, BNB Chain refused on Etherscan's free plan, rate limit) with the upstream message in `reasons`: re-verify later. Pasted hashes have no claim, so they only need to exist and move a USDT / USDC transfer.
  - *Uniqueness:* one row per (case, chain, hash). A hash that appears twice in a file (rows paying several addresses in one tx) keeps the first row, the rest are row problems. Re-importing a file skips hashes already in the case (`alreadyInCase`) but stores the file again.
  - *Upload guards:* 5 MB, `.xlsx` (zip signature checked, uncompressed size capped at 60 MB from the zip directory before anything is inflated) or `.csv`; 5,000 data rows; at most 60 columns read. Formula cells are reduced to their cached value, never stored as formulas. Rejected uploads and previews leave no file behind.
- **Attribution:** `POST /attribution/run` returns 400 with a clear message when there is no `exchange`-category label (no exchange addresses are shipped — import or add hot wallets). Cluster-source labels are never used as anchors. Suggestion rules: ≥ 90 % of the candidate's outflow goes to the hot wallet and ≥ 3 distinct depositors; confidence ≤ 0.9. Accepting creates an org label (`source=cluster`, category `exchange`) used by risk and graphs.
- **Not verified:** all Ethereum paths (no `ETHERSCAN_API_KEY`).
- **CSRF / request hygiene:** besides `SameSite=Lax`, every non-GET request must carry `Content-Type: application/json` (or `multipart/form-data` for uploads) — otherwise `415`; a request with `Sec-Fetch-Site: cross-site` or an `Origin` that is not the site's own host (or in `ALLOWED_ORIGINS`) gets `403`. Requests without an Origin (curl, API keys) pass. All API responses send `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. Ids above 2^31-1 return `400 Invalid id`.
