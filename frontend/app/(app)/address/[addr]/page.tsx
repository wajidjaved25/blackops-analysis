'use client';
import { Download, ExternalLink, Eye, Network, Plus, Tag } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AddLabelModal, AddToCaseModal, WatchModal } from '@/components/AddressActions';
import { AssetChips, AssetTag, ChainChoice } from '@/components/Assets';
import { RequirePerm } from '@/components/Guard';
import { AddressLink, CategoryChip, RiskBadge, RiskGauge, TxLink } from '@/components/Risk';
import { Table } from '@/components/Table';
import { DailyBars, RadialHeatmap } from '@/components/charts';
import { Badge, Button, Card, CopyButton, DateTime, EmptyState, ErrorState, Field, Input, LinkButton, Notice, PageHeader, Segmented, Skeleton, SkeletonRows, Stat, Time } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { addrHref, Asset, AssetFilter, assetSym, Chain, chainName, chainQ, explorerAddr, money, num, resolveChain, TRON_USDC_NOTE } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface Label { name: string; category: string; source?: string; confidence?: number }
interface Assessment { score: number; level: string; own: number; direct: number; indirect: number; reasons: string[]; exposures: { address: string; name: string; category: string; weight: number; volume: number; share: number }[]; labels: Label[]; frozen: boolean; frozenBy: string[]; transfersChecked: number }
interface Cp { address: string; in: number; out: number; inCount: number; outCount: number; label: { name: string; category: string } | null }
interface Tr { hash: string; from: string; to: string; amount: number; asset: Asset; timestamp: number }
interface AssetInfo { asset: Asset; symbol: string; decimals: number; issuer: 'tether' | 'circle' | null; note: string | null }
interface Addr { chain: Chain; address: string; asset: AssetFilter; assets: AssetInfo[]; balances: Record<Asset, number>; frozenBy: string[]; frozenAssets: Record<Asset, boolean | null>; byAsset: Partial<Record<Asset, { in: number; out: number; count: number }>>; balance: number; frozen: boolean; totalIn: number; totalOut: number; txCount: number; truncated: boolean; firstSeen: number | null; lastSeen: number | null; risk: Assessment; counterparties: Cp[]; transfers: Tr[]; coverage: Coverage | null; lifetime: Lifetime | null }
interface Coverage { status: 'pending' | 'backfilling' | 'complete' | 'capped' | 'error'; assets: string; rowCount: number; newestTs: number | null; lastSyncAt: string | null }
interface Lifetime { in: number; out: number; inCount: number; outCount: number; counterparties: number; firstSeen: number | null; lastSeen: number | null }

/** 7.4: says how much of the wallet's history our own index holds, so nobody mistakes a window for the whole story. */
function CoverageBadge({ c, n }: { c: Coverage | null; n: number }) {
  if (c?.status === 'complete') return <Badge tone="good" title="Full history is stored in our own index (Postgres)">Fully indexed · {c.rowCount.toLocaleString()} transfers</Badge>;
  if (c?.status === 'capped') return <Badge tone="medium" title="Very large wallet: the newest transfers are indexed, older history is not">Index capped · newest {c.rowCount.toLocaleString()}</Badge>;
  if (c?.status === 'backfilling' || c?.status === 'pending') return <Badge tone="info" title="Full history is being downloaded into our index in the background">Indexing history…</Badge>;
  return <Badge tone="outline" title="Read live from the explorer API; not stored in our index">First {n.toLocaleString()} transfers (live API)</Badge>;
}

