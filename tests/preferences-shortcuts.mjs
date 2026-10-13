import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ cacheDir: 'node_modules/.vite-preferences-shortcuts', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, logLevel: 'error' });
let passed = 0;
function check(name, run) { run(); passed++; console.log('✓ ' + name); }
try {
  const preferences = await server.ssrLoadModule('/src/preferences.ts');
  const keys = await server.ssrLoadModule('/src/shortcuts.ts');
  const event = (key, extra = {}) => ({ key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra });

  check('existing settings receive safe compact defaults', () => {
    assert.deepEqual(preferences.readUIPreferences({ theme: 'dark', fontSize: 14 }), preferences.DEFAULT_UI_PREFERENCES);
    const value = preferences.readUIPreferences({ accentColor: '#fff;display:none', lineHeight: NaN, readingWidth: 9e9, sidebarWidth: 0, density: null, showStatusBar: 'false' });
    assert.equal(value.accentColor, '#d8d8df');
    assert.equal(value.lineHeight, 1.7);
    assert.equal(value.readingWidth, 1200);
    assert.equal(value.sidebarWidth, 180);
    assert.equal(value.showStatusBar, true);
  });
  check('custom appearance survives serialization without losing boolean settings', () => {
    const custom = { darkPreset: 'charcoal', density: 'comfortable', accentColor: '#AABBCC', editorFont: 'sans', lineHeight: 2, readingWidth: 700, sidebarWidth: 320, showStatusBar: false, showLineNumbers: false, focusMode: true };
    assert.deepEqual(preferences.readUIPreferences(JSON.parse(JSON.stringify(custom))), { ...custom, accentColor: '#aabbcc' });
  });
  check('CSS values are constrained even when callers pass malformed preferences', () => {
    const css = preferences.preferencesStyle({ ...preferences.DEFAULT_UI_PREFERENCES, accentColor: 'red;position:fixed', editorFont: 'url(https://example.invalid)' });
    assert.ok(css.includes('--accent:#d8d8df'));
    assert.ok(css.includes("'Geist Mono'"));
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
