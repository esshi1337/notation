import { test, expect } from '@playwright/test';

test('derived diagrams survive a cache instance and enforce RAM, disk, and age bounds', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/diagram-cache.ts';
    const { DiagramCache, diagramCacheKey } = await import(/* @vite-ignore */ modulePath);
    const name = `test-diagrams-${crypto.randomUUID()}`;
    const cache = new DiagramCache(name);
    const inspect = () => new Promise<any[]>(resolve => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('metadata');
        const all = tx.objectStore('metadata').getAll();
        tx.oncomplete = () => { db.close(); resolve(all.result); };
      };
    });
    const value = 'x'.repeat(600000);
    for (let index = 0; index < 20; index++) await cache.put(`diagram-${index}`, value);
    const entries = await inspect();
    const ramBytes = [...cache.memory.values() as Iterable<string>].reduce((sum, svg) => sum + svg.length * 2, 0);
    const diskCache = new DiagramCache(name);
    const restored = (await diskCache.get('diagram-19')) === value;
    const evicted = await diskCache.get('diagram-0') === undefined;
    for (let index = 0; index < 6; index++) await cache.put(`large-${index}`, 'y'.repeat(4000000));
    const largeEntries = await inspect();
    await new Promise<void>(resolve => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').put({ key: 'large-5', bytes: 8000014, used: 0 });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });
    const expired = await new DiagramCache(name).get('large-5') === undefined;
    const keys = await Promise.all([
      diagramCacheKey('dot', 'digraph { a -> b }', true),
      diagramCacheKey('dot', 'digraph { a -> b }', false),
      diagramCacheKey('d2', 'digraph { a -> b }', true),
    ]);
    return { ramBytes, count: entries.length, restored, evicted, expired,
      diskBytes: largeEntries.reduce((sum, entry) => sum + entry.bytes, 0),
      distinctKeys: new Set(keys).size };
  });
  expect(result).toMatchObject({ count: 16, restored: true, evicted: true, expired: true, distinctKeys: 3 });
  expect(result.ramBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.diskBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
});

test('unavailable disk storage leaves rendering cache optional', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    const modulePath = '/src/diagram-cache.ts';
    const { DiagramCache } = await import(/* @vite-ignore */ modulePath);
    Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Storage unavailable'); } });
    const cache = new DiagramCache();
    await cache.put('small', '<svg/>');
    await cache.put('large', 'x'.repeat(2 * 1024 * 1024));
    return { small: await cache.get('small'), large: await cache.get('large'), missing: await cache.get('missing') };
  })).toEqual({ small: '<svg/>', large: undefined, missing: undefined });
});

test('a stalled disk transaction disables disk access for the rest of the session', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    const modulePath = '/src/diagram-cache.ts';
    const { DiagramCache } = await import(/* @vite-ignore */ modulePath);
    let transactions = 0;
    const db = { close() {}, transaction() {
      transactions++;
      return { abort() {}, objectStore() { return { get() { return {}; } }; } };
    } };
    Object.defineProperty(window, 'indexedDB', { value: { open() {
      const request: any = { result: db };
      queueMicrotask(() => request.onsuccess());
      return request;
    } } });
    const cache = new DiagramCache();
    await cache.get('stalled');
    for (let index = 0; index < 20; index++) await cache.get(`next-${index}`);
    await cache.put('memory', '<svg/>');
    return { transactions, cached: await cache.get('memory') };
  })).toEqual({ transactions: 1, cached: '<svg/>' });
});
