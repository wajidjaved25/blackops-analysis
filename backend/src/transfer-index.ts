import { Body, ConflictException, Controller, Delete, Get, Injectable, Logger, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { CurrentCtx, Perm } from './auth';
import { apiPages, apiTransfers, Chain, fetchJson, hexToTron, norm, Reason, setReadThrough, Transfer, tronGap, tronHeaders, upstream } from './chains';
import { audit, Ctx, Db } from './db';
import { planRead, Row, tailEnd, withSeq } from './index-rules';
import { Jobs } from './jobs';
import { found, int, parseAddr, str } from './util';

const MAX_PER_ADDRESS = () => Number(process.env.INDEX_MAX_PER_ADDRESS ?? 50_000);
const FRESH_MS = () => Number(process.env.INDEX_FRESH_SEC ?? 300) * 1000;
const TAIL_CHAINS = () => (process.env.INDEX_TAIL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TAIL_OK_LAG_MS = 180_000; // the tailer counts as "live" for wallet reads when it is at most this far behind
const TRON_WINDOW_MS = 60_000;
const TRON_CONFIRM_LAG_MS = 120_000; // TronGrid only_confirmed lags ~1 min; stay clear of it or late-confirmed rows would be skipped
const ETH_CONFIRMATIONS = 12;
const ETH_BATCH_BLOCKS = 100;
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ETH_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

@Injectable()
export class TransferIndex implements OnModuleInit {
  private log = new Logger('TransferIndex');
  private syncing = new Map<string, Promise<void>>();
  readonly reads = { db: 0, sync: 0, api: 0 };
  private samples: Record<string, { t: number; rows: number }[]> = { tron: [], eth: [] };

  constructor(
    private db: Db,
    private jobs: Jobs,
  ) {}

  async onModuleInit() {
    setReadThrough((c, a, max, fresh, reason) => this.read(c, a, max, fresh, reason));
    if (process.env.DISABLE_WORKERS === 'true') return;
    await this.db.indexedAddress.updateMany({ where: { status: 'backfilling' }, data: { status: 'pending' } }); // crash recovery
    this.jobs.every('index-backfill', 3000, async () => this.drain(), 8000);
    const tails = TAIL_CHAINS();
    if (tails.includes('tron')) this.jobs.every('index-tail-tron', 5000, () => this.tailTron(), 10_000);
    if (tails.includes('eth')) this.jobs.every('index-tail-eth', 5000, () => this.tailEth(), 10_000);
  }

  // ---------- storage ----------
  async store(chain: Chain, rows: Row[], seen = new Map<string, number>()): Promise<number> {
    let inserted = 0;
    const data = withSeq(rows, seen).map((r) => ({
      chain,
      asset: 'usdt',
      hash: r.hash,
      seq: r.seq,
      from: norm(r.from),
      to: norm(r.to),
      amount: r.amount,
      ts: BigInt(r.timestamp),
      block: r.block === undefined ? null : BigInt(r.block),
    }));
    for (let i = 0; i < data.length; i += 1000) inserted += (await this.db.transfer.createMany({ data: data.slice(i, i + 1000), skipDuplicates: true })).count;
    return inserted;
  }

  /** Newest `max` transfers of a wallet. Two index scans merged: far cheaper than OR + sort on a big table. */
  private async fromDb(chain: Chain, addr: string, max: number): Promise<Transfer[]> {
    const rows = await this.db.$queryRaw<{ hash: string; from: string; to: string; amount: number; ts: number; block: number | null }[]>`
      SELECT hash, "from", "to", amount::float8 AS amount, ts::float8 AS ts, block::float8 AS block FROM (
        (SELECT * FROM "Transfer" WHERE chain = ${chain} AND "from" = ${addr} ORDER BY ts DESC LIMIT ${max})
        UNION
        (SELECT * FROM "Transfer" WHERE chain = ${chain} AND "to" = ${addr} ORDER BY ts DESC LIMIT ${max})
      ) t ORDER BY ts DESC, hash, seq LIMIT ${max}`;
    return rows.map((r) => ({ hash: r.hash, from: r.from, to: r.to, amount: r.amount, timestamp: r.ts, ...(r.block === null ? {} : { block: r.block }) }));
  }

  private async measure(chain: Chain, addr: string) {
    const [r] = await this.db.$queryRaw<{ count: number; oldest: number | null; newest: number | null }[]>`
      SELECT count(*)::int AS count, min(ts)::float8 AS oldest, max(ts)::float8 AS newest FROM (
        SELECT ts FROM "Transfer" WHERE chain = ${chain} AND "from" = ${addr}
        UNION ALL SELECT ts FROM "Transfer" WHERE chain = ${chain} AND "to" = ${addr} AND "from" <> ${addr}
      ) t`;
    return r;
  }

  private async maxBlock(chain: Chain, addr: string): Promise<number | null> {
    const [r] = await this.db.$queryRaw<{ b: number | null }[]>`
      SELECT greatest(
        (SELECT max(block) FROM "Transfer" WHERE chain = ${chain} AND "from" = ${addr}),
        (SELECT max(block) FROM "Transfer" WHERE chain = ${chain} AND "to" = ${addr}))::float8 AS b`;
    return r.b;
  }

  coverage(chain: Chain, address: string) {
    return this.db.indexedAddress.findUnique({ where: { chain_address: { chain, address } } });
  }

  /** True lifetime totals from SQL (self-transfers excluded, like the counterparty view). */
  async lifetime(chain: Chain, addr: string) {
    const [r] = await this.db.$queryRaw<{ inn: number; out: number; in_count: number; out_count: number; cps: number; first: number | null; last: number | null }[]>`
      SELECT coalesce(sum(amount) FILTER (WHERE dir = 'in'), 0)::float8 AS inn, coalesce(sum(amount) FILTER (WHERE dir = 'out'), 0)::float8 AS out,
             count(*) FILTER (WHERE dir = 'in')::int AS in_count, count(*) FILTER (WHERE dir = 'out')::int AS out_count,
             count(DISTINCT other)::int AS cps, min(ts)::float8 AS first, max(ts)::float8 AS last
      FROM (
        SELECT 'out' AS dir, "to" AS other, amount, ts FROM "Transfer" WHERE chain = ${chain} AND "from" = ${addr} AND "to" <> ${addr}
        UNION ALL SELECT 'in', "from", amount, ts FROM "Transfer" WHERE chain = ${chain} AND "to" = ${addr} AND "from" <> ${addr}
      ) t`;
    return { in: r.inn, out: r.out, inCount: r.in_count, outCount: r.out_count, counterparties: r.cps, firstSeen: r.first, lastSeen: r.last };
  }

  // ---------- read-through (7.3) ----------
  async read(chain: Chain, addr: string, max: number, fresh: boolean, reason: Reason): Promise<Transfer[]> {
    addr = norm(addr);
    const cov = await this.coverage(chain, addr);
    let plan = planRead(cov, max, fresh, Date.now(), FRESH_MS());
    if (plan === 'sync-then-db' && TAIL_CHAINS().includes(chain)) {
      // Tailer is live and has run continuously since this wallet was last synced: Postgres already has everything newer.
      const c = await this.db.indexCursor.findUnique({ where: { chain } });
      if (c && Date.now() - Number(c.cursorTs) < TAIL_OK_LAG_MS && cov!.lastSyncAt && cov!.lastSyncAt.getTime() >= Number(c.since)) plan = 'db';
    }
    if (plan === 'api') {
      this.reads.api++;
      const rows = await apiTransfers(chain, addr, max, fresh);
      try {
        await this.store(chain, rows);
        // graph neighbours are written through but not queued: one depth-2 graph would otherwise queue ~70 backfills
        if (!cov && reason !== 'graph') await this.db.indexedAddress.createMany({ data: [{ chain, address: addr, reason }], skipDuplicates: true });
      } catch (e) {
        this.log.warn(`write-through for ${addr} failed: ${(e as Error).message}`);
      }
      return rows;
    }
    if (plan === 'sync-then-db') {
      this.reads.sync++;
      try {
        await this.syncOnce(cov!);
      } catch (e) {
        if (fresh) throw e; // monitoring must not baseline on stale data
        this.log.warn(`sync ${addr} failed, serving stored rows: ${(e as Error).message}`);
      }
    }
    this.reads.db++;
    return this.fromDb(chain, addr, max);
  }

  /** Fetches only rows newer than the stored newest (inclusive, so no tx is ever split); the unique key drops the overlap. */
  syncOnce(cov: { chain: string; address: string; newestTs: bigint | null }): Promise<void> {
    const key = `${cov.chain}:${cov.address}`;
    const p = this.syncing.get(key) ?? this.sync(cov).finally(() => this.syncing.delete(key));
    this.syncing.set(key, p);
    return p;
  }

  private async sync(cov: { chain: string; address: string; newestTs: bigint | null }) {
    const chain = cov.chain as Chain;
    const startedAt = new Date();
    const seen = new Map<string, number>();
    const minBlock = chain === 'eth' ? await this.maxBlock(chain, cov.address) : null;
    for await (const page of apiPages(chain, cov.address, { fresh: true, minTs: cov.newestTs ? Number(cov.newestTs) : undefined, minBlock: minBlock ?? undefined })) {
      await this.store(chain, page, seen);
    }
    await this.finish(chain, cov.address, startedAt);
  }

  /** Re-measures coverage from SQL; a complete wallet that outgrew the limit becomes capped. */
  private async finish(chain: Chain, address: string, at: Date, status?: string) {
    const m = await this.measure(chain, address);
    const cur = await this.coverage(chain, address);
    const next = status ?? (cur?.status === 'complete' && m.count > MAX_PER_ADDRESS() ? 'capped' : cur?.status);
    await this.db.indexedAddress.update({
      where: { chain_address: { chain, address } },
      data: { status: next, rowCount: m.count, oldestTs: m.oldest === null ? null : BigInt(m.oldest), newestTs: m.newest === null ? null : BigInt(m.newest), lastSyncAt: at, error: null },
    });
  }

  // ---------- backfill (7.2) ----------
  /** Up to 3 concurrent backfills (the host pool still limits real HTTP), so huge wallets cannot starve small ones; wallets someone asked for (manual/watch/case) go before plain lookups. */
  private active = 0;
  private drain() {
    while (this.active < 3) {
      this.active++;
      void this.worker().finally(() => this.active--);
    }
  }

  private async worker() {
    for (;;) {
      const [row] = await this.db.$queryRaw<{ chain: string; address: string }[]>`
        UPDATE "IndexedAddress" SET status = 'backfilling', error = NULL
        WHERE id = (SELECT id FROM "IndexedAddress" WHERE status = 'pending' ORDER BY (reason <> 'lookup') DESC, id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING chain, address`;
      if (!row) return;
      await this.backfill(row.chain as Chain, row.address);
    }
  }

  // ponytail: a failed backfill restarts from the newest page (rows are idempotent). Resume-by-cursor if wallets get huge.
  private async backfill(chain: Chain, address: string) {
    const startedAt = new Date();
    const seen = new Map<string, number>();
    const max = MAX_PER_ADDRESS();
    let n = 0;
    let capped = false;
    try {
      for await (const page of apiPages(chain, address)) {
        await this.store(chain, page, seen);
        n += page.length;
        await this.db.indexedAddress.update({ where: { chain_address: { chain, address } }, data: { rowCount: n } });
        if (n >= max) {
          capped = true;
          break;
        }
      }
      await this.finish(chain, address, startedAt, capped ? 'capped' : 'complete');
      this.log.log(`backfill ${chain}:${address} -> ${capped ? 'capped' : 'complete'} (${n} rows)`);
    } catch (e) {
      this.log.warn(`backfill ${address} failed: ${(e as Error).message}`);
      await this.db.indexedAddress.update({ where: { chain_address: { chain, address } }, data: { status: 'error', error: (e as Error).message.slice(0, 500) } });
    }
  }

  // ---------- full-chain tailer (7.6) ----------
  private async advance(chain: Chain, cursor: number, cursorTs: number, inserted: number) {
    const s = this.samples[chain];
    s.push({ t: Date.now(), rows: inserted });
    while (s.length && s[0].t < Date.now() - 300_000) s.shift();
    await this.db.indexCursor.update({ where: { chain }, data: { cursor: BigInt(cursor), cursorTs: BigInt(cursorTs), rowsTotal: { increment: inserted }, error: null } });
  }

  private async tailFail(chain: Chain, e: unknown) {
    this.log.warn(`tail ${chain}: ${(e as Error).message}`);
    await this.db.indexCursor.updateMany({ where: { chain }, data: { error: (e as Error).message.slice(0, 300) } });
  }

  /** Tron: USDT `Transfer` contract events in 60 s windows, oldest first. Starts at "now"; history comes from per-wallet backfills. */
  private async tailTron() {
    let cur = await this.db.indexCursor.findUnique({ where: { chain: 'tron' } });
    if (!cur) {
      const start = BigInt(Date.now() - TRON_CONFIRM_LAG_MS);
      cur = await this.db.indexCursor.create({ data: { chain: 'tron', cursor: start, cursorTs: start, since: start } });
    }
    let cursor = Number(cur.cursor);
    const deadline = Date.now() + 25_000;
    try {
      while (Date.now() < deadline) {
        const end = tailEnd(cursor, Date.now(), TRON_WINDOW_MS, TRON_CONFIRM_LAG_MS);
        if (end < cursor) return;
        const rows: Row[] = [];
        let url: string | undefined =
          `https://api.trongrid.io/v1/contracts/${TRON_USDT}/events?event_name=Transfer&only_confirmed=true&order_by=block_timestamp,asc&limit=200&min_block_timestamp=${cursor}&max_block_timestamp=${end}`;
        while (url) {
          const j = await fetchJson(url, { headers: tronHeaders() }, tronGap(), true);
          for (const e of j.data ?? []) {
            const r = e.result ?? {};
            const from = r.from ?? r['0'];
            const to = r.to ?? r['1'];
            const value = r.value ?? r['2'];
            if (!from || !to || value === undefined) continue;
            rows.push({ hash: e.transaction_id, from: hexToTron(from), to: hexToTron(to), amount: Number(value) / 1e6, timestamp: e.block_timestamp });
          }
          url = j.meta?.links?.next;
        }
        const inserted = await this.store('tron', rows); // whole window at once, so identical rows of one tx never straddle a page
        cursor = end + 1;
        await this.advance('tron', cursor, end, inserted);
      }
    } catch (e) {
      await this.tailFail('tron', e);
    }
  }

  /** Ethereum: eth_getLogs over ETH_RPC_URL in 100-block batches, 12 confirmations behind head. NOT live-tested (no RPC URL here). */
  private async tailEth() {
    const rpcUrl = process.env.ETH_RPC_URL;
    if (!rpcUrl) return;
    const rpc = async (method: string, params: unknown[]) => {
      const j = await fetchJson(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 100, true);
      if (j.error) throw new Error(`eth rpc ${method}: ${j.error.message}`);
      return j.result;
    };
    const blockTs = async (n: number) => Number((await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false])).timestamp) * 1000;
    const safeHead = async () => Number(await rpc('eth_blockNumber', [])) - ETH_CONFIRMATIONS;
    try {
      let cur = await this.db.indexCursor.findUnique({ where: { chain: 'eth' } });
      if (!cur) {
        const head = await safeHead();
        const ts = BigInt(await blockTs(head));
        cur = await this.db.indexCursor.create({ data: { chain: 'eth', cursor: BigInt(head), cursorTs: ts, since: ts } });
      }
      let from = Number(cur.cursor);
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const to = Math.min(from + ETH_BATCH_BLOCKS - 1, await safeHead());
        if (to < from) return;
        const logs: any[] = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: ETH_USDT, topics: [TRANSFER_TOPIC] }]);
        const ts = new Map<number, number>();
        for (const b of new Set(logs.map((l) => Number(l.blockNumber)))) ts.set(b, await blockTs(b));
        const rows: Row[] = logs
          .filter((l) => l.topics?.length === 3)
          .map((l) => ({ hash: l.transactionHash, from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40), amount: Number(BigInt(l.data)) / 1e6, timestamp: ts.get(Number(l.blockNumber))!, block: Number(l.blockNumber) }));
        const inserted = await this.store('eth', rows);
        from = to + 1;
        await this.advance('eth', from, await blockTs(to), inserted);
      }
    } catch (e) {
      await this.tailFail('eth', e);
    }
  }

  rowsPerMin(chain: string) {
    const s = this.samples[chain] ?? [];
    if (!s.length) return 0;
    const span = Math.max(60_000, Date.now() - s[0].t);
    return Math.round((s.reduce((a, x) => a + x.rows, 0) / span) * 60_000);
  }
}

