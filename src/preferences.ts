export type UIPreferences = {
  darkPreset: 'midnight' | 'charcoal'; density: 'compact' | 'comfortable';
  accentColor: string; editorFont: 'mono' | 'sans'; lineHeight: number;
  readingWidth: number; sidebarWidth: number; showStatusBar: boolean;
  showLineNumbers: boolean; focusMode: boolean;
};

export const DEFAULT_UI_PREFERENCES: Readonly<UIPreferences> = {
  darkPreset: 'midnight', density: 'compact', accentColor: '#d8d8df',
  editorFont: 'mono', lineHeight: 1.7, readingWidth: 800, sidebarWidth: 260,
  showStatusBar: true, showLineNumbers: true, focusMode: false,
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
    sidebarWidth: Math.round(bounded(settings.sidebarWidth, defaults.sidebarWidth, 180, 420)),
    showStatusBar: typeof settings.showStatusBar === 'boolean' ? settings.showStatusBar : defaults.showStatusBar,
    showLineNumbers: typeof settings.showLineNumbers === 'boolean' ? settings.showLineNumbers : defaults.showLineNumbers,
    focusMode: settings.focusMode === true,
  };
}

export function preferencesStyle(preferences: UIPreferences): string {
  const prefs = readUIPreferences(preferences);
  const font = prefs.editorFont === 'sans' ? "'Geist', ui-sans-serif, system-ui, sans-serif" : "'Geist Mono', ui-monospace, monospace";
  return `--accent:${prefs.accentColor};--editor-font-family:${font};--editor-line-height:${prefs.lineHeight};--reading-width:${prefs.readingWidth}px;--sidebar-width:${prefs.sidebarWidth}px`;
}
