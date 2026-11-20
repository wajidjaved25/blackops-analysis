-- CreateTable
CREATE TABLE "CaseTransaction" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "chain" TEXT,
    "hash" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "fileId" INTEGER,
    "rowNo" INTEGER,
    "claimedAt" TIMESTAMP(3),
    "coin" TEXT,
    "network" TEXT,
    "amount" DOUBLE PRECISION,
    "fee" DOUBLE PRECISION,
    "address" TEXT,
    "ref" TEXT,
    "raw" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "onFrom" TEXT,
    "onTo" TEXT,
    "onAmount" DOUBLE PRECISION,
    "onAsset" TEXT,
    "onAt" TIMESTAMP(3),
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseTransaction_caseId_status_idx" ON "CaseTransaction"("caseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CaseTransaction_caseId_chain_hash_key" ON "CaseTransaction"("caseId", "chain", "hash");

-- AddForeignKey
ALTER TABLE "CaseTransaction" ADD CONSTRAINT "CaseTransaction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseTransaction" ADD CONSTRAINT "CaseTransaction_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "CaseFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