@Controller('index')
export class IndexController {
  constructor(
    private db: Db,
    private idx: TransferIndex,
  ) {}

  @Perm('index.manage')
  @Get('status')
  async status() {
    const [est] = await this.db.$queryRaw<{ n: number }[]>`SELECT reltuples::float8 AS n FROM pg_class WHERE relname = 'Transfer'`;
    const approx = est.n >= 1_000_000; // count(*) on a huge table is slow; the planner estimate is plenty
    const count = approx ? Math.round(est.n) : await this.db.transfer.count();
    const groups = await this.db.indexedAddress.groupBy({ by: ['status'], _count: true });
    const cursors = await this.db.indexCursor.findMany();
    const enabled = TAIL_CHAINS();
    const tailer = ['tron', 'eth'].map((chain) => {
      const c = cursors.find((x) => x.chain === chain);
      return {
        chain,
        enabled: enabled.includes(chain),
        cursorTs: c ? Number(c.cursorTs) : null,
        lagMs: c ? Math.max(0, Date.now() - Number(c.cursorTs)) : null,
        rowsTotal: c ? Number(c.rowsTotal) : 0,
        rowsPerMin: this.idx.rowsPerMin(chain),
        error: c?.error ?? null,
        needs: chain === 'eth' && enabled.includes('eth') && !process.env.ETH_RPC_URL ? 'ETH_RPC_URL' : null,
      };
    });
    return {
      transfers: { count, approx },
      addresses: Object.fromEntries(groups.map((g) => [g.status, g._count])),
      tailer,
      reads: this.idx.reads,
      upstream: { calls: upstream.calls, byHost: upstream.byHost, recent: upstream.recent.slice(-100).reverse() },
      config: { maxPerAddress: MAX_PER_ADDRESS(), freshSec: FRESH_MS() / 1000 },
    };
  }

