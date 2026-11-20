// Run: npm run check — fails loudly if core logic breaks. No network calls.
import assert from 'node:assert/strict';
import { assetByContract, ASSETS, CHAINS, CIRCLE, parseUnits, REGISTRY, selectAssets, TETHER } from './assets';
import { detectChain, flows, FrozenMap, frozenBy, hexToTron, isTxHash, norm, parseFreezeLog, Transfer, tronToHex20 } from './chains';
import { buildGraph, findPath } from './graph';
import { level, scoreRisk } from './risk-score';
import { clusterConfidence, depositEvidence } from './cluster';
import { withVolumes } from './graph';
import { planRead, retryDelayMs, splitBoundary, tailEnd, withSeq } from './index-rules';
import { evaluateRules, ruleParams } from './monitor-rules';
import { ALL_PERMS, hasAny, missing, PERMISSIONS, SYSTEM_ROLES } from './permissions';
import { graphAddresses, pickSources, timelineHops } from './timeline';
import { base32, newRecoveryCodes, openSecret, recoveryHash, sealSecret, totp, unbase32, verifyTotp } from './totp';
import { assetParam, parseAddr, parseCsv, privateIp, toCsv } from './util';

async function main() {
  // --- address handling ---
  assert.equal(detectChain('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), 'tron');
  assert.equal(detectChain('0xdAC17F958D2ee523a2206206994597C13D831ec7'), 'eth');
  assert.equal(detectChain('0xdAC17F958D2ee523a2206206994597C13D831ec'), null); // too short
  assert.equal(detectChain('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60'), null); // '0' not base58
  assert.equal(detectChain('hello'), null);
  // USDT TRC20 contract, known hex form 41a614f803b6fd780986a42c78ec9c7f77e6ded13c
  assert.equal(tronToHex20('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), 'a614f803b6fd780986a42c78ec9c7f77e6ded13c');
  assert.equal(hexToTron('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert.equal(hexToTron('000000000000000000000000a614f803b6fd780986a42c78ec9c7f77e6ded13c'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'); // 32-byte log topic
  assert.equal(norm('0xABC'), '0xabc');
  assert.equal(norm('TAbc'), 'TAbc');
  assert.ok(isTxHash('tron', 'a'.repeat(64)));
  assert.ok(!isTxHash('tron', '0x' + 'a'.repeat(64)));
  assert.ok(isTxHash('eth', '0x' + 'a'.repeat(64)));

  // --- counterparty aggregation ---
  const me = '0xAAAA000000000000000000000000000000000000';
  const B = '0xbbbb000000000000000000000000000000000000';
  const C = '0xcccc000000000000000000000000000000000000';
  const m = me.toLowerCase();
  const f = flows(me, [
    { asset: 'usdt' as const, hash: '1', from: B, to: m, amount: 100, timestamp: 1 },
    { asset: 'usdt' as const, hash: '2', from: m, to: B, amount: 40, timestamp: 2 },
    { asset: 'usdt' as const, hash: '3', from: m, to: C, amount: 500, timestamp: 3 },
    { asset: 'usdt' as const, hash: '4', from: m, to: m, amount: 9, timestamp: 4 }, // self-transfer ignored
  ]);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { address: C, in: 0, out: 500, inCount: 0, outCount: 1 });
  assert.deepEqual(f[1], { address: B, in: 100, out: 40, inCount: 1, outCount: 1 });

  // --- graph + path on a fake ledger: A->B->C->D, A->E, X->D ---
  const t = (from: string, to: string, amount: number): Transfer => ({ asset: 'usdt' as const, hash: from + to, from, to, amount, timestamp: 0 });
  const ledger = [t('A', 'B', 50), t('B', 'C', 40), t('C', 'D', 30), t('A', 'E', 10), t('X', 'D', 5)];
  let calls = 0;
  const getFlows = async (a: string) => {
    calls++;
    return flows(a, ledger.filter((x) => x.from === a || x.to === a));
  };

  const g1 = await buildGraph('A', 1, 8, getFlows);
  assert.deepEqual(g1.nodes.map((n) => n.id).sort(), ['A', 'B', 'E']);
  assert.deepEqual(g1.edges.map((e) => e.id).sort(), ['A>B', 'A>E']);
  assert.equal(g1.nodes.find((n) => n.id === 'A')!.out, 60);
  const g2 = await buildGraph('A', 2, 8, getFlows);
  assert.ok(g2.nodes.some((n) => n.id === 'C'));
  assert.equal(g2.nodes.filter((n) => n.id === 'A').length, 1); // A seen again from B, not duplicated
  const g3 = await buildGraph('A', 1, 1, getFlows); // fanout 1 keeps only top-volume counterparty
  assert.deepEqual(g3.edges.map((e) => e.id), ['A>B']);

  const p = await findPath('A', 'D', 4, 10, getFlows);
  assert.ok(p.found);
  assert.deepEqual(p.path, ['A', 'B', 'C', 'D']);
  assert.deepEqual(p.edges.map((e) => [e.id, e.amount]), [['A>B', 50], ['B>C', 40], ['C>D', 30]]);
  assert.equal((await findPath('D', 'A', 4, 10, getFlows)).found, false); // money flow is directed
  assert.equal((await findPath('A', 'D', 2, 10, getFlows)).found, false); // needs 3 hops
  calls = 0;
  const capped = await findPath('A', 'D', 6, 10, getFlows, 1);
  assert.ok(!capped.found && capped.limitReached && calls === 1); // expansion cap respected

  // --- risk scoring (plan.md §5) ---
  const fl = (address: string, vol: number) => ({ address, in: vol, out: 0, inCount: 1, outCount: 0 });
  const labels: Record<string, { name: string; category: string }[]> = {
    SCAM: [{ name: 'Pig-butchering ring', category: 'scam' }],
    EXCH: [{ name: 'Big Exchange', category: 'exchange' }],
    BAD: [{ name: 'Mixer', category: 'mixer' }, { name: 'OFAC SDN list', category: 'sanctioned' }],
  };
  const labelsOf = (a: string) => labels[a] ?? [];
  const clean = scoreRisk({ own: [], frozen: false, flows: [fl('X', 100), fl('Y', 50)], labelsOf });
  assert.equal(clean.score, 0);
  assert.equal(clean.level, 'low');
  assert.equal(scoreRisk({ own: [{ name: 'OFAC SDN list', category: 'sanctioned' }], frozen: false, flows: [], labelsOf }).score, 100);
  assert.equal(scoreRisk({ own: [], frozen: true, flows: [], labelsOf }).level, 'severe');
  const tenPct = scoreRisk({ own: [], frozen: false, flows: [fl('SCAM', 10), fl('X', 90)], labelsOf });
  assert.equal(tenPct.score, 9); // 90 weight × 10 % volume
  assert.ok(tenPct.reasons[0].includes('SCAM'));
  assert.equal(scoreRisk({ own: [], frozen: false, flows: [fl('EXCH', 100)], labelsOf }).score, 0); // exchanges are informational
  assert.equal(scoreRisk({ own: [], frozen: false, flows: [fl('BAD', 50), fl('X', 50)], labelsOf }).score, 50); // highest label wins: 100 × 50 %
  const ind = scoreRisk({ own: [], frozen: false, flows: [fl('X', 100)], labelsOf, indirect: [{ address: 'X', share: 1, directScore: 60 }] });
  assert.equal(ind.score, 30); // 60 × 100 % × 0.5 discount
  assert.equal(level(75), 'severe');
  assert.equal(level(40), 'high');
  assert.equal(level(15), 'medium');
  assert.equal(level(14.9), 'low');

  // --- CSV ---
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.equal(toCsv([['=cmd()', -5, 'ok']]), `"'=cmd()","-5","ok"\r\n`); // formula injection neutralised, numbers kept

  // --- link-chart transfers (?transfers=true) ---
  const many = Array.from({ length: 60 }, (_, i) => ({ asset: 'usdt' as const, hash: `h${i}`, from: 'A', to: 'B', amount: 1, timestamp: i }));
  const plain = flows('A', many);
  assert.ok(!('outTransfers' in plain[0])); // default shape unchanged
  const withT = flows('A', [...many, { asset: 'usdt' as const, hash: 'in', from: 'B', to: 'A', amount: 7, timestamp: 5 }], true);
  assert.equal(withT[0].outTransfers!.length, 50); // capped at 50 per edge
  assert.equal(withT[0].outTransfers![0].hash, 'h59'); // newest first
  assert.deepEqual(withT[0].inTransfers, [{ asset: 'usdt' as const, hash: 'in', amount: 7, timestamp: 5 }]);
  const ledgerT = [...many, t('B', 'C', 5)];
  const gT = await buildGraph('A', 1, 8, async (a) => flows(a, ledgerT.filter((x) => x.from === a || x.to === a), true));
  assert.equal(gT.edges.find((e) => e.id === 'A>B')!.transfers!.length, 50);
  assert.ok(!('transfers' in (await buildGraph('A', 1, 8, getFlows)).edges[0]));
  const vol = withVolumes(gT.nodes, gT.edges);
  assert.equal(vol.find((n) => n.id === 'A')!.volume, 60); // expanded: in + out
  assert.equal(vol.find((n) => n.id === 'B')!.volume, 60); // not expanded: sum of its edges

  // --- permissions / roles ---
  const role = (n: string) => SYSTEM_ROLES.find((r) => r.name === n)!.permissions;
  assert.ok(SYSTEM_ROLES.every((r) => r.permissions.every((p) => ALL_PERMS.includes(p))));
  assert.equal(role('Owner').length, PERMISSIONS.length);
  assert.deepEqual(missing(role('Owner'), role('Admin')), []);
  assert.deepEqual(missing(role('Admin'), role('Owner')), ['org.manage']); // Admin cannot grant org.manage
  assert.ok(hasAny(role('Viewer'), ['investigate.view']));
  assert.ok(!hasAny(role('Viewer'), ['labels.manage', 'cases.manage', 'export.data']));
  assert.ok(!hasAny(role('Analyst'), ['users.manage', 'roles.manage', 'cases.delete', 'org.manage']));
  assert.ok(hasAny(role('Analyst'), ['users.manage', 'alerts.triage'])); // any-of semantics
  assert.deepEqual(missing(role('Viewer'), ['cases.view', 'cases.delete']), ['cases.delete']);

  // --- TOTP: RFC 6238 Appendix B vectors ---
  const k1 = Buffer.from('12345678901234567890');
  const k256 = Buffer.from('12345678901234567890123456789012');
  const k512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
  for (const [sec, code] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']] as const) {
    assert.equal(totp(k1, sec * 1000, 8), code);
  }
  assert.equal(totp(k256, 59_000, 8, 'sha256'), '46119246');
  assert.equal(totp(k512, 59_000, 8, 'sha512'), '90693936');
  const b32 = base32(k1);
  assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'); // the secret authenticator apps scan
  assert.deepEqual(unbase32(b32), k1);
  const now = 1_700_000_000_000;
  const at = (ms: number) => totp(k1, ms, 6);
  assert.ok(verifyTotp(b32, at(now), now) !== null);
  assert.ok(verifyTotp(b32, at(now - 30_000), now) !== null); // +-1 step tolerated
  assert.ok(verifyTotp(b32, at(now + 30_000), now) !== null);
  assert.equal(verifyTotp(b32, at(now - 90_000), now), null); // 3 steps old
  assert.equal(verifyTotp(b32, '12345', now), null);
  const step = verifyTotp(b32, at(now), now)!;
  assert.equal(verifyTotp(b32, at(now), now, step), null); // a used code cannot be replayed
  const rc = newRecoveryCodes();
  assert.equal(rc.codes.length, 10);
  assert.ok(rc.hashes.includes(recoveryHash(rc.codes[3].toUpperCase())));
  process.env.APP_SECRET = 'test-secret';
  assert.ok(sealSecret(b32).startsWith('enc:') && openSecret(sealSecret(b32)) === b32);
  delete process.env.APP_SECRET;
  assert.equal(openSecret(sealSecret(b32)), b32); // plain fallback

  // --- monitor rules: each fires on a crafted transfer, stays silent on a clean one ---
  const ME = 'TMe';
  const hr = 3_600_000;
  const nowMs = 1_700_000_000_000;
  const small = { asset: 'usdt' as const, hash: 's1', from: 'TOther', to: ME, amount: 10, timestamp: nowMs - 1000 };
  const big = { asset: 'usdt' as const, hash: 'b1', from: ME, to: 'TOther', amount: 5000, timestamp: nowMs - 1000 };
  const noLabels = () => [];
  const rule = (type: string, params: object) => [{ id: 1, type, params }];
  const amt = rule('amount_over', { amount: 1000 });
  assert.equal(evaluateRules(amt, ME, [big], [big], noLabels, nowMs)[0].dedupKey, 'b1');
  assert.equal(evaluateRules(amt, ME, [small], [small], noLabels, nowMs).length, 0);
  const flag = rule('flagged_counterparty', { minWeight: 50 });
  const lab = (a: string) => (a === 'TScam' ? [{ name: 'Ring', category: 'scam' }] : a === 'TEx' ? [{ name: 'Ex', category: 'exchange' }] : []);
  const fromScam = { ...small, hash: 'f1', from: 'TScam' };
  assert.match(evaluateRules(flag, ME, [fromScam], [fromScam], lab, nowMs)[0].detail, /scam/);
  assert.equal(evaluateRules(flag, ME, [small], [small], lab, nowMs).length, 0); // unlabelled counterparty
  assert.equal(evaluateRules(flag, ME, [{ ...small, from: 'TEx' }], [], lab, nowMs).length, 0); // exchange weight 0 < 50
  const spike = rule('volume_spike', { factor: 5 });
  const old = { asset: 'usdt' as const, hash: 'o1', from: 'TOther', to: ME, amount: 100, timestamp: nowMs - 10 * hr };
  const burst = { asset: 'usdt' as const, hash: 'p1', from: 'TOther', to: ME, amount: 1000, timestamp: nowMs - 1000 };
  assert.equal(evaluateRules(spike, ME, [burst], [old, burst], noLabels, nowMs).length, 1);
  const calm = { ...burst, amount: 5 };
  assert.equal(evaluateRules(spike, ME, [calm], [old, calm], noLabels, nowMs).length, 0);
  assert.equal(evaluateRules([...amt, ...flag, ...spike], ME, [], [old], lab, nowMs).length, 0); // nothing new, nothing fires

  // --- case timeline hops: S -> A -> B, plus an unrelated pair ---
  const tl = timelineHops(
    [{ asset: 'usdt' as const, hash: '2', from: 'A', to: 'B', amount: 1, timestamp: 20 }, { asset: 'usdt' as const, hash: '1', from: 'S', to: 'A', amount: 1, timestamp: 10 }, { asset: 'usdt' as const, hash: '3', from: 'X', to: 'Y', amount: 1, timestamp: 30 }, { asset: 'usdt' as const, hash: '4', from: 'Z', to: 'S', amount: 1, timestamp: 5 }],
    ['S'],
  );
  assert.deepEqual(tl.map((x) => [x.hash, x.hop]), [['4', 1], ['1', 1], ['2', 2], ['3', null]]); // oldest first; hop = distance from the source
  assert.deepEqual(pickSources([{ address: 'a', role: 'other' }, { address: 'b', role: 'suspect' }, { address: 'c', role: 'victim' }]), ['c']);
  assert.deepEqual(pickSources([{ address: 'a', role: 'other' }, { address: 'b', role: 'suspect' }]), ['b']);
  assert.deepEqual(graphAddresses({ nodes: [{ data: { id: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } }, { data: { id: 'not-an-address' } }], edges: [] }), ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t']);

  // --- deposit-address clustering heuristic ---
  const HOT = 'THot';
  const ct = (from: string, to: string, amount: number): Transfer => ({ asset: 'usdt' as const, hash: from + to + amount, from, to, amount, timestamp: 0 });
  const deposit = [ct('U1', 'TDep', 50), ct('U2', 'TDep', 30), ct('U3', 'TDep', 20), ct('TDep', HOT, 99), ct('TDep', 'TTip', 1)];
  const ev = depositEvidence('TDep', deposit, HOT)!;
  assert.deepEqual([ev.depositors, ev.outToHot, ev.totalOut], [3, 99, 100]);
  assert.ok(clusterConfidence(ev) > 0.5 && clusterConfidence(ev) <= 0.9);
  assert.equal(depositEvidence('TDep', [...deposit, ct('TDep', 'TElse', 20)], HOT), null); // only 99/120 forwarded to the hot wallet
  assert.equal(depositEvidence('TDep', deposit.slice(0, 2).concat(deposit.slice(3)), HOT), null); // only 2 depositors
  assert.equal(depositEvidence('TDep', [ct('U1', 'TDep', 5), ct('U2', 'TDep', 5), ct('U3', 'TDep', 5)], HOT), null); // never forwards anything
  assert.equal(depositEvidence('TDep', [ct(HOT, 'TDep', 5), ct('U2', 'TDep', 5), ct('U3', 'TDep', 5), ct('TDep', HOT, 10)], HOT), null); // the hot wallet itself is not a depositor

  // --- transfer index (7A): seq dedupe, read-through decisions, incremental sync, block-range paging ---
  const tr = (hash: string, amount: number, from = 'A', to = 'B', asset = 'usdt') => ({ asset, hash, from, to, amount, timestamp: 1 });
  // two identical transfers in one tx get seq 0,1; a different amount or tx restarts at 0; re-running gives the same keys
  const seqd = withSeq([tr('h1', 5), tr('h1', 5), tr('h1', 6), tr('h2', 5), tr('h1', 5)]);
  assert.deepEqual(seqd.map((r) => r.seq), [0, 1, 0, 0, 2]);
  assert.deepEqual(withSeq([tr('h1', 5), tr('h1', 5), tr('h1', 6), tr('h2', 5), tr('h1', 5)]).map((r) => r.seq), [0, 1, 0, 0, 2]); // deterministic -> idempotent re-insert
  const carry = new Map<string, number>(); // same tx split over two pages keeps counting
  assert.deepEqual([...withSeq([tr('h', 1)], carry), ...withSeq([tr('h', 1)], carry)].map((r) => r.seq), [0, 1]);
  const tnow = 1_000_000;
  const cov = (status: string, rowCount = 100, ageMs = 1000, assets = 'usdt,usdc') => ({ status, rowCount, lastSyncAt: new Date(tnow - ageMs), assets });
  assert.equal(planRead(null, 200, false, tnow, 300_000), 'api'); // not covered -> live API
  for (const st of ['pending', 'backfilling', 'error']) assert.equal(planRead(cov(st), 200, false, tnow, 300_000), 'api'); // partial coverage is never trusted
  assert.equal(planRead(cov('complete'), 200, false, tnow, 300_000), 'db'); // covered + fresh -> Postgres only
  assert.equal(planRead(cov('complete', 100, 400_000), 200, false, tnow, 300_000), 'sync-then-db'); // stale -> fetch only newer rows
  assert.equal(planRead(cov('complete'), 200, true, tnow, 300_000), 'sync-then-db'); // monitoring asks for fresh
  assert.equal(planRead({ status: 'complete', rowCount: 1, lastSyncAt: null, assets: 'usdt' }, 200, false, tnow, 300_000), 'sync-then-db'); // never synced
  assert.equal(planRead(cov('capped', 50_000), 2000, false, tnow, 300_000), 'db'); // capped holds the newest N: enough for small reads
  assert.equal(planRead(cov('capped', 1000), 2000, false, tnow, 300_000), 'api'); // ...not for reads wanting more than it holds
  // Etherscan-style newest-first batches: a full batch drops its possibly-cut oldest block and restarts there
  const eb = (block: number) => ({ block });
  assert.deepEqual(splitBoundary([eb(9), eb(9), eb(8), eb(7), eb(7)], true), { keep: [eb(9), eb(9), eb(8)], nextEnd: 7 });
  assert.deepEqual(splitBoundary([eb(9), eb(8)], false), { keep: [eb(9), eb(8)], nextEnd: null }); // short batch = history exhausted
  assert.deepEqual(splitBoundary([eb(5), eb(5)], true), { keep: [eb(5), eb(5)], nextEnd: 4 }); // one block bigger than a page: keep it, step below
  // tailer windows never enter the unconfirmed tail
  assert.equal(tailEnd(0, 1_000_000, 60_000, 120_000), 59_999);
  assert.equal(tailEnd(900_000, 1_000_000, 60_000, 120_000), 880_000); // end < cursor -> caught up
  assert.ok(PERMISSIONS.some((p) => p.key === 'index.manage') && SYSTEM_ROLES.find((r) => r.name === 'Admin')!.permissions.includes('index.manage') && !SYSTEM_ROLES.find((r) => r.name === 'Analyst')!.permissions.includes('index.manage'));

  // --- asset registry (7B): decimals were verified live (symbol()/decimals()) on 2026-11-20 ---
  const regKey = REGISTRY.map((d) => `${d.chain}:${d.asset}:${d.symbol}:${d.decimals}`);
  assert.deepEqual(regKey, ['tron:usdt:USDT:6', 'tron:usdc:USDC:6', 'eth:usdt:USDT:6', 'eth:usdc:USDC:6', 'bsc:usdt:USDT:18', 'bsc:usdc:USDC:18']);
  assert.ok(REGISTRY.every((d) => (d.chain === 'tron' ? detectChain(d.contract) === 'tron' : d.contract === d.contract.toLowerCase() && detectChain(d.contract) === 'eth')));
  assert.equal(assetByContract('eth', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')!.asset, 'usdc'); // checksum-case log address still resolves
  assert.equal(assetByContract('bsc', '0x55d398326f99059fF775485246999027B3197955')!.decimals, 18);
  assert.equal(assetByContract('tron', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8')!.asset, 'usdc');
  assert.equal(assetByContract('eth', '0x55d398326f99059fF775485246999027B3197955'), undefined); // BSC contract is not an Ethereum asset
  assert.deepEqual(selectAssets('tron', 'usdc').map((d) => d.asset), ['usdc']);
  assert.deepEqual(selectAssets('bsc', 'all').map((d) => d.asset), [...ASSETS]);
  // decimals parsing: BigInt, so 18-decimal and uint256-sized values neither lose the integer part nor throw
  assert.equal(parseUnits('1234567', 6), 1.234567);
  assert.equal(parseUnits('1000000000000000000', 18), 1);
  assert.equal(parseUnits('9007199254740993000000', 18), 9007.199254740993); // raw > 2^53: Number(raw) would already be rounded
  assert.ok(Math.abs(parseUnits('123456789123456789123456789', 18) - 123456789.12345679) < 1e-6);
  assert.equal(parseUnits(5n * 10n ** 29n, 18), 5e11);
  assert.ok(Number.isFinite(parseUnits(2n ** 255n, 6))); // garbage uint256 values some contracts emit
  assert.equal(parseUnits('0', 18), 0);

  // --- chain resolution of 0x addresses: default Ethereum, BSC only when asked, shapes must match ---
  const evm = '0xAAAA000000000000000000000000000000000001';
  assert.deepEqual(parseAddr(evm), { chain: 'eth', addr: evm.toLowerCase() });
  assert.deepEqual(parseAddr(evm, 'eth'), { chain: 'eth', addr: evm.toLowerCase() });
  assert.deepEqual(parseAddr(evm, 'bsc'), { chain: 'bsc', addr: evm.toLowerCase() });
  assert.deepEqual(parseAddr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'tron'), { chain: 'tron', addr: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' });
  assert.deepEqual(parseAddr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ''), { chain: 'tron', addr: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' });
  assert.throws(() => parseAddr(evm, 'tron'));
  assert.throws(() => parseAddr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'bsc'));
  assert.throws(() => parseAddr(evm, 'solana'));
  assert.ok(isTxHash('bsc', '0x' + 'a'.repeat(64)) && CHAINS.length === 3);
  assert.equal(assetParam(undefined), 'all');
  assert.equal(assetParam('usdc'), 'usdc');
  assert.throws(() => assetParam('dai'));

  // --- Circle (USDC) + Tether freeze events from crafted Etherscan logs ---
  const pad = (a: string) => '0x' + '0'.repeat(24) + a.toLowerCase().slice(2);
  const bad = '0xDeaDbeef00000000000000000000000000000001';
  const circleAdd = { topics: ['0x' + CIRCLE.added, pad(bad)], data: '0x', blockNumber: '0x10', logIndex: '0x2' };
  assert.deepEqual(parseFreezeLog(circleAdd, 'circle'), { address: bad.toLowerCase(), added: true, ts: 16, idx: 2 });
  assert.deepEqual(parseFreezeLog({ ...circleAdd, topics: ['0x' + CIRCLE.removed, pad(bad)] }, 'circle'), { address: bad.toLowerCase(), added: false, ts: 16, idx: 2 });
  const tetherAdd = { topics: ['0x' + TETHER.added], data: pad(bad), blockNumber: '0x20', logIndex: '0x0' }; // Tether: address in data, not indexed
  assert.deepEqual(parseFreezeLog(tetherAdd, 'tether'), { address: bad.toLowerCase(), added: true, ts: 32, idx: 0 });
  assert.equal(parseFreezeLog(circleAdd, 'tether'), null); // another issuer's topic is ignored
  assert.equal(parseFreezeLog({ topics: ['0x' + '00'.repeat(32), pad(bad)], blockNumber: '0x1' }, 'circle'), null);
  assert.equal(CIRCLE.isFrozen, '0xfe575a87'); // isBlacklisted(address), confirmed live against TronGrid's function_selector
  assert.equal(TETHER.isFrozen, '0xe47d6060');

  // --- frozen map -> issuer names (BSC pegged tokens: null = not applicable) ---
  const fm = (usdt: boolean | null, usdc: boolean | null): FrozenMap => ({ usdt, usdc });
  assert.deepEqual(frozenBy('bsc', fm(null, null)), []);
  assert.deepEqual(frozenBy('tron', fm(false, true)), ['Circle']);
  assert.deepEqual(frozenBy('eth', fm(true, true)), ['Tether', 'Circle']);
  assert.match(scoreRisk({ own: [], frozen: true, frozenBy: ['Circle'], flows: [], labelsOf }).reasons[0], /Circle/);

  // --- asset filtering, per-asset graph edges, combined USD volume ---
  const mixed: Transfer[] = [
    { asset: 'usdt', hash: 'u1', from: 'A', to: 'B', amount: 100, timestamp: 1 },
    { asset: 'usdc', hash: 'c1', from: 'A', to: 'B', amount: 40, timestamp: 2 },
    { asset: 'usdc', hash: 'c2', from: 'C', to: 'A', amount: 7, timestamp: 3 },
  ];
  const fAll = flows('A', mixed, false, true);
  assert.deepEqual([fAll[0].address, fAll[0].out], ['B', 140]); // risk sees USDT + USDC as one USD volume
  assert.deepEqual(fAll[0].parts!.map((p) => [p.asset, p.out]), [['usdt', 100], ['usdc', 40]]);
  assert.ok(!('parts' in flows('A', mixed)[0])); // default shape unchanged
  const gMix = await buildGraph('A', 1, 8, async (a) => flows(a, mixed.filter((x) => x.from === a || x.to === a), false, true));
  assert.deepEqual(gMix.edges.map((e) => [e.id, e.asset, e.amount]).sort(), [['A>B', 'usdt', 100], ['A>B:usdc', 'usdc', 40], ['C>A:usdc', 'usdc', 7]]); // USDT keeps the old id
  const onlyUsdc = mixed.filter((x) => x.asset === 'usdc'); // what the asset=usdc filter hands to the graph
  const gUsdc = await buildGraph('A', 1, 8, async (a) => flows(a, onlyUsdc.filter((x) => x.from === a || x.to === a), false, true));
  assert.deepEqual(gUsdc.edges.map((e) => e.asset), ['usdc', 'usdc']);
  const pathMix = await findPath('A', 'B', 2, 5, async (a) => flows(a, mixed.filter((x) => x.from === a || x.to === a), false, true));
  assert.deepEqual(pathMix.edges.map((e) => e.asset).sort(), ['usdc', 'usdt']); // both assets' edges between consecutive hops
  const fxMix = (a: string) => (a === 'B' ? [{ name: 'Ring', category: 'scam' }] : []);
  assert.match(scoreRisk({ own: [], frozen: false, flows: flows('A', mixed), labelsOf: fxMix }).reasons[0], /140 USD-equivalent.*USDT and USDC are both/);
  // coverage only serves the assets it stores
  assert.equal(planRead(cov('complete', 10, 1000, 'usdt'), 200, false, tnow, 300_000, ['usdt']), 'db'); // pre-7B wallet still serves USDT from Postgres
  assert.equal(planRead(cov('complete', 10, 1000, 'usdt'), 200, false, tnow, 300_000, ['usdt', 'usdc']), 'api'); // ...but not USDC until its upgrade backfill finishes
  assert.equal(planRead(cov('complete'), 200, false, tnow, 300_000, ['usdc']), 'db');
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryDelayMs(n) / 60_000), [1, 2, 4, 8, 16]); // bounded back-off for failed backfills
  assert.deepEqual(withSeq([tr('h', 1, 'A', 'B', 'usdt'), tr('h', 1, 'A', 'B', 'usdc')]).map((r) => r.seq), [0, 0]); // same tx, different assets: separate rows
  // monitoring rules per asset
  const usdcBig = { asset: 'usdc' as const, hash: 'x1', from: 'TOther', to: ME, amount: 5000, timestamp: nowMs - 1000 };
  assert.equal(evaluateRules(rule('amount_over', { amount: 1000, asset: 'usdt' }), ME, [usdcBig], [usdcBig], noLabels, nowMs).length, 0); // rule watches USDT only
  const hitC = evaluateRules(rule('amount_over', { amount: 1000, asset: 'usdc' }), ME, [usdcBig], [usdcBig], noLabels, nowMs)[0];
  assert.deepEqual([hitC.asset, hitC.dedupKey], ['usdc', 'x1:usdc']);
  assert.match(hitC.detail, /5,000 USDC/);
  assert.equal(evaluateRules(amt, ME, [usdcBig], [usdcBig], noLabels, nowMs).length, 1); // rules without an asset param (pre-7B) watch every asset
  assert.deepEqual(ruleParams('amount_over', { amount: 5 }), { amount: 5, asset: 'all' });
  assert.throws(() => ruleParams('amount_over', { amount: 5, asset: 'dai' }));

  // --- SSRF guard ---
  assert.ok(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'].every(privateIp));
  assert.ok(!['8.8.8.8', '172.32.0.1', '2606:4700::1111'].some(privateIp));

  console.log('selfcheck: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
