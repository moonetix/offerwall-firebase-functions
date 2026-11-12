import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Firestore } from 'firebase-admin/firestore';
import { applyEvent, isAlreadyExists } from '../src/ledger.ts';
import { parseAmount, readPostback, txDocId, validHash } from '../src/moonetix.ts';
import { FakeFirestore, FakeFieldValue } from './fake-firestore.ts';
import { KEY, gen, queryOf } from './vectors.ts';

// Runs a postback URL through the same steps as the function: hash, values, then the ledger.
async function deliver(db: FakeFirestore, url: string) {
  const p = readPostback(queryOf(url));
  if (!p || !validHash(p, KEY)) return 'rejected';
  const rewardMicro = parseAmount(p.reward);
  if (rewardMicro === null) return 'bad';
  return applyEvent(db as unknown as Firestore, FakeFieldValue as never, {
    tx: p.tx, uid: p.user, status: p.status === '1' ? 1 : 2, rewardMicro,
  });
}
const balance = (db: FakeFirestore, uid: string) => db.get(`wallets/${uid}`)?.balanceMicro ?? 0;

test('credit, retry, reversal, repeated reversal', async () => {
  const db = new FakeFirestore();
  assert.equal(await deliver(db, gen('tx_1', 'uidA', '150', 1).postback), 'credited');
  assert.equal(balance(db, 'uidA'), 150_000_000);
  assert.equal(await deliver(db, gen('tx_1', 'uidA', '150', 1).postback), 'duplicate');
  assert.equal(balance(db, 'uidA'), 150_000_000);
  assert.equal(await deliver(db, gen('tx_1', 'uidA', '150', 2).postback), 'reversed');
  assert.equal(balance(db, 'uidA'), 0);
  assert.equal(await deliver(db, gen('tx_1', 'uidA', '150', 2).postback), 'already_reversed');
  assert.equal(balance(db, 'uidA'), 0);
  assert.equal(db.get(`moonetix_tx/${txDocId('tx_1')}`)?.lastStatus, 2);
});

test('decimal rewards add up exactly', async () => {
  const db = new FakeFirestore();
  await deliver(db, gen('tx_a', 'uidB', '0.375', 1).postback);
  await deliver(db, gen('tx_b', 'uidB', '0.75', 1).postback);
  await deliver(db, gen('tx_c', 'uidB', '1.23456', 1).postback);
  assert.equal(balance(db, 'uidB'), 2_359_560);
});

test('a reversal before any credit changes nothing and blocks a late credit', async () => {
  const db = new FakeFirestore();
  assert.equal(await deliver(db, gen('tx_r', 'uidC', '50', 2).postback), 'blocked');
  assert.equal(balance(db, 'uidC'), 0);
  assert.equal(await deliver(db, gen('tx_r', 'uidC', '50', 1).postback), 'reversed_before_credit');
  assert.equal(balance(db, 'uidC'), 0);
});

test('a reversal takes back the stored amount from the stored user', async () => {
  const db = new FakeFirestore();
  await deliver(db, gen('tx_s', 'uidD', '100', 1).postback);
  // Signed reversal naming another user: the credit's user and amount are used.
  assert.equal(await deliver(db, gen('tx_s', 'uidE', '999', 2).postback), 'reversed');
  assert.equal(balance(db, 'uidD'), 0);
  assert.equal(balance(db, 'uidE'), 0);
});

test('20 parallel copies of one credit pay once', async () => {
  const db = new FakeFirestore();
  const url = gen('tx_p', 'uidF', '315', 1).postback;
  const results = await Promise.all(Array.from({ length: 20 }, () => deliver(db, url)));
  assert.equal(results.filter((r) => r === 'credited').length, 1);
  assert.equal(results.filter((r) => r === 'duplicate').length, 19);
  assert.equal(balance(db, 'uidF'), 315_000_000);
});

test('parallel copies of one reversal take back once', async () => {
  const db = new FakeFirestore();
  await deliver(db, gen('tx_q', 'uidG', '20', 1).postback);
  const url = gen('tx_q', 'uidG', '20', 2).postback;
  const results = await Promise.all(Array.from({ length: 4 }, () => deliver(db, url)));
  assert.equal(results.filter((r) => r === 'reversed').length, 1);
  assert.equal(results.filter((r) => r === 'already_reversed').length, 3);
  assert.ok(db.retries > 0, 'the copies really raced');
  assert.equal(balance(db, 'uidG'), 0);
});

test('tampered postbacks never reach Firestore', async () => {
  const db = new FakeFirestore();
  const url = gen('tx_t', 'uidH', '150', 1).postback;
  assert.equal(await deliver(db, url.replace('reward=150', 'reward=15000')), 'rejected');
  assert.equal(await deliver(db, gen('tx_t', 'uidH', '150', 1, 'wrong_key').postback), 'rejected');
  assert.equal(db.docs.size, 0);
});

test('a failed commit stores nothing and can be retried', async () => {
  const db = new FakeFirestore();
  db.failNextCommit = true;
  await assert.rejects(deliver(db, gen('tx_f', 'uidI', '5', 1).postback));
  assert.equal(db.docs.size, 0);
  assert.equal(await deliver(db, gen('tx_f', 'uidI', '5', 1).postback), 'credited');
  assert.equal(balance(db, 'uidI'), 5_000_000);
});

test('ALREADY_EXISTS is recognized in its usual forms', () => {
  assert.equal(isAlreadyExists({ code: 6 }), true);
  assert.equal(isAlreadyExists({ code: 'already-exists' }), true);
  assert.equal(isAlreadyExists({ code: 10 }), false);
  assert.equal(isAlreadyExists(null), false);
});