  @Perm('index.manage')
  @Get('addresses')
  async list(@Query('q') q?: string, @Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const where = { ...(q ? { address: { contains: q.trim() } } : {}), ...(status ? { status } : {}) };
    const [total, rows] = await Promise.all([
      this.db.indexedAddress.count({ where }),
      this.db.indexedAddress.findMany({ where, orderBy: { id: 'desc' }, take: int(limit, 50, 1, 200), skip: int(offset, 0, 0, 1_000_000) }),
    ]);
    const num = (b: bigint | null) => (b === null ? null : Number(b));
    return { total, rows: rows.map((r) => ({ ...r, oldestTs: num(r.oldestTs), newestTs: num(r.newestTs) })) };
  }

  /** Adds a wallet, or re-queues a full backfill for one that is already listed. */
  @Perm('index.manage')
  @Post('addresses')
  async add(@CurrentCtx() ctx: Ctx, @Body() b: any) {
    const { chain, addr } = parseAddr(str(b?.address, 'address', { max: 100 }));
    const cur = await this.idx.coverage(chain, addr);
    if (cur?.status === 'backfilling') throw new ConflictException('A backfill is already running for this wallet');
    await this.db.indexedAddress.upsert({
      where: { chain_address: { chain, address: addr } },
      create: { chain, address: addr, reason: 'manual' },
      update: { status: 'pending', error: null },
    });
    await audit(this.db, ctx, 'index.backfill', `${chain}:${addr}`);
    return { ok: true };
  }

