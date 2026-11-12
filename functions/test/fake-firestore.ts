// A small in-memory stand-in for the parts of the Firestore Admin API that ledger.ts uses.
// It follows the documented transaction rules: reads before writes, all writes apply together or
// not at all, create() fails with code 6 (ALREADY_EXISTS) if the document exists at commit, and a
// transaction whose read documents changed before commit is retried, up to 5 attempts.
// Transactions run concurrently, so parallel copies of one postback really race.

type Data = Record<string, unknown>;
type Increment = { __increment: number };
const TS = { __serverTimestamp: true };

export const FakeFieldValue = {
  increment: (n: number) => ({ __increment: n }) as unknown,
  serverTimestamp: () => TS as unknown,
};

function isIncrement(v: unknown): v is Increment {
  return typeof v === 'object' && v !== null && '__increment' in v;
}

function merge(base: Data | undefined, patch: Data): Data {
  const out: Data = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (isIncrement(v)) out[k] = (typeof out[k] === 'number' ? (out[k] as number) : 0) + v.__increment;
    else if (v === TS) out[k] = new Date();
    else out[k] = v;
  }
  return out;
}

class Ref {
  readonly path: string;
  constructor(path: string) { this.path = path; }
}

type Write =
  | { op: 'create'; ref: Ref; data: Data }
  | { op: 'set'; ref: Ref; data: Data; merge: boolean }
  | { op: 'update'; ref: Ref; data: Data };

export class FakeFirestore {
  docs = new Map<string, Data>();
  versions = new Map<string, number>();
  failNextCommit = false;
  retries = 0;

  collection(name: string) {
    return { doc: (id: string) => new Ref(`${name}/${id}`) };
  }

  get(path: string): Data | undefined {
    return this.docs.get(path);
  }

  async runTransaction<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(fn);
      } catch (err) {
        if ((err as { code?: number }).code !== 10 || attempt >= 5) throw err;
        this.retries++;
      }
    }
  }

  private async attempt<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
    const writes: Write[] = [];
    const read = new Map<string, number>();
    const tick = () => new Promise((r) => setImmediate(r));
    const t = {
      get: async (ref: Ref) => {
        await tick();
        read.set(ref.path, this.versions.get(ref.path) ?? 0);
        const data = this.docs.get(ref.path);
        return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
      },
      create: (ref: Ref, data: Data) => { writes.push({ op: 'create', ref, data }); },
      set: (ref: Ref, data: Data, opts?: { merge?: boolean }) => { writes.push({ op: 'set', ref, data, merge: !!opts?.merge }); },
      update: (ref: Ref, data: Data) => { writes.push({ op: 'update', ref, data }); },
    };
    const result = await fn(t);
    await tick(); // the commit is a network round trip: other transactions run meanwhile
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
    }
    // Commit: validate everything first, then apply everything.
    for (const [path, version] of read) {
      if ((this.versions.get(path) ?? 0) !== version) {
        throw Object.assign(new Error('10 ABORTED: contention'), { code: 10 });
      }
    }
    for (const w of writes) {
      if (w.op === 'create' && this.docs.has(w.ref.path)) {
        throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 });
      }
      if (w.op === 'update' && !this.docs.has(w.ref.path)) {
        throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
      }
    }
    for (const w of writes) {
      const current = this.docs.get(w.ref.path);
      if (w.op === 'set' && !w.merge) this.docs.set(w.ref.path, merge(undefined, w.data));
      else this.docs.set(w.ref.path, merge(w.op === 'create' ? undefined : current, w.data));
      this.versions.set(w.ref.path, (this.versions.get(w.ref.path) ?? 0) + 1);
    }
    return result;
  }
}
