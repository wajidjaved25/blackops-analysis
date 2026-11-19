// Run: npm run check — fails loudly if core logic breaks. No network calls.
import assert from 'node:assert/strict';
import { detectChain, flows, hexToTron, isTxHash, norm, Transfer, tronToHex20 } from './chains';
import { buildGraph, findPath } from './graph';

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
    { hash: '1', from: B, to: m, amount: 100, timestamp: 1 },
    { hash: '2', from: m, to: B, amount: 40, timestamp: 2 },
    { hash: '3', from: m, to: C, amount: 500, timestamp: 3 },
    { hash: '4', from: m, to: m, amount: 9, timestamp: 4 }, // self-transfer ignored
  ]);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { address: C, in: 0, out: 500, inCount: 0, outCount: 1 });
  assert.deepEqual(f[1], { address: B, in: 100, out: 40, inCount: 1, outCount: 1 });

  // --- graph + path on a fake ledger: A->B->C->D, A->E, X->D ---
  const t = (from: string, to: string, amount: number): Transfer => ({ hash: from + to, from, to, amount, timestamp: 0 });
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

  console.log('selfcheck: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