  /** Incremental sync now: fetches only rows newer than the newest stored. */
  @Perm('index.manage')
  @Post('addresses/:addr/sync')
  async sync(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string) {
    const { chain, addr } = parseAddr(raw);
    const cov = found(await this.idx.coverage(chain, addr), 'Wallet is not in the index');
    if (cov.status !== 'complete' && cov.status !== 'capped') throw new ConflictException(`Wallet is ${cov.status}; only complete or capped wallets can be re-synced`);
    await this.idx.syncOnce(cov);
    await audit(this.db, ctx, 'index.sync', `${chain}:${addr}`);
    return { ok: true };
  }

  /** Drops the coverage row; stored transfers stay (other wallets' histories share them) but reads go back to the live API. */
  @Perm('index.manage')
  @Delete('addresses/:addr')
  async remove(@CurrentCtx() ctx: Ctx, @Param('addr') raw: string) {
    const { chain, addr } = parseAddr(raw);
    const cov = found(await this.idx.coverage(chain, addr), 'Wallet is not in the index');
    if (cov.status === 'backfilling') throw new ConflictException('A backfill is running for this wallet; try again when it finishes');
    await this.db.indexedAddress.delete({ where: { id: cov.id } });
    await audit(this.db, ctx, 'index.remove', `${chain}:${addr}`);
    return { ok: true };
  }
}
