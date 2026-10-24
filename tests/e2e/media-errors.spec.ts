import { expect, test } from '@playwright/test';

test('local audio is ready with a duration before playback and unloads on cleanup', async ({ page }) => {
  // One second of silent PCM, generated in memory for a portable fixture.
  const wav = Buffer.alloc(44 + 8000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.goto('/');
  await page.evaluate(async (source) => {
    const { renderMedia } = await import('/src/media.ts');
    const host = document.createElement('span');
    host.id = 'ready-audio-fixture';
    host.dataset.mediaSource = source;
    host.dataset.mediaKind = 'audio';
    host.dataset.mediaAlt = 'Local sound';
    document.body.append(host);
    const cleanup = await renderMedia(host, undefined, () => true);
    (window as unknown as { cleanupTestMedia: () => void }).cleanupTestMedia = cleanup;
  }, 'data:audio/wav;base64,' + wav.toString('base64'));
  const audio = page.locator('#ready-audio-fixture audio');
  await expect.poll(() => audio.evaluate((m: HTMLAudioElement) => ({
    ready: m.readyState, network: m.networkState, duration: m.duration,
    paused: m.paused, time: m.currentTime,
  }))).toEqual({ ready: 4, network: 1, duration: 1, paused: true, time: 0 });
  await page.evaluate(() => (window as unknown as { cleanupTestMedia: () => void }).cleanupTestMedia());
  await expect(audio).not.toHaveAttribute('src');
  await expect.poll(() => audio.evaluate((m: HTMLAudioElement) => m.readyState)).toBe(0);
});

test('unplayable local media reports an error and can be cleaned up', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { renderMedia } = await import('/src/media.ts');
    const host = document.createElement('span');
    host.dataset.mediaSource = 'data:video/mp4;base64,bm90LWEtdmlkZW8=';
    host.dataset.mediaKind = 'video';
    host.dataset.mediaAlt = 'Broken sample';
    host.id = 'media-error-fixture';
    document.body.append(host);
    const cleanup = await renderMedia(host, undefined, () => true);
    (window as unknown as { cleanupTestMedia: () => void }).cleanupTestMedia = cleanup;
  });
  const fixture = page.locator('#media-error-fixture');
  await expect(fixture.getByRole('alert')).toContainText('Could not play Broken sample');
  await expect(fixture.getByRole('alert')).toContainText('unsupported codec');
  await page.evaluate(() => {
    (window as unknown as { cleanupTestMedia: () => void }).cleanupTestMedia();
    document.querySelector<HTMLVideoElement>('#media-error-fixture video')!.dispatchEvent(new Event('error'));
  });
  await expect(fixture.getByRole('alert')).toHaveCount(1);
});
