# Tracera

Chainalysis-style investigation, screening and monitoring for stablecoins (USDT, USDC) on **Tron**, **Ethereum** and **BNB Chain**.

- What we're building and why: [plan.md](plan.md)
- What to do next: [task.md](task.md)

## Layout

```
backend/   NestJS API on :4000 (all routes under /api)
frontend/  Next.js UI on :3000 (proxies /api/* to the backend)
```

## Prerequisites

- Node.js 20.12 or newer (developed on Node 24)
- An Etherscan API key for ERC20 lookups (free at https://etherscan.io/myapikey)
- Optional: a TronGrid API key for higher Tron rate limits (https://www.trongrid.io)

## Setup

```bash
cd backend
cp .env.example .env      # then fill in ETHERSCAN_API_KEY (and TRONGRID_API_KEY if you have one)
npm install

cd ../frontend
npm install
```

## Run (two terminals)

```bash
cd backend  && npm run dev     # API at http://localhost:4000/api
cd frontend && npm run dev     # UI  at http://localhost:3000
```

Check: http://localhost:4000/api/health returns `{"ok":true}`, and the home page shows "Backend: connected".

## Self-check

```bash
cd backend && npm run check
```

Builds the backend and runs `src/selfcheck.ts` (address detection, Tron address conversion, counterparty aggregation).

## Environment variables (backend/.env)

| Name | Required | Purpose |
|---|---|---|
| `ETHERSCAN_API_KEY` | For ERC20 | Ethereum USDT transfers, balances, freeze checks |
| `TRONGRID_API_KEY` | No | Raises Tron rate limits (calls are throttled harder without it) |
| `PORT` | No | API port, default 4000 |

Frontend: `API_URL` (default `http://localhost:4000`) sets where `/api/*` is proxied.
