-- AlterTable
ALTER TABLE "WatchItem" ADD COLUMN     "lastRiskAt" TIMESTAMP(3),
ADD COLUMN     "lastRiskLevel" TEXT,
ADD COLUMN     "lastRiskScore" INTEGER,
ADD COLUMN     "lastRiskState" JSONB;

-- CreateTable
CREATE TABLE "CaseGraph" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "remarks" TEXT NOT NULL DEFAULT '',
    "chain" TEXT NOT NULL DEFAULT 'tron',
    "rootAddress" TEXT,
    "depth" INTEGER,
    "filters" JSONB,
    "graphJson" JSONB NOT NULL,
    "graphPng" TEXT,
    "nodeCount" INTEGER NOT NULL DEFAULT 0,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseGraph_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseGraph_caseId_createdAt_idx" ON "CaseGraph"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "CaseGraph" ADD CONSTRAINT "CaseGraph_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration (9B): every case's single saved graph (Case.graphJson) becomes one named snapshot.
-- Case.graphJson / graphPng stay in place (no longer written or read) until a later cleanup migration.
-- Mirrors graphStats() in backend/src/timeline.ts: node/edge counts from { nodes, edges }, root = the node flagged root.
INSERT INTO "CaseGraph" ("caseId", "name", "remarks", "chain", "rootAddress", "graphJson", "graphPng", "nodeCount", "edgeCount", "createdById", "createdAt", "updatedAt")
SELECT c."id",
       'Saved graph (migrated)',
       '',
       COALESCE(NULLIF(c."graphJson"->>'chain', ''), 'tron'),
       CASE WHEN jsonb_typeof(c."graphJson"->'nodes') = 'array'
            THEN (SELECT n->'data'->>'id' FROM jsonb_array_elements(c."graphJson"->'nodes') n WHERE n->'data'->>'root' = 'true' LIMIT 1) END,
       c."graphJson",
       c."graphPng",
       CASE WHEN jsonb_typeof(c."graphJson"->'nodes') = 'array' THEN jsonb_array_length(c."graphJson"->'nodes') ELSE 0 END,
       CASE WHEN jsonb_typeof(c."graphJson"->'edges') = 'array' THEN jsonb_array_length(c."graphJson"->'edges') ELSE 0 END,
       c."createdById",
       c."updatedAt",
       c."updatedAt"
FROM "Case" c
WHERE c."graphJson" IS NOT NULL AND c."graphJson" <> 'null'::jsonb;
