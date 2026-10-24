// Only regenerable SVGs belong here. Drafts and undo never depend on this cache.
const RAM_BYTES = 2 * 1024 * 1024;
const DISK_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 16;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
type Metadata = { key: string; bytes: number; used: number };

export class DiagramCache {
  private memory = new Map<string, string>();
  private memoryBytes = 0;
  private database: Promise<IDBDatabase | undefined> | undefined;
  private diskDisabled = false;
  constructor(private name = 'notation-derived-diagrams-v1') {}

  private open() {
    if (this.diskDisabled) return Promise.resolve(undefined);
    return this.database ??= new Promise<IDBDatabase | undefined>(resolve => {
      try {
        const request = indexedDB.open(this.name, 1);
        let settled = false;
        const finish = (db?: IDBDatabase) => {
          if (settled) { db?.close(); return; }
          settled = true; clearTimeout(timer); resolve(db);
        };
        const timer = setTimeout(() => finish(), 1000);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('svg');
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.database = undefined; };
          finish(db);
        };
        request.onerror = request.onblocked = () => finish();
      } catch { resolve(undefined); }
    });
  }

  private remember(key: string, value: string) {
    const previous = this.memory.get(key);
    if (previous !== undefined) { this.memoryBytes -= previous.length * 2; this.memory.delete(key); }
    if (value.length * 2 > RAM_BYTES) return;
    this.memory.set(key, value); this.memoryBytes += value.length * 2;
    while (this.memoryBytes > RAM_BYTES || this.memory.size > MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value!;
      this.memoryBytes -= this.memory.get(oldest)!.length * 2;
      this.memory.delete(oldest);
    }
  }

  async get(key: string): Promise<string | undefined> {
    const cached = this.memory.get(key);
    if (cached !== undefined) { this.remember(key, cached); return cached; }
    const db = await this.open();
    if (!db) return;
    try {
      const value = await new Promise<string | undefined>(resolve => {
        const tx = db.transaction(['svg', 'metadata'], 'readwrite');
        let value: string | undefined;
        const timer = setTimeout(() => { try { tx.abort(); } catch {} this.diskDisabled = true; db.close(); resolve(undefined); }, 1000);
        tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
        tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(undefined); };
        const metadata = tx.objectStore('metadata'), svg = tx.objectStore('svg');
        const request = metadata.get(key);
        request.onsuccess = () => {
          const entry = request.result as Metadata | undefined;
          if (!entry) return;
          if (Date.now() - entry.used > MAX_AGE) { metadata.delete(key); svg.delete(key); return; }
          metadata.put({ ...entry, used: Date.now() });
          const read = svg.get(key);
          read.onsuccess = () => { if (typeof read.result === 'string') value = read.result; };
        };
      });
      if (value !== undefined) this.remember(key, value);
      return value;
    } catch { return undefined; }
  }

  async put(key: string, value: string) {
    this.remember(key, value);
    const bytes = value.length * 2 + key.length * 2;
    if (bytes > DISK_BYTES) return;
    const db = await this.open();
    if (!db) return;
    try {
      await new Promise<void>(resolve => {
        const tx = db.transaction(['svg', 'metadata'], 'readwrite');
        const timer = setTimeout(() => { try { tx.abort(); } catch {} this.diskDisabled = true; db.close(); resolve(); }, 1000);
        tx.oncomplete = tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(); };
        const svg = tx.objectStore('svg'), metadata = tx.objectStore('metadata');
        svg.put(value, key); metadata.put({ key, bytes, used: Date.now() } satisfies Metadata);
        // Read only small metadata records; never load every cached SVG to evict.
        const request = metadata.getAll();
        request.onsuccess = () => {
          const entries = (request.result as Metadata[]).sort((a, b) => a.used - b.used);
          let total = entries.reduce((sum, entry) => sum + entry.bytes, 0), count = entries.length;
          for (const entry of entries) {
            if (Date.now() - entry.used <= MAX_AGE && total <= DISK_BYTES && count <= MAX_ENTRIES) continue;
            svg.delete(entry.key); metadata.delete(entry.key); total -= entry.bytes; count--;
          }
        };
      });
    } catch { /* Quota/private-mode failures must not prevent rendering. */ }
  }
}

export async function diagramCacheKey(engine: string, source: string, dark: boolean) {
  try {
    // Increment the namespace when renderer versions or rendering options change.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['v1', engine, dark, source])));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { return undefined; }
}
