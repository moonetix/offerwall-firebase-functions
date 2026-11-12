// Applies one verified postback to Firestore, in one transaction.
// moonetix_tx/{sha256(transaction_id)} remembers every transaction. wallets/{uid} holds the balance.

import type { Firestore, FieldValue as FieldValueType } from 'firebase-admin/firestore';
import { decide, txDocId, type TxRecord } from './moonetix.ts';

export type Applied = 'credited' | 'reversed' | 'blocked' | 'duplicate' | 'already_reversed' | 'reversed_before_credit';

export type EventInput = {
  tx: string;
  uid: string;
  status: 1 | 2;
  rewardMicro: number;
  offerName?: string;
};

type FieldValueApi = Pick<typeof FieldValueType, 'increment' | 'serverTimestamp'>;

/** gRPC code 6: the document create() wanted to write already exists. */
export function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

export async function applyEvent(db: Firestore, FieldValue: FieldValueApi, e: EventInput): Promise<Applied> {
  const ref = db.collection('moonetix_tx').doc(txDocId(e.tx));
  try {
    return await db.runTransaction(async (t) => {
      // Reads come first in a Firestore transaction. get() locks the document until commit.
      const snap = await t.get(ref);
      const existing = snap.exists ? (snap.data() as TxRecord) : null;
      const action = decide(e.status, existing);
      const now = FieldValue.serverTimestamp();

      if (action.kind === 'credit') {
        // create() fails if a parallel copy created the document first, so only one copy can pay.
        t.create(ref, {
          tx: e.tx, uid: e.uid, rewardMicro: e.rewardMicro, lastStatus: 1,
          offerName: e.offerName ?? '', createdAt: now, updatedAt: now,
        });
        t.set(db.collection('wallets').doc(e.uid),
          { balanceMicro: FieldValue.increment(e.rewardMicro), updatedAt: now }, { merge: true });
        return 'credited';
      }
      if (action.kind === 'reverse') {
        // Take back exactly what was credited, from the user who got it.
        t.update(ref, { lastStatus: 2, updatedAt: now });
        t.set(db.collection('wallets').doc(action.uid),
          { balanceMicro: FieldValue.increment(-action.rewardMicro), updatedAt: now }, { merge: true });
        return 'reversed';
      }
      if (action.kind === 'block') {
        // A reversal of a credit we never stored: record it so a late copy of the credit cannot pay.
        t.create(ref, {
          tx: e.tx, uid: e.uid, rewardMicro: 0, lastStatus: 2,
          offerName: e.offerName ?? '', createdAt: now, updatedAt: now,
        });
        return 'blocked';
      }
      return action.reason;
    });
  } catch (err) {
    // Two copies raced and the other one stored the transaction first. Nothing more to do.
    if (isAlreadyExists(err)) return 'duplicate';
    throw err;
  }
}
