// Run: npm run check — fails loudly if core chain logic breaks.
import assert from 'node:assert/strict';
import { detectChain, flows, norm, tronToHex20 } from './chains';

assert.equal(detectChain('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), 'tron');
assert.equal(detectChain('0xdAC17F958D2ee523a2206206994597C13D831ec7'), 'eth');
assert.equal(detectChain('0xdAC17F958D2ee523a2206206994597C13D831ec'), null); // too short
assert.equal(detectChain('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60'), null); // '0' not base58
assert.equal(detectChain('hello'), null);

// USDT TRC20 contract, known hex form 41a614f803b6fd780986a42c78ec9c7f77e6ded13c
assert.equal(tronToHex20('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), 'a614f803b6fd780986a42c78ec9c7f77e6ded13c');

assert.equal(norm('0xABC'), '0xabc');
assert.equal(norm('TAbc'), 'TAbc');

const me = '0xAAAA000000000000000000000000000000000000';
const f = flows(me, [
  { hash: '1', from: '0xbbbb000000000000000000000000000000000000', to: me.toLowerCase(), amount: 100, timestamp: 1 },
  { hash: '2', from: me.toLowerCase(), to: '0xbbbb000000000000000000000000000000000000', amount: 40, timestamp: 2 },
  { hash: '3', from: me.toLowerCase(), to: '0xcccc000000000000000000000000000000000000', amount: 500, timestamp: 3 },
  { hash: '4', from: me.toLowerCase(), to: me.toLowerCase(), amount: 9, timestamp: 4 }, // self-transfer ignored
]);
assert.equal(f.length, 2);
assert.deepEqual(f[0], { address: '0xcccc000000000000000000000000000000000000', in: 0, out: 500, count: 1 });
assert.deepEqual(f[1], { address: '0xbbbb000000000000000000000000000000000000', in: 100, out: 40, count: 2 });

console.log('selfcheck: all passed');
