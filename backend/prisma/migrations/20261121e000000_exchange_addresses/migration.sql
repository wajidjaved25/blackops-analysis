-- CreateTable
CREATE TABLE "ExchangeSource" (
    "id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "listName" TEXT NOT NULL,
    "lastChecked" TIMESTAMP(3),
    "lastChanged" TIMESTAMP(3),
    "version" TEXT,
    "rowCounts" JSONB,
    "status" TEXT NOT NULL DEFAULT 'never',
    "error" TEXT,
    "seconds" DOUBLE PRECISION,
    "peakRssMb" INTEGER,
    CONSTRAINT "ExchangeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeAddress" (
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExchangeAddress_pkey" PRIMARY KEY ("chain","address","exchange")
);

CREATE INDEX "ExchangeAddress_sourceId_idx" ON "ExchangeAddress"("sourceId");

ALTER TABLE "ExchangeAddress" ADD CONSTRAINT "ExchangeAddress_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ExchangeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Binance hot/cold, Binance deposit (find-and-mark) and HTX labels now live in ExchangeAddress; the lists are re-downloaded by the daily job.
DELETE FROM "Label" WHERE "source" = 'official' AND "orgId" = 0
  AND ("name" LIKE 'Binance hot/cold wallet (proof-of-reserves%' OR "name" LIKE 'Binance deposit address (proof-of-reserves%' OR "name" LIKE 'HTX hot/cold wallet (proof-of-reserves list%');
-- Daily check state of the old Setting-based implementation
DELETE FROM "Setting" WHERE "key" IN ('exlist.Binance', 'exlist.HTX');
