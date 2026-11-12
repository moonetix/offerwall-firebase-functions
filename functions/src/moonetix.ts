// Moonetix helpers with no Firebase imports, so they run and test in plain Node.js.
// Formats: https://docs.moonetix.com/offerwall-link and https://docs.moonetix.com/postbacks

import crypto from 'node:crypto';

export const WALL_BASE = 'https://wall.moonetix.com/';
export const USER_ID_RE = /^[A-Za-z0-9._@:+-]{1,100}$/;
const SUB_ID_RE = /^[A-Za-z0-9._~:@+-]{1,100}$/;
// Rewards are whole numbers or have a few decimals. Up to 6 decimals are kept exactly.
const AMOUNT_RE = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

/** One coin is 1,000,000 micro units. Integers keep balances exact in Firestore. */
export const MICRO = 1_000_000;

export type SubIds = Partial<Record<'sub1' | 'sub2' | 'sub3' | 'sub4' | 'sub5', string>>;

/** Builds the signed offerwall link for one user ID. Call it on the server only. */
export function buildWallLink(appId: string, linkSalt: string, userId: string, subs: SubIds = {}): string {
  if (!appId || !linkSalt) throw new Error('MOONETIX_APP_ID and MOONETIX_LINK_SALT must be set');
  if (!USER_ID_RE.test(userId)) throw new Error('user ID not accepted by the offerwall');
  const hash = crypto.createHmac('sha256', linkSalt).update(userId).digest('hex');
  let url = `${WALL_BASE}${encodeURIComponent(appId)}?user_id=${encodeURIComponent(userId)}&hash=${hash}`;
  for (const [key, value] of Object.entries(subs)) {
    if (/^sub[1-5]$/.test(key) && typeof value === 'string' && SUB_ID_RE.test(value)) {
      url += `&${key}=${encodeURIComponent(value)}`;
    }
  }
  return url;
}

export type Postback = { tx: string; user: string; reward: string; status: string; hash: string };
const KEYS = ['tx', 'user', 'reward', 'status', 'hash'] as const;

/**
 * Reads the five signed parameters. Each must arrive exactly once as a string.
 * Works with Express style req.query objects and with URLSearchParams.
 */
export function readPostback(query: unknown): Postback | null {
  const p = {} as Postback;
  for (const key of KEYS) {
    let value: unknown;
    if (query instanceof URLSearchParams) {
      const all = query.getAll(key);
      value = all.length === 1 ? all[0] : undefined;
    } else if (query && typeof query === 'object') {
      value = (query as Record<string, unknown>)[key];
    }
    if (typeof value !== 'string') return null;
    p[key] = value;
  }
  return p;
}

export function postbackHash(postbackKey: string, tx: string, user: string, reward: string, status: string): string {
  return crypto.createHmac('sha256', postbackKey).update(`${tx}:${user}:${reward}:${status}`).digest('hex');
}

/** Constant-time comparison. Different lengths return false instead of throwing. */
export function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validHash(p: Postback, postbackKey: string): boolean {
  if (!postbackKey) throw new Error('MOONETIX_POSTBACK_KEY is not set');
  return safeEqual(p.hash, postbackHash(postbackKey, p.tx, p.user, p.reward, p.status));
}

/** "150" -> 150000000, "0.375" -> 375000. Anything else -> null. No floating point. */
export function parseAmount(value: string): number | null {
  const m = AMOUNT_RE.exec(value);
  if (!m) return null;
  return Number(m[1]) * MICRO + Number((m[2] ?? '').padEnd(6, '0'));
}

/** 150375000 -> "150.375" */
export function formatAmount(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  const frac = String(abs % MICRO).padStart(6, '0').replace(/0+$/, '');
  return sign + Math.floor(abs / MICRO) + (frac ? '.' + frac : '');
}

/** Firestore document IDs cannot contain "/" or be "." or "..". A SHA-256 is always valid and unique. */
export function txDocId(tx: string): string {
  return crypto.createHash('sha256').update(tx).digest('hex');
}

export type TxRecord = { uid: string; rewardMicro: number; lastStatus: 1 | 2 };
export type Action =
  | { kind: 'credit' }
  | { kind: 'reverse'; uid: string; rewardMicro: number }
  | { kind: 'block' }
  | { kind: 'skip'; reason: 'duplicate' | 'already_reversed' | 'reversed_before_credit' };

/**
 * What an event does, given the stored record of its transaction (or null).
 * status 1 + nothing stored   -> credit
 * status 1 + anything stored  -> skip (a retry, or a credit after its reversal)
 * status 2 + credited         -> reverse the stored amount from the stored user
 * status 2 + nothing stored   -> block: store it as reversed so a late credit never pays
 * status 2 + reversed         -> skip
 */
export function decide(status: 1 | 2, existing: TxRecord | null): Action {
  if (status === 1) {
    if (!existing) return { kind: 'credit' };
    return { kind: 'skip', reason: existing.lastStatus === 1 ? 'duplicate' : 'reversed_before_credit' };
  }
  if (!existing) return { kind: 'block' };
  if (existing.lastStatus === 1) return { kind: 'reverse', uid: existing.uid, rewardMicro: existing.rewardMicro };
  return { kind: 'skip', reason: 'already_reversed' };
}
