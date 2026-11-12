// Cloud Functions for Firebase (2nd gen):
//   moonetixPostback  HTTPS endpoint for Moonetix postbacks (credits and reversals)
//   moonetixWallLink  callable function that returns the signed offerwall link of the signed-in user

import { onRequest, onCall, HttpsError } from 'firebase-functions/https';
import { defineSecret, defineString, defineBoolean } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { buildWallLink, parseAmount, readPostback, USER_ID_RE, validHash } from './moonetix.ts';
import { applyEvent } from './ledger.ts';

initializeApp();
const db = getFirestore();

// Secrets live in Cloud Secret Manager: firebase functions:secrets:set MOONETIX_POSTBACK_KEY
const POSTBACK_KEY = defineSecret('MOONETIX_POSTBACK_KEY');
const LINK_SALT = defineSecret('MOONETIX_LINK_SALT');
// Not secret: set in functions/.env
const APP_ID = defineString('MOONETIX_APP_ID');
const CREDIT_TEST_POSTBACKS = defineBoolean('MOONETIX_CREDIT_TEST_POSTBACKS', { default: false });

export const moonetixPostback = onRequest(
  // invoker public: Moonetix calls without a Google identity token. The hash is the access check.
  { secrets: [POSTBACK_KEY], invoker: 'public', timeoutSeconds: 10, cors: false },
  async (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).end();
      return;
    }

    // 1. Hash first, on the values exactly as they arrived. Nothing else runs before this check.
    const p = readPostback(req.query);
    let ok = false;
    try {
      ok = p !== null && validHash(p, POSTBACK_KEY.value());
    } catch (err) {
      logger.error('moonetix: postback key missing', { err: String(err) });
      res.status(500).end();
      return;
    }
    if (!p || !ok) {
      res.status(403).end();
      return;
    }

    // 2. Signed values that make no sense are logged. A retry would not fix them.
    const rewardMicro = parseAmount(p.reward);
    if (rewardMicro === null || (p.status !== '1' && p.status !== '2') || !USER_ID_RE.test(p.user) || p.tx === '') {
      logger.warn('moonetix: postback with unexpected values', { tx: p.tx, reward: p.reward, status: p.status });
      res.status(400).end();
      return;
    }

    // 3. Dashboard tests have a transaction ID that starts with test_. Logged only, unless you opt in.
    if (p.tx.startsWith('test_') && !CREDIT_TEST_POSTBACKS.value()) {
      logger.info('moonetix: test postback (not credited)', { tx: p.tx, user: p.user, status: p.status });
      res.status(200).end();
      return;
    }

    // 4. Store, then answer. 2xx only after the transaction committed.
    try {
      const offer = typeof req.query.offer === 'string' ? req.query.offer.slice(0, 200) : '';
      const result = await applyEvent(db, FieldValue, {
        tx: p.tx, uid: p.user, status: p.status === '1' ? 1 : 2, rewardMicro, offerName: offer,
      });
      logger.info('moonetix: postback', { tx: p.tx, status: p.status, result });
      res.status(200).end();
    } catch (err) {
      // 500 makes Moonetix retry later (up to 5 times).
      logger.error('moonetix: postback failed', { tx: p.tx, err: String(err) });
      res.status(500).end();
    }
  },
);

export const moonetixWallLink = onCall({ secrets: [LINK_SALT] }, (request) => {
  // The user ID is the verified Firebase Auth UID, never a value from request.data.
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to open the offerwall.');
  }
  const uid = request.auth.uid;
  if (!USER_ID_RE.test(uid)) {
    throw new HttpsError('failed-precondition', 'This account ID cannot be used on the offerwall.');
  }
  return { url: buildWallLink(APP_ID.value(), LINK_SALT.value(), uid, { sub1: 'firebase' }) };
});
