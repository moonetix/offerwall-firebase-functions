import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildWallLink, decide, formatAmount, parseAmount, readPostback, safeEqual, txDocId, validHash,
} from '../src/moonetix.ts';
import { APP, KEY, SALT, expressQuery, gen, queryOf } from './vectors.ts';

test('wall link matches the Moonetix link for the same user ID', () => {
  for (const user of ['42', 'Xy9fQ2abcUid', 'a.b_c@d:e+f-g']) {
    assert.equal(buildWallLink(APP, SALT, user), gen('tx', user, '1', 1).wall);
  }
});

test('wall link adds valid sub IDs only, outside the hash', () => {
  const url = buildWallLink(APP, SALT, '42', { sub1: 'firebase', sub2: 'bad value!' });
  assert.equal(url, gen('tx', '42', '1', 1).wall + '&sub1=firebase');
});

test('wall link refuses user IDs the offerwall does not accept, and missing keys', () => {
  assert.throws(() => buildWallLink(APP, SALT, ''));
  assert.throws(() => buildWallLink(APP, SALT, 'a b'));
  assert.throws(() => buildWallLink(APP, SALT, 'x'.repeat(101)));
  assert.throws(() => buildWallLink(APP, '', '42'));
});

test('a real postback passes the hash check, from URLSearchParams and from req.query', () => {
  const url = gen('tx_1001', 'uid42', '150', 1).postback;
  for (const q of [queryOf(url), expressQuery(url)]) {
    const p = readPostback(q);
    assert.ok(p);
    assert.equal(validHash(p, KEY), true);
  }
});

test('decimal and reversal postbacks pass the hash check', () => {
  for (const [reward, status] of [['0.375', 1], ['0.75', 2], ['1.23456', 1]] as const) {
    const p = readPostback(queryOf(gen('tx_d', 'uid42', reward, status).postback));
    assert.ok(p && validHash(p, KEY), `${reward} ${status}`);
  }
});

test('tampered postbacks fail the hash check', () => {
  const url = gen('tx_1001', 'uid42', '150', 1).postback;
  const cases = [
    url.replace('reward=150', 'reward=1500'),
    url.replace('user=uid42', 'user=uid43'),
    url.replace('status=1', 'status=2'),
    url.replace('tx=tx_1001', 'tx=tx_1002'),
    url.replace(/hash=[0-9a-f]+/, (h) => h.slice(0, -1) + (h.endsWith('0') ? '1' : '0')),
    url.replace(/hash=([0-9a-f]+)/, (_, h: string) => 'hash=' + h.toUpperCase()),
    url.replace(/hash=[0-9a-f]+/, 'hash=abc'),
    url.replace(/hash=[0-9a-f]+/, 'hash='),
    gen('tx_1001', 'uid42', '150', 1, 'some_other_key').postback,
  ];
  for (const bad of cases) {
    const p = readPostback(queryOf(bad));
    assert.ok(p);
    assert.equal(validHash(p, KEY), false, bad);
  }
});

test('missing or repeated parameters are refused before hashing', () => {
  const url = gen('tx_1001', 'uid42', '150', 1).postback;
  assert.equal(readPostback(queryOf(url.replace(/&hash=[0-9a-f]+/, ''))), null);
  assert.equal(readPostback(queryOf(url + '&tx=other')), null);
  assert.equal(readPostback(expressQuery(url + '&tx=other')), null);
  assert.equal(readPostback(null), null);
});

test('safeEqual does not throw on different lengths', () => {
  assert.equal(safeEqual('a', 'ab'), false);
  assert.equal(safeEqual('ab', 'ab'), true);
});

test('validHash fails closed without a key', () => {
  const p = readPostback(queryOf(gen('tx_1', 'u', '1', 1).postback));
  assert.ok(p);
  assert.throws(() => validHash(p, ''));
});

test('amounts are exact integers in micro units', () => {
  assert.equal(parseAmount('150'), 150_000_000);
  assert.equal(parseAmount('0.375'), 375_000);
  assert.equal(parseAmount('1.23456'), 1_234_560);
  assert.equal(parseAmount('0'), 0);
  for (const bad of ['', '-1', '1e3', '1.', '.5', '1,5', ' 1', '1.1234567', '1000000000']) {
    assert.equal(parseAmount(bad), null, bad);
  }
  assert.equal(formatAmount(150_375_000), '150.375');
  assert.equal(formatAmount(-750_000), '-0.75');
  // 0.1 + 0.2 adds up exactly
  assert.equal(formatAmount((parseAmount('0.1') ?? 0) + (parseAmount('0.2') ?? 0)), '0.3');
});

test('transaction document IDs are valid for any transaction ID', () => {
  assert.match(txDocId('a/b'), /^[0-9a-f]{64}$/);
  assert.notEqual(txDocId('ABC'), txDocId('abc'));
  assert.equal(txDocId('..'), crypto.createHash('sha256').update('..').digest('hex'));
});

test('decide covers every status and stored state', () => {
  const credited = { uid: 'u1', rewardMicro: 5, lastStatus: 1 as const };
  const reversed = { uid: 'u1', rewardMicro: 5, lastStatus: 2 as const };
  assert.deepEqual(decide(1, null), { kind: 'credit' });
  assert.deepEqual(decide(1, credited), { kind: 'skip', reason: 'duplicate' });
  assert.deepEqual(decide(1, reversed), { kind: 'skip', reason: 'reversed_before_credit' });
  assert.deepEqual(decide(2, null), { kind: 'block' });
  assert.deepEqual(decide(2, credited), { kind: 'reverse', uid: 'u1', rewardMicro: 5 });
  assert.deepEqual(decide(2, reversed), { kind: 'skip', reason: 'already_reversed' });
});
