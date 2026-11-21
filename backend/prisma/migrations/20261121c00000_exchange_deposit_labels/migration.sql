-- Phase 9C: a customer's deposit address at an exchange is not an exchange-owned wallet.
-- Statement-derived, cluster-inferred and proof-of-reserves "deposit address" labels become category exchange_deposit (weight 0, informational).
-- Exchange-owned hot/cold wallets keep category exchange. Data-only: no schema change.
UPDATE "Label" SET category = 'exchange_deposit'
WHERE category = 'exchange'
  AND (source IN ('statement', 'cluster') OR name LIKE 'Binance deposit address (proof-of-reserves%');
UPDATE "Label" SET name = regexp_replace(name, '^(.*) deposit address \(per exchange statement', '\1 customer deposit address (per exchange statement')
WHERE source = 'statement' AND name LIKE '% deposit address (per exchange statement%';
UPDATE "ClusterSuggestion" SET category = 'exchange_deposit' WHERE category = 'exchange';
