import { DARK_PRESETS, LIGHT_PRESETS, readThemePreferences } from './themes';
import type { UserTheme } from './themes';
import { isMac } from './platform';
import { readMathMode } from './math-syntax';
import type { MathMode } from './math-syntax';
export { DARK_PRESETS, LIGHT_PRESETS } from './themes';

export type UIPreferences = {
  userThemes: UserTheme[]; selectedThemeId: string;
  darkPreset: typeof DARK_PRESETS[number]; lightPreset: typeof LIGHT_PRESETS[number]; density: 'compact' | 'comfortable';
  accentColor: string; editorFont: 'mono' | 'sans'; lineHeight: number;
  readingWidth: number; sidebarWidth: number; sidebarRailWidth: 'narrow' | 'standard' | 'wide'; sidebarPosition: 'left' | 'right'; showStatusBar: boolean;
  tabSize: number; indentWithTabs: boolean; languageIntelligenceEnabled: boolean; automaticallyReloadExternalChanges: boolean; showLineNumbers: boolean; focusMode: boolean; smoothScrolling: boolean; reduceMotion: boolean; performanceMode: boolean; scriptsEnabled: boolean;
  /** Math syntax for notes without a `math:` property: Typst with LaTeX fallback, or one engine only. */
  mathSyntax: MathMode;
};

export const DEFAULT_UI_PREFERENCES: Readonly<UIPreferences> = {
  userThemes: [], selectedThemeId: '',
  darkPreset: 'amoled', lightPreset: 'default', density: 'compact', accentColor: '#d8d8df',
  editorFont: 'mono', lineHeight: 1.7, readingWidth: 756, sidebarWidth: 260, sidebarRailWidth: 'standard', sidebarPosition: 'left',
  showStatusBar: true, tabSize: 4, indentWithTabs: false, languageIntelligenceEnabled: false, automaticallyReloadExternalChanges: false, showLineNumbers: true, focusMode: false,
  // macOS already scrolls with momentum and rubber-banding; animating on top fights it.
  smoothScrolling: !isMac, reduceMotion: false, performanceMode: false, scriptsEnabled: false, mathSyntax: 'auto',
};

export const UI_SETTINGS_VERSION = 3;

export function migrateSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const version = Number(settings.uiSettingsVersion);
  if (version >= UI_SETTINGS_VERSION) return settings;
  const next: Record<string, unknown> = { ...settings };
  // Pre-v2 persistence wrote the whole UI object, so a stored tabSize of 2
  // is the old automatic default, not a deliberate user choice.
  if (!(version >= 2) && next.tabSize === 2) next.tabSize = DEFAULT_UI_PREFERENCES.tabSize;
  // Midnight was the old default. Move implicit and previously versioned
  // defaults to AMOLED once; later v3 choices remain untouched.
  if (next.darkPreset === undefined || next.darkPreset === 'midnight') next.darkPreset = DEFAULT_UI_PREFERENCES.darkPreset;
  next.uiSettingsVersion = UI_SETTINGS_VERSION;
  return next;
}

function bounded(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function readUIPreferences(settings: Record<string, unknown>): UIPreferences {
  const defaults = DEFAULT_UI_PREFERENCES;
  return {
    ...readThemePreferences(settings),
    darkPreset: typeof settings.darkPreset === 'string' && (DARK_PRESETS as readonly string[]).includes(settings.darkPreset) ? settings.darkPreset as UIPreferences['darkPreset'] : defaults.darkPreset,
    lightPreset: typeof settings.lightPreset === 'string' && (LIGHT_PRESETS as readonly string[]).includes(settings.lightPreset) ? settings.lightPreset as UIPreferences['lightPreset'] : defaults.lightPreset,
    density: settings.density === 'comfortable' ? 'comfortable' : defaults.density,
    accentColor: typeof settings.accentColor === 'string' && /^#[\da-f]{6}$/i.test(settings.accentColor) ? settings.accentColor.toLowerCase() : defaults.accentColor,
    editorFont: settings.editorFont === 'sans' ? 'sans' : defaults.editorFont,
    lineHeight: bounded(settings.lineHeight, defaults.lineHeight, 1.3, 2.2),
    readingWidth: Math.round(bounded(settings.readingWidth, defaults.readingWidth, 480, 1200)),
    sidebarPosition: settings.sidebarPosition === 'right' ? 'right' : defaults.sidebarPosition,
    sidebarWidth: Math.round(bounded(settings.sidebarWidth, defaults.sidebarWidth, 180, 420)),
    sidebarRailWidth: settings.sidebarRailWidth === 'narrow' || settings.sidebarRailWidth === 'wide' ? settings.sidebarRailWidth : defaults.sidebarRailWidth,
    showStatusBar: typeof settings.showStatusBar === 'boolean' ? settings.showStatusBar : defaults.showStatusBar,
    tabSize: Math.round(bounded(settings.tabSize, defaults.tabSize, 1, 8)),
    indentWithTabs: settings.indentWithTabs === true,
    languageIntelligenceEnabled: settings.languageIntelligenceEnabled === true,
    automaticallyReloadExternalChanges: settings.automaticallyReloadExternalChanges === true,
    performanceMode: settings.performanceMode === true,
    scriptsEnabled: settings.scriptsEnabled === true,
    mathSyntax: readMathMode(settings.mathSyntax) ?? defaults.mathSyntax,
    showLineNumbers: typeof settings.showLineNumbers === 'boolean' ? settings.showLineNumbers : defaults.showLineNumbers,
    focusMode: settings.focusMode === true,
    smoothScrolling: typeof settings.smoothScrolling === 'boolean' ? settings.smoothScrolling : defaults.smoothScrolling,
    reduceMotion: settings.reduceMotion === true,
  };
}

export function preferencesStyle(preferences: UIPreferences): string {
  const prefs = readUIPreferences(preferences);
  const font = prefs.editorFont === 'sans' ? "'Source Sans 3', ui-sans-serif, system-ui, sans-serif" : "'IBM Plex Mono', ui-monospace, monospace";
  const railWidth = { narrow: 40, standard: 44, wide: 60 }[prefs.sidebarRailWidth] + (prefs.density === 'comfortable' ? 4 : 0);
  return `--rail-size:${railWidth}px;--accent:${prefs.accentColor};--editor-font-family:${font};--editor-line-height:${prefs.lineHeight};--reading-width:${prefs.readingWidth}px;--sidebar-width:${prefs.sidebarWidth}px`;
}
