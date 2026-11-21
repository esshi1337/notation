// One place decides whether the app follows macOS conventions: Cmd as the
// command modifier, native trackpad scrolling, glyph shortcut labels.

type PlatformSource = { platform?: string; userAgent?: string; userAgentData?: { platform?: string } };

export function detectMac(source: PlatformSource | undefined): boolean {
  if (!source) return false;
  const platform = source.userAgentData?.platform || source.platform || '';
  if (platform) return /^(Mac|iPhone|iPad|iPod)/iu.test(platform);
  return /Macintosh|Mac OS X/u.test(source.userAgent ?? '');
}

export const isMac = detectMac(typeof navigator === 'undefined' ? undefined : navigator as PlatformSource);
