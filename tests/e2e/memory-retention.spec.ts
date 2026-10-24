import { test, expect } from '@playwright/test';
import { runCommand } from './commands';

test('closed heavy buffers release their editors across repeated workload rounds', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await page.goto('/');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const sample = async (phase: string) => {
    await page.waitForTimeout(500); // Recovery writes and Svelte teardown must finish first.
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = await cdp.send('Performance.getMetrics');
    const value = (name: string) => metrics.metrics.find(row => row.name === name)?.value ?? 0;
    return { phase, heapBytes: value('JSHeapUsedSize'), nodes: value('Nodes'), listeners: value('JSEventListeners'), mountedEditors: await page.locator('.cm-editor').count() };
  };
  const samples = [await sample('startup')];
  for (let round = 0; round < 6; round++) {
    for (let index = 0; index < 4; index++) {
      const content = Array.from({ length: 8000 }, (_, line) => `export const r${round}f${index}v${line} = "retention sample ${line}";`).join('\n');
      await page.locator('input[type=file]').setInputFiles({ name: `round-${round}-${index}.ts`, mimeType: 'text/plain', buffer: Buffer.from(content) });
      await expect(page.getByRole('tab', { name: `round-${round}-${index}.ts`, exact: true })).toHaveAttribute('aria-selected', 'true');
    }
    samples.push(await sample(`loaded-${round}`));
    for (let index = 0; index < 4; index++) await runCommand(page, 'Close tab');
    await expect(page.getByRole('tab', { name: 'welcome.md', exact: true })).toHaveAttribute('aria-selected', 'true');
    samples.push(await sample(`closed-${round}`));
  }
  await testInfo.attach('memory-retention', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  console.log('MEMORY_RETENTION ' + JSON.stringify(samples));
  const closed = samples.filter(row => row.phase.startsWith('closed-'));
  // Allow library warmup/allocator variation, but catch retained documents/views per round.
  if (closed.at(-1)!.nodes - closed[1].nodes >= 1000) {
    const chunks: string[] = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', event => chunks.push(event.chunk));
    await cdp.send('HeapProfiler.takeHeapSnapshot');
    await testInfo.attach('retained-heap', { body: chunks.join(''), contentType: 'application/json' });
  }
  expect(closed.at(-1)!.heapBytes - closed[1].heapBytes).toBeLessThan(8 * 1024 * 1024);
  expect(closed.at(-1)!.nodes - closed[1].nodes).toBeLessThan(1000);
  expect(closed.at(-1)!.listeners - closed[1].listeners).toBeLessThan(100);
  expect(closed.every(row => row.mountedEditors === 1)).toBe(true);

});

test('restored buffers can be closed without retaining the startup session snapshot', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.evaluate(() => {
    const tabs = Array.from({ length: 8 }, (_, index) => {
      const name = `restored-${index}.txt`;
      const content = Array.from({ length: 4000 }, (_, line) => `Restored document ${index}, line ${line}: retain only while open.\n`).join('');
      return { id: `restore-${index}`, name, savedName: name, path: null, content, savedContent: content };
    });
    tabs.unshift({ id: 'keeper', name: 'keeper.md', savedName: 'keeper.md', path: null, content: '# Keep', savedContent: '# Keep' });
    localStorage.setItem('notation.session', JSON.stringify({ tabs, activeTabId: 'keeper', updatedAt: Date.now() }));
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'keeper.md', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await page.keyboard.press('Escape');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    await page.waitForTimeout(500);
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Performance.getMetrics')).metrics.find(row => row.name === 'JSHeapUsedSize')!.value;
  };
  const restoredHeap = await heap();
  for (let index = 0; index < 8; index++) {
    await page.getByRole('button', { name: `Close tab: restored-${index}.txt`, exact: true }).click();
  }
  const closedHeap = await heap();
  expect(await page.getByRole('tablist', { name: 'Documents', exact: true }).getByRole('tab').count()).toBe(1);
  if (restoredHeap - closedHeap < 512 * 1024) {
    const chunks: string[] = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', event => chunks.push(event.chunk));
    await cdp.send('HeapProfiler.takeHeapSnapshot');
    await testInfo.attach('restored-heap', { body: chunks.join(''), contentType: 'application/json' });
  }
  await testInfo.attach('restored-memory', { body: JSON.stringify({ restoredHeap, closedHeap }), contentType: 'application/json' });
  console.log('RESTORED_MEMORY ' + JSON.stringify({ restoredHeap, closedHeap }));
  expect(restoredHeap - closedHeap).toBeGreaterThan(512 * 1024);
});

test('disposing a notebook releases completed outputs while ordinary notes have no cells', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    const modulePath = '/src/cells.ts';
    const { CellSession, codeCells } = await import(/* @vite-ignore */ modulePath);
    const session = new CellSession();
    session.update('```js cell:data\nreturn { payload: "x".repeat(300000) };\n```', 'notebook.md', null);
    await session.run('data');
    const completed = session.get('data')?.result?.payload.length;
    session.dispose();
    return { completed, released: session.get('data') === undefined, running: session.busy,
      plainCells: codeCells('A plain note\n'.repeat(10000)).length };
  })).toEqual({ completed: 300000, released: true, running: false, plainCells: 0 });
});
