export type UIPreferences = {
  darkPreset: 'midnight' | 'charcoal'; density: 'compact' | 'comfortable';
  accentColor: string; editorFont: 'mono' | 'sans'; lineHeight: number;
  readingWidth: number; sidebarWidth: number; sidebarRailWidth: 'narrow' | 'standard' | 'wide'; sidebarPosition: 'left' | 'right'; showStatusBar: boolean;
  showLineNumbers: boolean; focusMode: boolean; smoothScrolling: boolean;
};

export const DEFAULT_UI_PREFERENCES: Readonly<UIPreferences> = {
  darkPreset: 'midnight', density: 'compact', accentColor: '#d8d8df',
  editorFont: 'mono', lineHeight: 1.7, readingWidth: 756, sidebarWidth: 260, sidebarRailWidth: 'standard', sidebarPosition: 'left',
  showStatusBar: true, showLineNumbers: true, focusMode: false, smoothScrolling: true,
};

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function readUIPreferences(settings: Record<string, unknown>): UIPreferences {
  const defaults = DEFAULT_UI_PREFERENCES;
  return {
    darkPreset: settings.darkPreset === 'charcoal' ? 'charcoal' : defaults.darkPreset,
    density: settings.density === 'comfortable' ? 'comfortable' : defaults.density,
    accentColor: typeof settings.accentColor === 'string' && /^#[\da-f]{6}$/i.test(settings.accentColor) ? settings.accentColor.toLowerCase() : defaults.accentColor,
    editorFont: settings.editorFont === 'sans' ? 'sans' : defaults.editorFont,
    lineHeight: bounded(settings.lineHeight, defaults.lineHeight, 1.3, 2.2),
    readingWidth: Math.round(bounded(settings.readingWidth, defaults.readingWidth, 480, 1200)),
    sidebarPosition: settings.sidebarPosition === 'right' ? 'right' : defaults.sidebarPosition,
    sidebarWidth: Math.round(bounded(settings.sidebarWidth, defaults.sidebarWidth, 180, 420)),
    sidebarRailWidth: settings.sidebarRailWidth === 'narrow' || settings.sidebarRailWidth === 'wide' ? settings.sidebarRailWidth : defaults.sidebarRailWidth,
    showStatusBar: typeof settings.showStatusBar === 'boolean' ? settings.showStatusBar : defaults.showStatusBar,
    showLineNumbers: typeof settings.showLineNumbers === 'boolean' ? settings.showLineNumbers : defaults.showLineNumbers,
    focusMode: settings.focusMode === true,
    smoothScrolling: typeof settings.smoothScrolling === 'boolean' ? settings.smoothScrolling : defaults.smoothScrolling,
  };
}

export function preferencesStyle(preferences: UIPreferences): string {
  const prefs = readUIPreferences(preferences);
  const font = prefs.editorFont === 'sans' ? "'Source Sans 3', ui-sans-serif, system-ui, sans-serif" : "'IBM Plex Mono', ui-monospace, monospace";
  const railWidth = { narrow: 40, standard: 44, wide: 60 }[prefs.sidebarRailWidth] + (prefs.density === 'comfortable' ? 4 : 0);
  return `--rail-size:${railWidth}px;--accent:${prefs.accentColor};--editor-font-family:${font};--editor-line-height:${prefs.lineHeight};--reading-width:${prefs.readingWidth}px;--sidebar-width:${prefs.sidebarWidth}px`;
}
