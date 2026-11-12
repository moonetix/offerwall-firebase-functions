// End-to-end test against the Firebase Emulator Suite (Functions, Firestore, Auth).
// Run from functions/: npm run test:emulator   (see README, "Test it in the emulator")
// It talks to the emulators over their REST APIs, so it needs no extra packages.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { APP, SALT, gen } from './vectors.ts';
import { buildWallLink, txDocId } from '../src/moonetix.ts';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-moonetix';
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/us-central1`;
const FIRESTORE = `http://${process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'}`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`;
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;

function postbackUrl(tx: string, user: string, reward: string, status: 1 | 2, secret?: string): string {
  const u = new URL(gen(tx, user, reward, status, secret).postback);
  return `${FUNCTIONS}/moonetixPostback${u.search}`;
}
async function call(url: string, init?: RequestInit): Promise<number> {
  const r = await fetch(url, init);
  await r.arrayBuffer();
  return r.status;
}
// "Bearer owner" is the emulator's admin access, it skips security rules.
async function readDoc(path: string, token = 'owner'): Promise<{ status: number; fields: Record<string, { integerValue?: string }> }> {
  const r = await fetch(`${DOCS}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await r.json()) as { fields?: Record<string, { integerValue?: string }> };
  return { status: r.status, fields: body.fields ?? {} };
}
async function balance(uid: string): Promise<number> {
  const d = await readDoc(`wallets/${uid}`);
  return Number(d.fields.balanceMicro?.integerValue ?? 0);
}
async function signUp(email: string): Promise<{ uid: string; idToken: string }> {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'not-a-real-password-1', returnSecureToken: true }),
  });
  const body = (await r.json()) as { localId: string; idToken: string };
  return { uid: body.localId, idToken: body.idToken };
}

before(async () => {
  await fetch(`${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
});

test('credit once, retries and reversal', async () => {
  assert.equal(await call(postbackUrl('tx_e1', 'uidA', '150', 1)), 200);
  assert.equal(await balance('uidA'), 150_000_000);
  assert.equal(await call(postbackUrl('tx_e1', 'uidA', '150', 1)), 200);
  assert.equal(await balance('uidA'), 150_000_000);
  assert.equal(await call(postbackUrl('tx_e1', 'uidA', '150', 2)), 200);
  assert.equal(await balance('uidA'), 0);
  assert.equal(await call(postbackUrl('tx_e1', 'uidA', '150', 2)), 200);
  assert.equal(await balance('uidA'), 0);
});

test('20 parallel copies of one credit pay once', async () => {
  const url = postbackUrl('tx_e2', 'uidB', '315', 1);
  const codes = await Promise.all(Array.from({ length: 20 }, () => call(url)));
  // Under heavy contention Firestore can give up on a transaction. The function then answers 500
  // and Moonetix retries later, which is what the resend below does. It must never pay twice.
  assert.ok(codes.every((c) => c === 200 || c === 500), `codes: ${codes.join(',')}`);
  assert.ok(codes.filter((c) => c === 200).length >= 1, `codes: ${codes.join(',')}`);
  assert.equal(await balance('uidB'), 315_000_000);
  assert.equal(await call(url), 200);
  assert.equal(await balance('uidB'), 315_000_000);
});

test('decimals, slash in the transaction ID, reversal before credit', async () => {
  assert.equal(await call(postbackUrl('tx/e3', 'uidC', '0.375', 1)), 200);
  assert.equal(await call(postbackUrl('tx_e4', 'uidC', '1.23456', 1)), 200);
  assert.equal(await balance('uidC'), 1_609_560);
  assert.equal((await readDoc(`moonetix_tx/${txDocId('tx/e3')}`)).status, 200);
  assert.equal(await call(postbackUrl('tx_e5', 'uidC', '50', 2)), 200);
  assert.equal(await call(postbackUrl('tx_e5', 'uidC', '50', 1)), 200);
  assert.equal(await balance('uidC'), 1_609_560);
});

test('forged, short, repeated and non-GET requests are refused', async () => {
  const good = postbackUrl('tx_e6', 'uidD', '150', 1);
  assert.equal(await call(good.replace('reward=150', 'reward=150000')), 403);
  assert.equal(await call(good.replace(/hash=[0-9a-f]+/, 'hash=abc')), 403);
  assert.equal(await call(good + '&tx=other'), 403);
  assert.equal(await call(postbackUrl('tx_e6', 'uidD', '150', 1, 'wrong_key')), 403);
  assert.equal(await call(`${FUNCTIONS}/moonetixPostback`), 403);
  assert.equal(await call(good, { method: 'POST' }), 405);
  assert.equal(await balance('uidD'), 0);
});

test('test_ postbacks are answered 200 and not credited by default', async () => {
  assert.equal(await call(postbackUrl('test_abc123', 'uidE', '100', 1)), 200);
  assert.equal(await balance('uidE'), 0);
});

test('callable returns the signed link only for a signed-in user', async () => {
  const anon = await fetch(`${FUNCTIONS}/moonetixWallLink`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { userId: 'someone-else' } }),
  });
  assert.equal(anon.status, 401);

  const user = await signUp('player@example.com');
  const r = await fetch(`${FUNCTIONS}/moonetixWallLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.idToken}` },
    body: JSON.stringify({ data: { userId: 'someone-else' } }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { result: { url: string } };
  assert.equal(body.result.url, buildWallLink(APP, SALT, user.uid, { sub1: 'firebase' }));
  assert.equal(body.result.url.split('&sub1=')[0], gen('x', user.uid, '1', 1).wall);
});

test('security rules: users read only their own wallet and write nothing', async () => {
  const a = await signUp('a@example.com');
  const b = await signUp('b@example.com');
  assert.equal(await call(postbackUrl('tx_e7', a.uid, '10', 1)), 200);
  assert.equal((await readDoc(`wallets/${a.uid}`, a.idToken)).status, 200);
  assert.equal((await readDoc(`wallets/${a.uid}`, b.idToken)).status, 403);
  const write = await fetch(`${DOCS}/wallets/${a.uid}?updateMask.fieldPaths=balanceMicro`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.idToken}` },
    body: JSON.stringify({ fields: { balanceMicro: { integerValue: '999999999' } } }),
  });
  assert.equal(write.status, 403);
  assert.equal(await balance(a.uid), 10_000_000);
});
