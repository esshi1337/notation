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
    assert.equal(restored.tabSize, 3); assert.equal(restored.density, 'comfortable'); assert.equal(preferences.UI_SETTINGS_VERSION, 2);
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

  check('default indent size is four spaces', () => {
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.tabSize, 4);
    assert.equal(preferences.readUIPreferences({}).tabSize, 4);
  });
  check('settings migration upgrades the old automatic two-space indent once', () => {
    const empty = preferences.migrateSettings({});
    assert.equal(empty.uiSettingsVersion, 2);
    assert.equal(empty.tabSize, undefined);
    const two = preferences.migrateSettings({ tabSize: 2 });
    assert.equal(two.tabSize, 4);
    assert.equal(two.uiSettingsVersion, 2);
    const three = preferences.migrateSettings({ tabSize: 3 });
    assert.equal(three.tabSize, 3);
    assert.equal(three.uiSettingsVersion, 2);
    const marked = { tabSize: 2, uiSettingsVersion: 2 };
    assert.strictEqual(preferences.migrateSettings(marked), marked);
    const oldMarker = preferences.migrateSettings({ tabSize: 5, uiSettingsVersion: 1 });
    assert.equal(oldMarker.tabSize, 5);
    assert.equal(oldMarker.uiSettingsVersion, 2);
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
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.darkPreset, 'midnight');
    assert.equal(preferences.DEFAULT_UI_PREFERENCES.lightPreset, 'default');
    for (const darkPreset of preferences.DARK_PRESETS) assert.equal(preferences.readUIPreferences({ darkPreset }).darkPreset, darkPreset);
    for (const lightPreset of preferences.LIGHT_PRESETS) assert.equal(preferences.readUIPreferences({ lightPreset }).lightPreset, lightPreset);
    for (const darkPreset of [undefined, null, '', 'Amoled', 'dawn', 'amoled;display:none', 1, {}]) {
      assert.equal(preferences.readUIPreferences({ darkPreset }).darkPreset, 'midnight', String(darkPreset));
    }
    for (const lightPreset of [undefined, null, '', 'Paper', 'parchment', 'default;display:none', 1, {}]) {
      assert.equal(preferences.readUIPreferences({ lightPreset }).lightPreset, 'default', String(lightPreset));
    }
  });
  check('theme presets serialize without a settings version bump or losing old preferences', () => {
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
    assert.equal(preferences.UI_SETTINGS_VERSION, 2);
    const read = preferences.readUIPreferences(legacy);
    assert.equal(read.darkPreset, 'charcoal');
    assert.equal(read.lightPreset, 'default');
    assert.equal(preferences.migrateSettings({ darkPreset: 'dusk', lightPreset: 'paper' }).uiSettingsVersion, 2);
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
  console.log(`Preferences and shortcuts: ${passed} scenarios passed`);
} finally { await server.close(); }
