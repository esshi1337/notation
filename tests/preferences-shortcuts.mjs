import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ cacheDir: 'node_modules/.vite/preferences-shortcuts', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
let passed = 0;
function check(name, run) { run(); passed++; console.log('✓ ' + name); }
try {
  const preferences = await server.ssrLoadModule('/src/preferences.ts');
  const keys = await server.ssrLoadModule('/src/shortcuts.ts');
  const themes = await server.ssrLoadModule('/src/themes.ts');
  const theme = (extra = {}) => ({ id: 'theme-test', name: 'Local theme', base: 'light/paper', css: ':root { --bg: #abcdef; }', ...extra });
  check('user themes roundtrip without resetting unrelated preferences or version', () => {
    const restored = preferences.readUIPreferences(JSON.parse(JSON.stringify({ userThemes: [theme()], selectedThemeId: 'theme-test', tabSize: 3, density: 'comfortable' })));
    assert.deepEqual(restored.userThemes, [theme()]); assert.equal(restored.selectedThemeId, 'theme-test');
    assert.equal(restored.tabSize, 3); assert.equal(restored.density, 'comfortable'); assert.equal(preferences.UI_SETTINGS_VERSION, 3);
  });
  check('theme normalization copies known fields only and validates identities names and bases', () => {
    const value = JSON.parse(JSON.stringify({ ...theme(), version: 1, unknown: 'ignored', __proto__: { polluted: true } }));
    assert.deepEqual(themes.normalizeTheme(value), theme());
    for (const invalid of [null, [], theme({ id: '__proto__' }), theme({ id: 'theme-' }), theme({ name: ' ' }), theme({ name: 'a'.repeat(61) }), theme({ name: 'bad\nname' }), theme({ base: 'light/forest' }), theme({ css: 7 })]) assert.throws(() => themes.normalizeTheme(invalid));
  });
  check('non-array and wholly malformed stored libraries safely fall back', () => {
    for (const userThemes of [{}, [theme({ css: '@import "remote";' })], ['theme-test']]) {
      const restored = preferences.readUIPreferences({ userThemes, selectedThemeId: 'theme-test', tabSize: 3 });
      assert.deepEqual(restored.userThemes, []); assert.equal(restored.selectedThemeId, ''); assert.equal(restored.tabSize, 3);
    }
    assert.equal(preferences.readUIPreferences({ userThemes: [theme()], selectedThemeId: 'missing' }).selectedThemeId, '');
  });
  check('mixed stored libraries recover valid entries in order without losing selections or unrelated settings', () => {
    const first = theme({ id: 'theme-first', name: 'First' });
    const second = theme({ id: 'theme-second', name: 'Second', css: ':root { --accent: #123456; }' });
    const malformed = theme({ id: 'theme-broken', css: '@import "remote";' });
    const restored = preferences.readUIPreferences({ userThemes: [first, malformed, theme({ id: 'theme-first', name: 'Duplicate' }), second, {}], selectedThemeId: 'theme-second', tabSize: 3, density: 'comfortable' });
    assert.deepEqual(restored.userThemes, [first, second]);
    assert.equal(restored.selectedThemeId, 'theme-second');
    assert.equal(restored.tabSize, 3); assert.equal(restored.density, 'comfortable');
    const dangling = preferences.readUIPreferences({ userThemes: [first, theme({ id: 'theme-dangling', css: '@import "remote";' })], selectedThemeId: 'theme-dangling' });
    assert.deepEqual(dangling.userThemes, [first]); assert.equal(dangling.selectedThemeId, '');
    assert.equal(preferences.readUIPreferences({ userThemes: [first], selectedThemeId: 'theme-missing' }).selectedThemeId, '');
  });
  check('stored recovery respects count and serialized-byte bounds while skipping only overflow', () => {
    const unique = Array.from({ length: 10 }, (_, i) => theme({ id: 'theme-count-' + i, name: 'Count ' + i }));
    const capped = themes.readThemePreferences({ userThemes: unique, selectedThemeId: 'theme-count-8' });
    assert.deepEqual(capped.userThemes, unique.slice(0, 8)); assert.equal(capped.selectedThemeId, '');
    const large = i => theme({ id: 'theme-large-' + i, name: 'Large ' + i, css: 'body { color: red; }' + '\n'.repeat(3900) });
    const small = theme({ id: 'theme-small', name: 'Small', css: ':root { --accent: #abcdef; }' });
    const mixed = [large(0), large(1), large(2), small, large(3)];
    assert.ok(themes.byteLength(JSON.stringify(mixed.slice(0, 4))) <= themes.MAX_THEME_LIBRARY_BYTES);
    assert.ok(themes.byteLength(JSON.stringify(mixed)) > themes.MAX_THEME_LIBRARY_BYTES);
    const bounded = themes.readThemePreferences({ userThemes: mixed, selectedThemeId: 'theme-small' });
    assert.deepEqual(bounded.userThemes, mixed.slice(0, 4)); assert.equal(bounded.selectedThemeId, 'theme-small');
  });
  check('standalone versioned themes import under a fresh validated ID', () => {
    const exported = themes.exportTheme(theme());
    assert.equal(JSON.parse(exported).version, 1);
    assert.deepEqual(themes.importTheme(exported, 'theme-new'), theme({ id: 'theme-new' }));
    for (const text of ['{', '{}', JSON.stringify({ ...theme(), version: 2 }), JSON.stringify({ ...theme({ id: '__proto__' }), version: 1 }), ' '.repeat(themes.MAX_THEME_FILE_BYTES + 1)]) assert.throws(() => themes.importTheme(text, 'theme-new'));
  });
  check('CSS policy rejects resource functions variables comments escapes and at-rules before browser parsing', () => {
    for (const css of ['@IMPORT "https://evil.invalid";', 'body { background: URL(https://evil.invalid); }', 'body { background: u/**/rl(x); }', 'body { background: u\\72l(x); }', 'body { background: image-set(foo 1x); }', 'body { background: var(--icon-chevron); }', 'body { --x: url(data:image/svg+xml,x); }', 'body { background: attr(src type(image)); }', 'body { font-family: "Remote"; }', 'broken', 'body { color }', 'body {}']) assert.throws(() => themes.normalizeTheme(theme({ css })), css);
    assert.doesNotThrow(() => themes.normalizeTheme(theme({ css: 'body {display:none} :root {--accent:rgb(1, 2, 3)} .app {color:var(--text)}' })));
    assert.throws(() => themes.compileThemeCSS(theme().css), /browser/i);
  });
  check('per-CSS and count limits are enforced without mutating prior library', () => {
    const previous = [theme()];
    assert.throws(() => themes.normalizeThemeLibrary([...previous, theme({ id: 'theme-large', css: ' '.repeat(4097) })]));
    assert.throws(() => themes.normalizeThemeLibrary(Array.from({ length: 9 }, (_, i) => theme({ id: 'theme-' + i }))));
    assert.deepEqual(previous, [theme()]);
    assert.throws(() => themes.normalizeTheme(theme({ css: 'body{color:é}' })));
  });
  check('serialized library bound includes JSON escaping and UTF-8 name bytes', () => {
    const css = 'body { color: red; }' + '\n'.repeat(3900);
    assert.ok(themes.byteLength(css) < 4096);
    const values = Array.from({ length: 4 }, (_, i) => theme({ id: 'theme-' + i, name: '😀'.repeat(30), css }));
    assert.ok(themes.byteLength(JSON.stringify(values)) > themes.MAX_THEME_LIBRARY_BYTES);
    assert.throws(() => themes.normalizeThemeLibrary(values), /24 KiB/);
    assert.doesNotThrow(() => themes.normalizeThemeLibrary(values.slice(0, 3)));
    assert.equal(themes.byteLength('😀'), 4);
  });
  check('theme recovery chord is reserved from interactive and persisted remapping', () => {
    assert.match(keys.validateShortcut('file.new', 'Ctrl+Shift+F12', {}), /reserved/i);
    assert.deepEqual(keys.readShortcutOverrides({ 'file.new': 'Cmd+Shift+F12' }), {});
  });
  const event = (key, extra = {}) => ({ key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra });

  check('external refresh is opt-in and accepts only a stored boolean', () => {
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.automaticallyReloadExternalChanges, false);
    for (const value of [undefined, null, false, 0, 1, 'true', 'false', {}, []]) {
      assert.equal(preferences.readUIPreferences({ automaticallyReloadExternalChanges: value }).automaticallyReloadExternalChanges, false);
    }
    const stored = JSON.parse(JSON.stringify(preferences.readUIPreferences({ automaticallyReloadExternalChanges: true })));
    assert.equal(preferences.readUIPreferences(stored).automaticallyReloadExternalChanges, true);
    assert.equal(preferences.readUIPreferences(preferences.DEFAULT_UI_PREFERENCES).automaticallyReloadExternalChanges, false);
  });
  check('default indent size is four spaces', () => {
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.tabSize, 4);
    assert.equal(preferences.readUIPreferences({}).tabSize, 4);
  });
  check('settings migration upgrades the old automatic two-space indent only before v2', () => {
    const empty = preferences.migrateSettings({});
    assert.equal(empty.uiSettingsVersion, 3);
    assert.equal(empty.tabSize, undefined);
    const two = preferences.migrateSettings({ tabSize: 2 });
    assert.equal(two.tabSize, 4);
    assert.equal(two.uiSettingsVersion, 3);
    const three = preferences.migrateSettings({ tabSize: 3 });
    assert.equal(three.tabSize, 3);
    assert.equal(three.uiSettingsVersion, 3);
    const marked = { tabSize: 2, uiSettingsVersion: 2 };
    const migrated = preferences.migrateSettings(marked);
    assert.notStrictEqual(migrated, marked);
    assert.equal(migrated.tabSize, 2);
    assert.equal(migrated.uiSettingsVersion, 3);
    assert.deepEqual(marked, { tabSize: 2, uiSettingsVersion: 2 });
    const oldMarker = preferences.migrateSettings({ tabSize: 5, uiSettingsVersion: 1 });
    assert.equal(oldMarker.tabSize, 5);
    assert.equal(oldMarker.uiSettingsVersion, 3);
  });
  check('settings migration replaces the old implicit midnight default once', () => {
    for (const settings of [{}, { uiSettingsVersion: 1 }, { uiSettingsVersion: 2 }, { darkPreset: 'midnight' }, { uiSettingsVersion: 1, darkPreset: 'midnight' }, { uiSettingsVersion: 2, darkPreset: 'midnight' }]) {
      const migrated = preferences.migrateSettings(settings);
      assert.equal(migrated.darkPreset, 'amoled', JSON.stringify(settings));
      assert.equal(migrated.uiSettingsVersion, 3);
      assert.strictEqual(preferences.migrateSettings(migrated), migrated);
    }
    const full = preferences.migrateSettings({ uiSettingsVersion: 2, theme: 'dark', darkPreset: 'midnight', tabSize: 2, density: 'compact' });
    assert.equal(full.darkPreset, 'amoled'); assert.equal(full.tabSize, 2); assert.equal(full.density, 'compact'); assert.equal(full.theme, 'dark');
  });
  check('settings migration preserves built-in, custom and light appearance choices', () => {
    for (const darkPreset of ['charcoal', 'forest', 'dusk']) {
      assert.equal(preferences.migrateSettings({ uiSettingsVersion: 2, darkPreset }).darkPreset, darkPreset);
    }
    const custom = theme();
    const original = { uiSettingsVersion: 2, theme: 'light', darkPreset: 'midnight', lightPreset: 'paper', userThemes: [custom], selectedThemeId: custom.id, accentColor: '#AABBCC', tabSize: 2, focusMode: true };
    const migrated = preferences.migrateSettings(original);
    assert.deepEqual(migrated.userThemes, [custom]); assert.equal(migrated.selectedThemeId, custom.id);
    assert.equal(migrated.theme, 'light'); assert.equal(migrated.lightPreset, 'paper');
    assert.equal(migrated.darkPreset, 'amoled'); assert.equal(migrated.accentColor, '#AABBCC');
    assert.equal(migrated.tabSize, 2); assert.equal(migrated.focusMode, true);
    assert.deepEqual(original.userThemes, [custom]); assert.equal(original.darkPreset, 'midnight');
  });
  check('version 3 keeps an explicit midnight choice after reload', () => {
    const settings = { uiSettingsVersion: 3, darkPreset: 'midnight', tabSize: 2 };
    assert.strictEqual(preferences.migrateSettings(settings), settings);
    assert.equal(preferences.readUIPreferences(settings).darkPreset, 'midnight');
    assert.equal(preferences.migrateSettings({ uiSettingsVersion: 3, darkPreset: 'amoled' }).darkPreset, 'amoled');
  });
  check('existing settings receive safe compact defaults', () => {
    assert.deepEqual(preferences.readUIPreferences({ theme: 'dark', fontSize: 14 }), preferences.DEFAULT_UI_PREFERENCES);
    const value = preferences.readUIPreferences({ accentColor: '#fff;display:none', lineHeight: NaN, readingWidth: 9e9, sidebarWidth: 0, density: null, showStatusBar: 'false' });
    assert.equal(value.accentColor, '#d8d8df');
    assert.equal(value.lineHeight, 1.7);
    assert.equal(value.readingWidth, 1200);
    assert.equal(value.sidebarWidth, 180);
    assert.equal(value.showStatusBar, true);
  });
  check('theme presets accept only the built-in catalog and keep existing defaults', () => {
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.darkPreset, 'amoled');
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.lightPreset, 'default');
    for (const darkPreset of preferences.DARK_PRESETS) assert.equal(preferences.readUIPreferences({ darkPreset }).darkPreset, darkPreset);
    for (const lightPreset of preferences.LIGHT_PRESETS) assert.equal(preferences.readUIPreferences({ lightPreset }).lightPreset, lightPreset);
    for (const darkPreset of [undefined, null, '', 'Amoled', 'dawn', 'amoled;display:none', 1, {}]) {
      assert.equal(preferences.readUIPreferences({ darkPreset }).darkPreset, 'amoled', String(darkPreset));
    }
    for (const lightPreset of [undefined, null, '', 'Paper', 'parchment', 'default;display:none', 1, {}]) {
      assert.equal(preferences.readUIPreferences({ lightPreset }).lightPreset, 'default', String(lightPreset));
    }
  });
  check('theme presets serialize through migration without losing old preferences', () => {
    const custom = { darkPreset: 'forest', lightPreset: 'paper', accentColor: '#AABBCC', editorFont: 'sans', tabSize: 3, lineHeight: 2 };
    const restored = preferences.readUIPreferences(JSON.parse(JSON.stringify(custom)));
    assert.equal(restored.darkPreset, 'forest');
    assert.equal(restored.lightPreset, 'paper');
    assert.equal(restored.accentColor, '#aabbcc');
    assert.equal(restored.editorFont, 'sans');
    assert.equal(restored.tabSize, 3);
    assert.equal(restored.lineHeight, 2);
    const legacy = preferences.migrateSettings({ darkPreset: 'charcoal' });
    assert.equal(legacy.uiSettingsVersion, preferences.UI_SETTINGS_VERSION);
    assert.equal(preferences.UI_SETTINGS_VERSION, 3);
    assert.equal(legacy.darkPreset, 'charcoal');
    const read = preferences.readUIPreferences(legacy);
    assert.equal(read.darkPreset, 'charcoal');
    assert.equal(read.lightPreset, 'default');
    assert.equal(preferences.migrateSettings({ darkPreset: 'dusk', lightPreset: 'paper' }).uiSettingsVersion, 3);
  });
  check('language intelligence requires a new explicit opt-in, including upgrades', () => {
    for (const settings of [{}, {languageIntelligence: true}, {languageIntelligence: false}, {languageIntelligenceEnabled: 'true'}, {languageIntelligenceEnabled: 1}]) assert.equal(preferences.readUIPreferences(settings).languageIntelligenceEnabled, false);
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.languageIntelligenceEnabled, false);
    assert.equal(preferences.readUIPreferences({languageIntelligenceEnabled: true}).languageIntelligenceEnabled, true);
    assert.equal(preferences.readUIPreferences({languageIntelligenceEnabled: false}).languageIntelligenceEnabled, false);
  });
  check('performance mode is opt-in and preserves independent preferences', () => {
    for (const performanceMode of [undefined, null, 'true', 1, false]) assert.equal(preferences.readUIPreferences({performanceMode}).performanceMode, false);
    const restored = preferences.readUIPreferences(JSON.parse(JSON.stringify({performanceMode: true, smoothScrolling: true, languageIntelligenceEnabled: true})));
    assert.equal(restored.performanceMode, true);
    assert.equal(restored.smoothScrolling, true);
    assert.equal(restored.languageIntelligenceEnabled, true);
  });
  check('reduce motion is opt-in, accepts only an explicit true and survives serialization', () => {
    for (const reduceMotion of [undefined, null, 'true', 1, false, {}]) assert.equal(preferences.readUIPreferences({ reduceMotion }).reduceMotion, false, String(reduceMotion));
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.reduceMotion, false);
    assert.equal(preferences.readUIPreferences(JSON.parse(JSON.stringify({ reduceMotion: true, density: 'comfortable' }))).reduceMotion, true);
  });
  check('scripts are opt-in and accept only an explicit true', () => {
    for (const scriptsEnabled of [undefined, null, 'true', 1, 'yes', false, {}]) assert.equal(preferences.readUIPreferences({scriptsEnabled}).scriptsEnabled, false, String(scriptsEnabled));
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.scriptsEnabled, false);
    assert.equal(preferences.readUIPreferences({scriptsEnabled: true}).scriptsEnabled, true);
    assert.equal(preferences.readUIPreferences(JSON.parse(JSON.stringify({scriptsEnabled: true, performanceMode: true}))).scriptsEnabled, true);
  });
  check('custom appearance survives serialization without losing boolean settings', () => {
    const custom = { darkPreset: 'charcoal', density: 'comfortable', accentColor: '#AABBCC', editorFont: 'sans', lineHeight: 2, readingWidth: 700, sidebarWidth: 320, sidebarRailWidth: 'wide', sidebarPosition: 'right', showStatusBar: false, showLineNumbers: false, focusMode: true, smoothScrolling: false };
    assert.deepEqual(preferences.readUIPreferences(JSON.parse(JSON.stringify(custom))), { ...preferences.DEFAULT_UI_PREFERENCES, ...custom, accentColor: '#aabbcc' });
  });
  check('icon strip presets are independent of legacy tool panel widths and density', () => {
    const legacy = preferences.readUIPreferences({ sidebarWidth: 310 });
    assert.equal(legacy.sidebarWidth, 310);
    assert.equal(legacy.sidebarRailWidth, 'standard');
    for (const value of [undefined, null, 'huge', 340, 'wide;display:none']) {
      assert.equal(preferences.readUIPreferences({ sidebarRailWidth: value }).sidebarRailWidth, 'standard');
    }
    for (const [sidebarRailWidth, width] of [['narrow', 40], ['standard', 44], ['wide', 60]]) {
      for (const density of ['compact', 'comfortable']) {
        const restored = preferences.readUIPreferences(JSON.parse(JSON.stringify({ sidebarRailWidth, sidebarWidth: 310, density })));
        assert.equal(restored.sidebarRailWidth, sidebarRailWidth);
        assert.equal(restored.sidebarWidth, 310);
        assert.ok(preferences.preferencesStyle(restored).includes('--rail-size:' + (width + (density === 'comfortable' ? 4 : 0)) + 'px;'));
      }
    }
  });
  check('sidebar position defaults safely and restores either side', () => {
    for (const sidebarPosition of [undefined, null, 'bottom', '', 123]) assert.equal(preferences.readUIPreferences({ sidebarPosition }).sidebarPosition, 'left');
    for (const sidebarPosition of ['left', 'right']) assert.equal(preferences.readUIPreferences(JSON.parse(JSON.stringify({ sidebarPosition }))).sidebarPosition, sidebarPosition);
  });
  check('smooth scrolling defaults on and preserves an explicit off setting', () => {
    for (const smoothScrolling of [undefined, null, 'false', 0]) assert.equal(preferences.readUIPreferences({ smoothScrolling }).smoothScrolling, true);
    for (const smoothScrolling of [true, false]) assert.equal(preferences.readUIPreferences({ smoothScrolling }).smoothScrolling, smoothScrolling);
  });
  check('CSS values are constrained even when callers pass malformed preferences', () => {
    const css = preferences.preferencesStyle({ ...preferences.DEFAULT_UI_PREFERENCES, accentColor: 'red;position:fixed', editorFont: 'url(https://example.invalid)' });
    assert.ok(css.includes('--accent:#d8d8df'));
    assert.ok(css.includes("'IBM Plex Mono'"));
    assert.ok(!css.includes('position') && !css.includes('url('));
  });
  check('default shortcuts are valid and unique', () => {
    const defaults = keys.COMMANDS.map((command) => command.defaultShortcut).filter(Boolean);
    assert.equal(new Set(defaults).size, defaults.length);
    for (const command of keys.COMMANDS) assert.equal(keys.validateShortcut(command.id, command.defaultShortcut, {}), null, command.id);
  });
  check('shortcut syntax normalizes aliases and rejects typing keys and incomplete chords', () => {
    assert.equal(keys.normalizeShortcut('Shift + Ctrl + p'), 'Mod+Shift+P');
    assert.equal(keys.normalizeShortcut('Cmd+,'), 'Mod+,');
    assert.equal(keys.normalizeShortcut('F2'), 'F2');
    for (const value of ['x', 'Enter', 'Alt+E', 'Control', 'Ctrl+', 'F13', 'Ctrl+Ctrl+J']) assert.equal(keys.normalizeShortcut(value), null, value);
  });
  check('normal typing, composition and AltGr do not invoke app actions', () => {
    assert.equal(keys.commandForEvent(event('n'), {}), null);
    assert.equal(keys.commandForEvent(event('n', { ctrlKey: true, isComposing: true }), {}), null);
    assert.equal(keys.commandForEvent(event('s', { ctrlKey: true, altKey: true, getModifierState: (key) => key === 'AltGraph' }), {}), null);
    assert.equal(keys.shortcutFromEvent(event('Dead', { ctrlKey: true })), null);
  });
  check('commands match Ctrl and Command, shifted keys and non-US digit characters', () => {
    assert.equal(keys.commandForEvent(event('n', { ctrlKey: true }), {}), 'file.new');
    assert.equal(keys.commandForEvent(event('k', { metaKey: true }), {}), 'app.commands');
    assert.equal(keys.commandForEvent(event('S', { ctrlKey: true, shiftKey: true }), {}), 'file.saveAs');
    assert.equal(keys.commandForEvent(event('¡', { code: 'Digit1', ctrlKey: true, altKey: true }), {}), 'view.source');
    assert.equal(keys.shortcutFromEvent(event('+', { code: 'Equal', ctrlKey: true, shiftKey: true })), 'Mod+Shift+=');
  });
  check('zoom shortcuts match Ctrl plus, minus, zero, shifted plus and numpad keys', () => {
    assert.equal(keys.commandForEvent(event('=', { code: 'Equal', ctrlKey: true }), {}), 'view.zoomIn');
    assert.equal(keys.commandForEvent(event('-', { code: 'Minus', ctrlKey: true }), {}), 'view.zoomOut');
    assert.equal(keys.commandForEvent(event('0', { code: 'Digit0', ctrlKey: true }), {}), 'view.zoomReset');
    assert.equal(keys.commandForEvent(event('+', { code: 'Equal', ctrlKey: true, shiftKey: true }), {}), 'view.zoomIn');
    assert.equal(keys.commandForEvent(event('+', { code: 'NumpadAdd', ctrlKey: true }), {}), 'view.zoomIn');
    assert.equal(keys.commandForEvent(event('-', { code: 'NumpadSubtract', ctrlKey: true }), {}), 'view.zoomOut');
    assert.equal(keys.commandForEvent(event('=', { ctrlKey: false }), {}), null);
  });
  check('reserved editing shortcuts and collisions produce actionable validation errors', () => {
    assert.match(keys.validateShortcut('file.new', 'Ctrl+Z', {}), /reserved/i);
    assert.match(keys.validateShortcut('file.new', 'Ctrl+S', {}), /Save/);
    assert.equal(keys.validateShortcut('file.new', 'Ctrl+S', { 'file.save': '' }), null);
  });
  check('remapping and disabling work without retaining old command bindings', () => {
    const custom = keys.readShortcutOverrides({ 'file.new': 'Ctrl+Shift+J', 'file.save': '' });
    assert.equal(keys.commandForEvent(event('n', { ctrlKey: true }), custom), null);
    assert.equal(keys.commandForEvent(event('J', { ctrlKey: true, shiftKey: true }), custom), 'file.new');
    assert.equal(keys.commandForEvent(event('s', { ctrlKey: true }), custom), null);
  });
  check('stored swaps survive and malformed conflicting mappings cannot shadow commands', () => {
    assert.deepEqual(keys.readShortcutOverrides({ 'file.new': 'Ctrl+O', 'file.open': 'Ctrl+N' }), { 'file.new': 'Mod+O', 'file.open': 'Mod+N' });
    assert.deepEqual(keys.readShortcutOverrides({ 'file.new': 'Ctrl+S', 'file.open': 'Ctrl+S', 'file.save': 'Ctrl+Z', garbage: 'Ctrl+J' }), {});
    assert.deepEqual(keys.readShortcutOverrides(['Ctrl+J']), {});
  });
  const platform = await server.ssrLoadModule('/src/platform.ts');
  const wheel = await server.ssrLoadModule('/src/wheel.ts');
  check('platform detection recognises Apple platforms from platform, client hints or user agent', () => {
    assert.equal(platform.detectMac({ platform: 'MacIntel' }), true);
    assert.equal(platform.detectMac({ platform: 'iPad' }), true);
    assert.equal(platform.detectMac({ userAgentData: { platform: 'macOS' }, platform: '' }), true);
    assert.equal(platform.detectMac({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true);
    for (const source of [undefined, {}, { platform: 'Linux x86_64' }, { platform: 'Win32' }, { platform: 'linux' }, { platform: 'darwin' }]) assert.equal(platform.detectMac(source), false);
  });
  check('on macOS only Command is the modifier and Control is left to the text system', () => {
    const mac = true;
    for (const key of ['a', 'e', 'k', 'n', 'p', 'f', 'b', 'd', 'h', 'o', 's']) assert.equal(keys.commandForEvent(event(key, { ctrlKey: true }), {}, mac), null, 'Ctrl+' + key);
    assert.equal(keys.shortcutFromEvent(event('n', { ctrlKey: true }), mac), null);
    assert.equal(keys.shortcutFromEvent(event('n', { ctrlKey: true, metaKey: true }), mac), null);
    assert.equal(keys.commandForEvent(event('n', { metaKey: true }), {}, mac), 'file.new');
    assert.equal(keys.commandForEvent(event('k', { metaKey: true }), {}, mac), 'app.commands');
    assert.equal(keys.commandForEvent(event('S', { metaKey: true, shiftKey: true }), {}, mac), 'file.saveAs');
    assert.equal(keys.commandForEvent(event(',', { code: 'Comma', metaKey: true }), {}, mac), 'app.settings');
    assert.equal(keys.commandForEvent(event('F2', { code: 'F2' }), {}, mac), 'file.rename');
    // Other platforms keep accepting both Ctrl and Meta.
    assert.equal(keys.commandForEvent(event('n', { ctrlKey: true }), {}, false), 'file.new');
    assert.equal(keys.commandForEvent(event('n', { metaKey: true }), {}, false), 'file.new');
  });
  check('macOS defaults avoid system shortcuts and missing keys, and stay valid and unique', () => {
    const mac = true;
    assert.equal(keys.defaultShortcut('edit.replace', mac), 'Mod+Alt+F');
    assert.equal(keys.defaultShortcut('edit.replace', false), 'Mod+H');
    assert.equal(keys.defaultShortcut('tab.next', mac), 'Mod+Alt+ArrowRight');
    assert.equal(keys.defaultShortcut('tab.next', false), 'Mod+PageDown');
    assert.equal(keys.commandForEvent(event('h', { metaKey: true }), {}, mac), null);
    assert.equal(keys.commandForEvent(event('f', { metaKey: true, altKey: true }), {}, mac), 'edit.replace');
    assert.equal(keys.commandForEvent(event('ArrowRight', { code: 'ArrowRight', metaKey: true, altKey: true }), {}, mac), 'tab.next');
    const defaults = keys.COMMANDS.map((command) => keys.defaultShortcut(command.id, mac)).filter(Boolean);
    assert.equal(new Set(defaults).size, defaults.length);
    for (const command of keys.COMMANDS) assert.equal(keys.validateShortcut(command.id, keys.defaultShortcut(command.id, mac), {}, mac), null, command.id);
    assert.match(keys.validateShortcut('file.new', 'Cmd+H', {}, mac), /reserved/i);
    assert.equal(keys.validateShortcut('file.new', 'Ctrl+M', {}, false), null);
    assert.deepEqual(keys.readShortcutOverrides({ 'file.new': 'Mod+H', 'file.open': 'Mod+Shift+J' }, mac), { 'file.open': 'Mod+Shift+J' });
  });
  check('one formatter produces Apple glyph labels on macOS and Ctrl labels elsewhere', () => {
    const cases = [['Mod+Shift+S', '⇧⌘S', 'Ctrl+Shift+S'], ['Mod+,', '⌘,', 'Ctrl+,'], ['Mod+Alt+1', '⌥⌘1', 'Ctrl+Alt+1'], ['Mod+Alt+Shift+K', '⌥⇧⌘K', 'Ctrl+Alt+Shift+K'],
      ['F2', 'F2', 'F2'], ['Shift+F12', '⇧F12', 'Shift+F12'], ['Mod+PageDown', '⌘⇟', 'Ctrl+PgDn'], ['Mod+Alt+ArrowRight', '⌥⌘→', 'Ctrl+Alt+ArrowRight'], ['Mod+=', '⌘=', 'Ctrl+='], ['Mod+-', '⌘-', 'Ctrl+-'], ['', '', '']];
    for (const [binding, mac, other] of cases) {
      assert.equal(keys.formatShortcut(binding, true), mac, binding);
      assert.equal(keys.formatShortcut(binding, false), other, binding);
      assert.ok(!keys.formatShortcut(binding, true).includes('Mod') && !keys.formatShortcut(binding, false).includes('Mod'));
    }
  });
  check('every displayed label parses back to its stored binding on both platforms', () => {
    for (const mac of [true, false]) for (const command of keys.COMMANDS) {
      const binding = keys.defaultShortcut(command.id, mac);
      assert.equal(keys.normalizeShortcut(keys.formatShortcut(binding, mac)), binding, command.id + (mac ? ' (mac)' : ''));
    }
    assert.equal(keys.normalizeShortcut('⇧⌘J'), 'Mod+Shift+J');
    assert.equal(keys.normalizeShortcut('⌘ + J'), 'Mod+J');
    assert.equal(keys.normalizeShortcut('⌘'), null);
  });
  check('bindings convert to native menu accelerators, or to nothing when the menu cannot show them', () => {
    const cases = [['Mod+N', 'CmdOrCtrl+N'], ['Mod+Shift+S', 'CmdOrCtrl+Shift+S'], ['Mod+Alt+ArrowRight', 'CmdOrCtrl+Alt+ArrowRight'], ['Mod+,', 'CmdOrCtrl+,'], ['Mod+=', 'CmdOrCtrl+='],
      ['F2', 'F2'], ['Shift+F12', 'Shift+F12'], ['Mod+PageDown', 'CmdOrCtrl+PageDown'], ['Ctrl+Shift+j', 'CmdOrCtrl+Shift+J'], ['', null], ['x', null], ['Mod+', null]];
    for (const [binding, accelerator] of cases) assert.equal(keys.menuAccelerator(binding), accelerator, binding);
    // Every default on both platforms has an accelerator without the internal Mod token.
    for (const mac of [true, false]) for (const command of keys.COMMANDS) {
      const binding = keys.defaultShortcut(command.id, mac);
      if (!binding) continue;
      const accelerator = keys.menuAccelerator(binding);
      assert.ok(accelerator && !accelerator.includes('Mod') && !/[⌘⇧⌥]/u.test(accelerator), command.id);
    }
  });
  check('smooth scrolling defaults follow the platform and stored choices win', () => {
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.smoothScrolling, !platform.isMac);
    assert.equal(preferences.readUIPreferences({ smoothScrolling: false }).smoothScrolling, false);
  });
  check('wheel zoom keeps notch steps and scales continuous pinch input proportionally', () => {
    const step = { in: 1.1, out: 0.9 };
    assert.equal(wheel.wheelZoomFactor({ deltaY: -120, deltaMode: 0 }, step), 1.1);
    assert.equal(wheel.wheelZoomFactor({ deltaY: 100, deltaMode: 0 }, step), 0.9);
    assert.equal(wheel.wheelZoomFactor({ deltaY: -3, deltaMode: 1 }, step), 1.1);
    assert.equal(wheel.wheelZoomFactor({ deltaY: 1, deltaMode: 2 }, step), 0.9);
    assert.equal(wheel.wheelZoomFactor({ deltaY: 0, deltaMode: 0 }, step), 1);
    assert.equal(wheel.isContinuousWheel({ deltaY: 2.5, deltaMode: 0 }), true);
    assert.equal(wheel.isContinuousWheel({ deltaY: 120, deltaMode: 0 }), false);
    assert.equal(wheel.isContinuousWheel({ deltaY: 1, deltaMode: 1 }), false);
    // Twenty small pinch events: proportional to the total delta, in either direction.
    let zoom = 1;
    for (let index = 0; index < 20; index++) zoom *= wheel.wheelZoomFactor({ deltaY: -1.5, deltaMode: 0 }, step);
    assert.ok(Math.abs(zoom - Math.exp(0.3)) < 1e-9, String(zoom));
    assert.ok(zoom < 1.1 ** 20 / 4);
    for (let index = 0; index < 20; index++) zoom *= wheel.wheelZoomFactor({ deltaY: 1.5, deltaMode: 0 }, step);
    assert.ok(Math.abs(zoom - 1) < 1e-9, String(zoom));
    // A two-finger scroll that zooms (the graph) uses the gentler rate: 300 px is 1.8x, not 20x.
    let scrolled = 1;
    for (let index = 0; index < 60; index++) scrolled *= wheel.wheelZoomFactor({ deltaY: -5, deltaMode: 0 }, step, wheel.SCROLL_ZOOM_SENSITIVITY);
    assert.ok(Math.abs(scrolled - Math.exp(0.6)) < 1e-9, String(scrolled));
  });
  check('WebKit pinch gestures report incremental factors and detach their listeners', () => {
    const listeners = new Map();
    const node = { addEventListener: (type, handler) => listeners.set(type, handler), removeEventListener: (type, handler) => { if (listeners.get(type) === handler) listeners.delete(type); } };
    const seen = [];
    const action = wheel.pinchZoom(node, (factor, x, y) => seen.push([Number(factor.toFixed(6)), x, y]));
    let prevented = 0;
    const gesture = (type, scale) => listeners.get(type)({ scale, clientX: 10, clientY: 20, preventDefault: () => { prevented++; } });
    gesture('gesturestart', 1); gesture('gesturechange', 1.2); gesture('gesturechange', 1.5); gesture('gesturechange', 1.5); gesture('gesturechange', Number.NaN); gesture('gestureend', 1.5);
    gesture('gesturestart', 1); gesture('gesturechange', 0.5);
    assert.deepEqual(seen, [[1.2, 10, 20], [1.25, 10, 20], [0.5, 10, 20]]);
    assert.equal(prevented, 8);
    action.destroy();
    assert.equal(listeners.size, 0);
  });
  console.log(`Preferences and shortcuts: ${passed} scenarios passed`);
} finally { await server.close(); }
