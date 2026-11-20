-- CreateTable
CREATE TABLE "Transfer" (
    "id" BIGSERIAL NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'usdt',
    "hash" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "amount" DECIMAL(80,6) NOT NULL,
    "ts" BIGINT NOT NULL,
    "block" BIGINT,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexedAddress" (
    "id" SERIAL NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT NOT NULL DEFAULT 'lookup',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "oldestTs" BIGINT,
    "newestTs" BIGINT,
    "lastSyncAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexedAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexCursor" (
    "chain" TEXT NOT NULL,
    "cursor" BIGINT NOT NULL,
    "cursorTs" BIGINT NOT NULL,
    "since" BIGINT NOT NULL,
    "rowsTotal" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexCursor_pkey" PRIMARY KEY ("chain")
);

-- CreateIndex
CREATE INDEX "Transfer_chain_from_ts_idx" ON "Transfer"("chain", "from", "ts");

-- CreateIndex
CREATE INDEX "Transfer_chain_to_ts_idx" ON "Transfer"("chain", "to", "ts");

-- CreateIndex
CREATE INDEX "Transfer_chain_ts_idx" ON "Transfer"("chain", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_chain_asset_hash_from_to_amount_seq_key" ON "Transfer"("chain", "asset", "hash", "from", "to", "amount", "seq");

-- CreateIndex
CREATE INDEX "IndexedAddress_status_idx" ON "IndexedAddress"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedAddress_chain_address_key" ON "IndexedAddress"("chain", "address");
