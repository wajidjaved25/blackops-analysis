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
- Addresses: Tron `T` + 33 base58 chars; Ethereum `0x` + 40 hex (backend stores lowercase). Chain is auto-detected — never ask the user for it.
- Amounts are USDT numbers (6 decimals already applied). Timestamps are **milliseconds since epoch** unless the field is an ISO `createdAt`/`updatedAt`.
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
| `labels.view` / `labels.manage` / `labels.sync` | see labels / create, delete, import / run OFAC & Tether sync, import-url |
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
| GET | `/address/:addr?limit=200&deep=false` | `{ chain, address, balance, frozen, totalIn, totalOut, txCount, truncated, firstSeen, lastSeen, risk: Assessment, counterparties: [{ address, in, out, inCount, outCount, label: {name, category} \| null }], transfers: [{ hash, from, to, amount, timestamp }] }`. `truncated=true` → totals cover only the latest `txCount` transfers. **Default `limit=200` (one TronGrid page, ~2 s); max 2000.** **Phase 7A additions:** `coverage: { status: 'pending'\|'backfilling'\|'complete'\|'capped'\|'error', rowCount, newestTs, lastSyncAt } \| null` (null = wallet not in our index) and `lifetime: { in, out, inCount, outCount, counterparties, firstSeen, lastSeen } \| null` — **only non-null when `coverage.status = 'complete'`**, computed in SQL over the wallet's whole history (self-transfers excluded). `totalIn/totalOut/txCount/truncated` keep their old meaning (the returned window). `risk` is the *shallow* assessment (own labels, direct exposure, freeze check; `indirect` = 0) unless `deep=true`. The UI shows this at once, then loads `GET /risk/:addr` for the 2-hop result and offers "Load more history" (`limit=1000`, ~5 pages, 10–20 s on busy wallets). Balance, transfers and the freeze check run concurrently. |
| GET | `/address/:addr/report.csv` | CSV download (summary + all transfers) |
| GET | `/tx/:chain/:hash` | chain `tron`\|`eth` → `{ chain, hash, block, timestamp, success, transfers: [{ from, to, amount }] }` |
| GET | `/graph/:addr?depth=1&fanout=8&from=&to=&min=` | depth 1–3, fanout 1–15, from/to ISO date or ms, min USDT → `{ chain, nodes: [{ id, root?, expanded, in?, out?, label?, category? }], edges: [{ id, source, target, amount, count }] }`. Edge id = `source>target`. |
| GET | `/graph/:addr?…&transfers=true` | ✅ same, plus each edge gets `transfers: [{ hash, amount, timestamp }]` (newest first, max 50 per edge) so the UI can draw one link per transfer and label it with amount/date. Nodes also get `volume` (in+out within the window) for sizing. |
| GET | `/path?from=&to=&maxHops=4&fanout=10` | directed money path → `{ chain, found, path: string[], nodes, edges, expansions, limitReached }` |

`Assessment` = `{ chain, address, score, level, own, direct, indirect, reasons: string[], exposures: [{ address, name, category, weight, volume, share }], labels: [{ name, category, source, confidence }], frozen, transfersChecked }`

## Screening & labels (Phase 2) ✅

| Method | Path | Notes |
|---|---|---|
| GET | `/risk/:addr` | `Assessment` with 2-hop indirect exposure, scored on the latest 200 transfers (same page the address summary reads, so it is a cache hit) + the top 5 unflagged counterparties' latest 200 (fetched concurrently). 5–20 s cold. |
| POST | `/screen` | `{ name?, addresses?: string[] }` or `{ name?, csv: string }` (any cell that is an address), max 1000 → `{ id, total }`. Runs in background. |
| GET | `/screen` | latest 50 jobs `[{ id, name, status: queued\|running\|done\|failed, progress, total, createdAt, updatedAt, error }]` |
| GET | `/screen/:id` | `{ id, status, progress, total, error, rows: [{ chain, address, score, level, frozen, labels, reasons, error? }] }` — poll every 2–3 s while running |
| GET | `/screen/:id/csv` | CSV download |
| GET | `/labels?q=&category=&source=&page=0` | `{ rows: Label[], total, page, pageSize: 100 }` |
| GET | `/labels/status` | `{ counts: { ofac, tether, manual, import, cluster }, ofacLastSync, tetherLastSync, etherscanKey, categories: string[] }` |
| GET | `/labels/address/:addr` | `Label[]` for one address |
| POST | `/labels` | `{ address, name, category }` → manual label (org-private) |
| DELETE | `/labels/:id` | own org labels only (global OFAC/Tether → 403) |
| POST | `/labels/import` | `{ csv, dryRun: boolean }`; CSV columns `address,name,category[,confidence]`. dryRun → `{ total, valid, errors: [{ line, address, error }], preview }`; else `{ inserted, skipped }` |
| POST | `/labels/sync` | admin → `{ source: 'ofac' \| 'tether' }` (Tether full sync can take minutes) |

`Label` = `{ id, orgId (0 = global), chain, address, name, category, source: ofac|tether|manual|import|cluster, confidence, createdAt, updatedAt }`

## Monitoring (Phase 3) ✅

