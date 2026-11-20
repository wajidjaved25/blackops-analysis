-- Phase 7B: more assets and chains.
-- Existing coverage rows were all built from USDT only, so they record assets = 'usdt'; the registry now also lists USDC
-- and the index re-queues those wallets to fetch just the missing asset.
ALTER TABLE "IndexedAddress" ADD COLUMN "assets" TEXT NOT NULL DEFAULT '';
ALTER TABLE "IndexedAddress" ADD COLUMN "retries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IndexedAddress" ADD COLUMN "retryAt" TIMESTAMP(3);
UPDATE "IndexedAddress" SET "assets" = 'usdt' WHERE "status" IN ('complete', 'capped');

ALTER TABLE "Alert" ADD COLUMN "asset" TEXT NOT NULL DEFAULT 'usdt';
