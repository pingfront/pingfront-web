// Where the install secret, the logout queue and the outbox live: IndexedDB (this origin only), else memory for this
// page (nothing survives a reload). Never a cookie: a cookie would carry the install secret to the host's own server on
// every request. The access token is never stored. Every key is namespaced per app key (`<mode>-<crc32>`), so test
// and live keys never share state. Tabs of the same origin share the IndexedDB values (engine.ts coordinates them).
import { STORAGE_NAME } from "../constants.js";

export interface Store {
  readonly kind: "indexeddb" | "memory";
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Reads and writes `key` in one step (one IndexedDB transaction, so another tab can't write between); undefined deletes it. */
  update<T>(key: string, fn: (value: T | undefined) => T | undefined): Promise<void>;
}

export function memoryStore(): Store {
  const m = new Map<string, unknown>();
  return {
    kind: "memory",
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    update: async <T>(k: string, fn: (v: T | undefined) => T | undefined) => {
      const v = fn(m.get(k) as T | undefined);
      void (v === undefined ? m.delete(k) : m.set(k, v));
    },
  };
}

/**
 * Writes `mine` over the list stored at `key`, keeping what other tabs stored there unless `keep` refuses it (an item
 * this tab sent or deleted). Ids (`id`) say which entries are the same. An empty list deletes the key.
 */
export function mergeList<T>(s: Store, key: string, mine: T[], id: (x: T) => string, keep: (x: T) => boolean): Promise<void> {
  const ids = new Set(mine.map(id));
  return s.update<T[]>(key, (saved) => {
    const list = [...(Array.isArray(saved) ? saved : []).filter((x) => !ids.has(id(x)) && keep(x)), ...mine];
    return list.length ? list : undefined;
  });
}

const OBJECTS = "kv";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function indexedDbStore(ns: string, idb: IDBFactory = globalThis.indexedDB): Promise<Store> {
  const open = idb.open(STORAGE_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(OBJECTS);
  const db = await Promise.race([
    request(open),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("IndexedDB did not open")), 3000)),
  ]);
  const tx = (mode: IDBTransactionMode) => db.transaction(OBJECTS, mode).objectStore(OBJECTS);
  return {
    kind: "indexeddb",
    get: async <T>(k: string) => (await request(tx("readonly").get(`${ns}:${k}`))) as T | undefined,
    set: async (k, v) => void (await request(tx("readwrite").put(v, `${ns}:${k}`))),
    delete: async (k) => void (await request(tx("readwrite").delete(`${ns}:${k}`))),
    update: <T>(k: string, fn: (v: T | undefined) => T | undefined) =>
      new Promise<void>((resolve, reject) => {
        const os = tx("readwrite");
        const key = `${ns}:${k}`;
        const r = os.get(key);
        r.onsuccess = () => {
          const v = fn(r.result as T | undefined);
          void (v === undefined ? os.delete(key) : os.put(v, key));
        };
        os.transaction.oncomplete = () => resolve();
        os.transaction.onerror = os.transaction.onabort = () => reject(os.transaction.error);
      }),
  };
}

/** IndexedDB, else memory (private modes and locked-down browsers: the install lasts as long as the page). */
export async function openStore(ns: string): Promise<Store> {
  try {
    if (typeof indexedDB !== "undefined") return await indexedDbStore(ns);
  } catch {
    // Fall through to memory.
  }
  return memoryStore();
}