| Method | Path | Notes |
|---|---|---|
| GET | `/watchlists` | `[{ id, name, createdAt, items, rules, openAlerts }]` |
| POST | `/watchlists` | `{ name }` |
| GET | `/watchlists/:id` | `{ id, name, items: [{ id, chain, address, note, lastSeenTs, lastCheckedAt, _count: { alerts } }], rules: Rule[] }` |
| DELETE | `/watchlists/:id` | |
| POST | `/watchlists/:id/items` | `{ addresses?: string[], csv?: string, note? }` → `{ added, skipped }` |
| DELETE | `/watch-items/:id` | |
| POST | `/watchlists/:id/rules` | `{ type, params }`: `amount_over {amount}` · `flagged_counterparty {minWeight=50}` · `volume_spike {factor=5}` |
| PATCH | `/rules/:id` | `{ enabled?, params? }` |
| DELETE | `/rules/:id` | |
| GET | `/alerts?status=open&watchlistId=&page=0` | `{ rows: [Alert & { rule: { type }, watchItem: { note, watchlist: { id, name } } }], total, page, pageSize: 50 }` |
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
| POST | `/cases/:id/addresses` | `{ address, role: suspect\|victim\|exchange\|intermediary\|other, note? }` |
| PATCH | `/case-addresses/:id` | `{ role?, note? }` |
| DELETE | `/case-addresses/:id` | |
| POST | `/cases/:id/notes` | `{ body }` |
| DELETE | `/case-notes/:id` | |
| POST | `/cases/:id/files` | multipart field `file`, max 20 MB |
| GET | `/case-files/:id` | download |
| DELETE | `/case-files/:id` | |
| PUT | `/cases/:id/graph` | `{ elements: CytoscapeElementsJson, png: 'data:image/png;base64,…' }` (≤ 8 MB) |
| GET | `/cases/:id/timeline` | `[{ hash, from, to, amount, timestamp, hop }]` — USDT transfers between the case's addresses (+ saved graph nodes), oldest first; `hop` = distance from the first victim/suspect |
| GET | `/cases/:id/report` | `{ case, addresses: [CaseAddress & { risk: { score, level, reasons } }], timeline, totals: { transfers, volume }, generatedAt, generatedBy }` (for the printable report page; audited) |
| GET | `/cases/:id/transfers.csv` | timeline as CSV |

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
| GET | `/index/addresses?q=&status=&limit=50&offset=0` | `{ total, rows: [{ id, chain, address, status, reason: 'lookup'\|'watch'\|'case'\|'manual', rowCount, oldestTs, newestTs, lastSyncAt, error, createdAt }] }`, newest first; `q` = substring of the address |
| POST | `/index/addresses` | `{ address }` — add a wallet (reason `manual`) or re-queue a full backfill for a listed one; `409` while its backfill is running |
| POST | `/index/addresses/:addr/sync` | incremental sync now (only transfers at/after the newest stored); `409` unless status is `complete`/`capped`; `404` if not indexed |
| DELETE | `/index/addresses/:addr` | drops the coverage row (reads go back to the live API); stored transfers are kept; `409` while backfilling |

**Read-through rules** (`getTransfers(chain, addr, max, fresh, reason)`): wallet `complete` (or `capped` and `max` ≤ rows held) and synced within `INDEX_FRESH_SEC` → Postgres only. Covered but stale, or `fresh` (monitoring) → fetch only newer rows (`min_timestamp` on Tron, `startblock` on Ethereum), then Postgres. Anything else (unknown, `pending`, `backfilling`, `error`) → live API as before; the page is written through and, unless the caller is a graph/risk/attribution neighbour (`reason: 'graph'`), the wallet is queued for a background backfill (`INDEX_MAX_PER_ADDRESS`, default 50 000, then `capped` = newest N kept). With `INDEX_TAIL` on and the tailer within 3 min of real time, a wallet synced after the tailer started needs no API call even when `fresh`.

**Full-chain tailer** (`INDEX_TAIL=tron,eth`, off by default): Tron via TronGrid USDT `Transfer` events in 60 s windows kept 2 min behind real time (the confirmation floor), Ethereum via `ETH_RPC_URL` `eth_getLogs` (12 confirmations). Starts at "now"; older history comes from per-wallet backfills. The Ethereum paths are code-complete but not live-tested.

---

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
- **Attribution:** `POST /attribution/run` returns 400 with a clear message when there is no `exchange`-category label (no exchange addresses are shipped — import or add hot wallets). Cluster-source labels are never used as anchors. Suggestion rules: ≥ 90 % of the candidate's outflow goes to the hot wallet and ≥ 3 distinct depositors; confidence ≤ 0.9. Accepting creates an org label (`source=cluster`, category `exchange`) used by risk and graphs.
- **Not verified:** all Ethereum paths (no `ETHERSCAN_API_KEY`).
- **CSRF / request hygiene:** besides `SameSite=Lax`, every non-GET request must carry `Content-Type: application/json` (or `multipart/form-data` for uploads) — otherwise `415`; a request with `Sec-Fetch-Site: cross-site` or an `Origin` that is not the site's own host (or in `ALLOWED_ORIGINS`) gets `403`. Requests without an Origin (curl, API keys) pass. All API responses send `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. Ids above 2^31-1 return `400 Invalid id`.