export default function AddressPage() {
  const { addr } = useParams<{ addr: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const { can } = useAuth();
  const chainHint = resolveChain(addr, sp.get('chain'));
  const valid = !!chainHint;
  const asset: AssetFilter = sp.get('asset') === 'usdt' || sp.get('asset') === 'usdc' ? (sp.get('asset') as Asset) : 'all';
  const q = [chainQ(chainHint), `asset=${asset}`].filter(Boolean).join('&');
  const setView = (c: Chain, a: AssetFilter) => router.replace(addrHref(addr, c, a)); // chain + asset live in the URL, so a view can be shared
  const [full, setFull] = useState(false);
  // Summary first (latest 200 transfers, ~2 s); the 2-hop risk and the full history load afterwards.
  const { data: d, loading, error, status, reload } = useApi<Addr>(valid ? `/address/${addr}?limit=${full ? 1000 : 200}&${q}` : null);
  const deep = useApi<Assessment>(valid ? `/risk/${addr}?${q}` : null);
  const risk = deep.data ?? d?.risk;
  const [modal, setModal] = useState<'case' | 'watch' | 'label' | null>(null);
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all');
  const unit = asset === 'all' ? 'USD' : assetSym(asset);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const transfers = useMemo(() => {
    if (!d) return [];
    const f = from ? Date.parse(from) : 0, t = to ? Date.parse(to) + 864e5 : Infinity;
    return d.transfers.filter((x) => (dir === 'all' || (dir === 'in' ? x.to === d.address : x.from === d.address)) && x.timestamp >= f && x.timestamp < t);
  }, [d, dir, from, to]);

  if (!valid) return <div className="page"><ErrorState error="That is not a valid Tron or Ethereum address." /></div>;

  return (
    <RequirePerm perm="investigate.view">
      <div className="page stack" style={{ gap: 20 }}>
        <PageHeader crumbs={[{ label: 'Investigate', href: '/graph' }, { label: 'Address' }]}
          title={<span className="row" style={{ gap: 10 }}>Address {d && <Badge tone="outline">{chainName(d.chain)}</Badge>}{d?.frozenBy.map((i) => <Badge key={i} tone="severe">Frozen by {i}</Badge>)}{d && d.frozen && !d.frozenBy.length && <Badge tone="severe">Frozen</Badge>}{d && <CoverageBadge c={d.coverage} n={d.txCount} />}</span>}
          sub={<span className="row nw" style={{ gap: 6 }}><code className="break" title={addr}>{addr}</code><CopyButton value={addr} label="Copy address" />{d && <a href={explorerAddr(d.chain, addr)} target="_blank" rel="noreferrer" aria-label="Open in block explorer" title="Open in block explorer"><ExternalLink size={14} /></a>}</span>}
          actions={<>
            <LinkButton href={`/graph?addr=${addr}${chainQ(chainHint) ? `&${chainQ(chainHint)}` : ''}${asset !== 'all' ? `&asset=${asset}` : ''}`} variant="primary"><Network size={15} />Open in graph</LinkButton>
            <Button disabled={!can('cases.manage')} title={can('cases.manage') ? '' : 'Requires cases.manage'} onClick={() => setModal('case')}><Plus size={15} />Add to case</Button>
            <Button disabled={!can('monitor.manage')} title={can('monitor.manage') ? '' : 'Requires monitor.manage'} onClick={() => setModal('watch')}><Eye size={15} />Watch</Button>
            <Button disabled={!can('labels.manage')} title={can('labels.manage') ? '' : 'Requires labels.manage'} onClick={() => setModal('label')}><Tag size={15} />Add label</Button>
            {can('export.data') ? <a className="btn" href={`/api/address/${addr}/report.csv?${q}`} download><Download size={15} />Export CSV</a> : <Button disabled title="Requires export.data"><Download size={15} />Export CSV</Button>}
          </>} />

        <div className="row" style={{ gap: 14 }}>
          <ChainChoice addr={addr} value={chainHint ?? 'eth'} onChange={(c) => setView(c, asset)} />
          <AssetChips value={asset} onChange={(a) => setView(chainHint ?? 'eth', a)} />
          <span className="xs muted">USDT and USDC are both ≈ 1 USD, so mixed volumes are added and shown in USD.</span>
        </div>
        {chainHint === 'tron' && asset !== 'usdt' && <Notice>{TRON_USDC_NOTE}</Notice>}

        {loading && !d && (
          <div className="stack" role="status" aria-label="Loading address data">
            <Notice>Reading the chain, this can take 5–15 seconds for busy wallets…</Notice>
            <div className="kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="card stat"><Skeleton w={90} /><Skeleton h={26} w={120} /></div>)}</div>
            <div className="card"><SkeletonRows rows={6} /></div>
          </div>
        )}
        {error && <div className="card"><ErrorState error={error} status={status} onRetry={reload} /></div>}

        {d && (
          <>
            {d.truncated && (
              <Notice tone="warn">
                <span className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
                  <span>{d.lifetime ? 'Lifetime totals above come from the full index; counterparties and charts cover only the latest' : 'Totals, counterparties and charts cover only the latest'} {d.txCount.toLocaleString()} transfers{full ? ' (the maximum shown here)' : ', not the full history'}.</span>
                  {!full && <Button sm onClick={() => setFull(true)} disabled={loading}>{loading ? 'Loading…' : 'Load more history (up to 1,000)'}</Button>}
                </span>
              </Notice>
            )}
            <div className="grid g-main">
              <Card title="Risk assessment" actions={deep.loading ? <span className="muted small" role="status">Checking 2-hop exposure…</span> : deep.error ? <span className="muted small">2-hop check unavailable</span> : undefined}>
                <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
                  <div className="stack sm" style={{ alignItems: 'center' }}><RiskGauge score={risk!.score} level={risk!.level} /><RiskBadge level={risk!.level} /></div>
                  <div className="stack grow" style={{ minWidth: 220 }}>
                    <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <dt>Own</dt><dd className="num" style={{ textAlign: 'left' }}>{risk!.own}</dd>
                      <dt>Direct exposure</dt><dd>{risk!.direct}</dd>
                      <dt>Indirect exposure</dt><dd>{deep.data ? risk!.indirect : <span className="muted">{deep.loading ? 'checking…' : 'n/a'}</span>}</dd>
                      <dt>Labels</dt><dd className="row">{risk!.labels.length ? risk!.labels.map((l, i) => <CategoryChip key={i} category={l.category} name={l.name} />) : <span className="muted">None</span>}</dd>
                    </dl>
                    <ul className="reasons">
                      {risk!.reasons.length ? risk!.reasons.map((r, i) => <li key={i}><span className="dot" style={{ background: 'var(--medium)', marginTop: 7 }} />{r}</li>) : <li className="muted">No risk indicators found in the transfers checked.</li>}
                    </ul>
                  </div>
                </div>
              </Card>
              <Card title="Exposures" flush>
                {risk!.exposures.length ? (
                  <Table caption="Risk exposures" rows={risk!.exposures} rowKey={(e) => e.address} pageSize={6} cols={[
                    { key: 'a', header: 'Counterparty', cell: (e) => <AddressLink address={e.address} label={{ name: e.name, category: e.category }} /> , wrap: true },
                    { key: 'w', header: 'Weight', num: true, sort: (e) => e.weight, cell: (e) => e.weight },
                    { key: 's', header: 'Share', num: true, sort: (e) => e.share, cell: (e) => `${(e.share * 100).toFixed(1)}%` },
                  ]} />
                ) : <EmptyState title="No risky exposure">No flagged counterparties were found.</EmptyState>}
              </Card>
            </div>

            <div className="kpis">
              <Stat label="Balance" value={money(d.balance, asset === 'all' ? undefined : asset)} sub={asset === 'all' ? d.assets.map((a) => `${num(d.balances[a.asset])} ${a.symbol}`).join(' · ') : undefined} />
              <Stat label="Total received" value={money(d.lifetime?.in ?? d.totalIn, asset === 'all' ? undefined : asset)} sub={d.lifetime && <>lifetime · {d.lifetime.inCount.toLocaleString()} in</>} />
              <Stat label="Total sent" value={money(d.lifetime?.out ?? d.totalOut, asset === 'all' ? undefined : asset)} sub={d.lifetime && <>lifetime · {d.lifetime.outCount.toLocaleString()} out</>} />
              <Stat label="Transfers" value={(d.lifetime ? d.lifetime.inCount + d.lifetime.outCount : d.txCount).toLocaleString()} sub={d.lifetime ? <>lifetime · {d.lifetime.counterparties.toLocaleString()} counterparties</> : d.truncated ? 'latest window' : 'all time'} />
              <Stat label="First seen" value={<span style={{ fontSize: 16 }}><DateTime t={d.lifetime?.firstSeen ?? d.firstSeen} /></span>} sub={<>Last: <Time t={d.lifetime?.lastSeen ?? d.lastSeen} /></>} />
            </div>

            <Card title="Assets" flush>
              <Table caption="Assets" rows={d.assets} rowKey={(a) => a.asset} pageSize={5}
                cols={[
                  { key: 'a', header: 'Asset', cell: (a) => <span className="row" style={{ gap: 8 }}><AssetTag asset={a.asset} />{a.note && <span className="xs muted" title={a.note}>issuer support ended</span>}</span> },
                  { key: 'b', header: 'Balance', num: true, sort: (a) => d.balances[a.asset], cell: (a) => money(d.balances[a.asset], a.asset) },
                  { key: 'i', header: 'Received (window)', num: true, sort: (a) => d.byAsset[a.asset]?.in ?? 0, cell: (a) => money(d.byAsset[a.asset]?.in ?? 0, a.asset) },
                  { key: 'o', header: 'Sent (window)', num: true, sort: (a) => d.byAsset[a.asset]?.out ?? 0, cell: (a) => money(d.byAsset[a.asset]?.out ?? 0, a.asset) },
                  { key: 'n', header: 'Transfers', num: true, sort: (a) => d.byAsset[a.asset]?.count ?? 0, cell: (a) => (d.byAsset[a.asset]?.count ?? 0).toLocaleString() },
                  { key: 'f', header: 'Issuer freeze', cell: (a) => {
                    const f = d.frozenAssets[a.asset];
                    return f === null ? <span className="muted" title="Bridge-issued token: no issuer blacklist exists on this chain">Not applicable</span> : f ? <Badge tone="severe">Frozen by {a.issuer === 'circle' ? 'Circle' : 'Tether'}</Badge> : <Badge tone="good">Not frozen</Badge>;
                  } },
                ]} />
            </Card>

            <div className="grid g2">
              <Card title="Activity"><RadialHeatmap transfers={d.transfers} /></Card>
              <Card title="Daily volume"><DailyBars transfers={d.transfers} address={d.address} /></Card>
            </div>

            <Card title="Counterparties" flush>
              <Table caption="Counterparties" rows={d.counterparties} rowKey={(c) => c.address} pageSize={10} initialSort={{ key: 'tot', dir: 'desc' }}
                empty={<EmptyState title="No counterparties">This wallet has no {asset === 'all' ? 'USDT or USDC' : assetSym(asset)} transfers.</EmptyState>}
                cols={[
                  { key: 'a', header: 'Address', wrap: true, cell: (c) => <AddressLink address={c.address} label={c.label} chain={d.chain} /> },
                  { key: 'in', header: 'Received from', num: true, sort: (c) => c.in, cell: (c) => <>{num(c.in)} <span className="faint xs">({c.inCount})</span></> },
                  { key: 'out', header: 'Sent to', num: true, sort: (c) => c.out, cell: (c) => <>{num(c.out)} <span className="faint xs">({c.outCount})</span></> },
                  { key: 'tot', header: `Total (${unit})`, num: true, sort: (c) => c.in + c.out, cell: (c) => num(c.in + c.out) },
                  { key: 'g', header: '', cell: (c) => <LinkButton sm variant="ghost" href={`/graph?addr=${c.address}${d.chain === 'bsc' ? '&chain=bsc' : ''}${asset !== 'all' ? `&asset=${asset}` : ''}`}><Network size={13} /></LinkButton> },
                ]} />
            </Card>

            <Card title="Transfers" flush actions={
              <div className="row">
                <Segmented label="Direction" value={dir} onChange={setDir} options={[{ id: 'all', label: 'All' }, { id: 'in', label: 'In' }, { id: 'out', label: 'Out' }]} />
                <Field><Input sm type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field><Input sm type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              </div>}>
              <Table caption="Transfers" rows={transfers} rowKey={(t) => t.asset + t.hash + t.from + t.to + t.amount} pageSize={25} initialSort={{ key: 't', dir: 'desc' }}
                empty={<EmptyState title="No transfers match">Adjust the direction or date filters.</EmptyState>}
                cols={[
                  { key: 't', header: 'Time', sort: (t) => t.timestamp, cell: (t) => <DateTime t={t.timestamp} /> },
                  { key: 'd', header: 'Dir', cell: (t) => (t.to === d.address ? <Badge tone="good">IN</Badge> : <Badge tone="high">OUT</Badge>) },
                  { key: 'f', header: 'From', cell: (t) => (t.from === d.address ? <span className="muted mono small">this wallet</span> : <AddressLink address={t.from} chain={d.chain} />) },
                  { key: 'to', header: 'To', cell: (t) => (t.to === d.address ? <span className="muted mono small">this wallet</span> : <AddressLink address={t.to} chain={d.chain} />) },
                  { key: 's', header: 'Asset', sort: (t) => t.asset, cell: (t) => <AssetTag asset={t.asset} /> },
                  { key: 'a', header: 'Amount', num: true, sort: (t) => t.amount, cell: (t) => money(t.amount, t.asset) },
                  { key: 'h', header: 'Tx', cell: (t) => <TxLink hash={t.hash} chain={d.chain} /> },
                ]} />
            </Card>
          </>
        )}
        {modal === 'case' && <AddToCaseModal address={addr} chain={chainHint ?? undefined} onClose={() => setModal(null)} />}
        {modal === 'watch' && <WatchModal address={addr} chain={chainHint ?? undefined} onClose={() => setModal(null)} />}
        {modal === 'label' && <AddLabelModal address={addr} onClose={() => setModal(null)} onDone={reload} />}
      </div>
    </RequirePerm>
  );
}
