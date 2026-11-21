// Tests the macOS WebKit job does not run, each with the reason. Everything
// else in tests/e2e runs on WebKit. Remove an entry when its cause is fixed;
// do not add one without a reason that names the WebKit or macOS difference.
export const webkitExclusions: Array<{ title: string; reason: string }> = [
  // Chromium-only test APIs.
  { title: 'code buffers stay usable with many tabs and a large source file', reason: 'Measures heap through a Chromium DevTools (CDP) session.' },
  { title: 'closed heavy buffers release their editors across repeated workload rounds', reason: 'Measures heap through a Chromium DevTools (CDP) session.' },
  { title: 'restored buffers can be closed without retaining the startup session snapshot', reason: 'Measures heap through a Chromium DevTools (CDP) session.' },
  { title: 'a pointer-opened menu shows no keyboard focus until a key is used', reason: 'Drives input through a Chromium DevTools (CDP) session.' },
  { title: 'Hemingway mode permits typing, newlines, and paste at an empty caret', reason: 'Needs the clipboard-write permission, which Playwright can grant only in Chromium.' },
  { title: 'large clipboard paste uses reduced source, retains undo and restores the chosen layout', reason: 'Needs the clipboard-write permission, which Playwright can grant only in Chromium.' },

  // macOS WebKit focus behaviour: a click does not focus a button, and Tab
  // skips buttons unless Full Keyboard Access is on. These tests assert the
  // Chromium/Linux behaviour.
  { title: 'searches command labels, runs a command by keyboard, and restores focus on Escape', reason: 'Expects the clicked Commands button to hold focus; macOS WebKit does not focus buttons on click.' },
  { title: 'custom dropdown supports keyboard commit, escape, outside click and narrow containment', reason: 'Was: Escape after clicking a dropdown closed Settings, because macOS WebKit does not focus a clicked button. Fixed in the app (focus follows clicks; Escape closes an open dropdown first) and covered by "focus follows a click even where the engine does not focus buttons"; kept excluded until the macOS job can confirm it.' },
  { title: 'Settings traps focus, closes with Escape, restores focus, and persists preferences', reason: 'Counts Tab stops; macOS WebKit skips buttons on Tab by default.' },
  { title: 'black sticky paper and bars are true black and the editor has no focus frame while buttons keep keyboard focus', reason: 'Expects Tab to focus a toolbar button; macOS WebKit skips buttons on Tab by default.' },

  // Rendering differences.
  { title: 'gutter font size tracks the editor font size and stays aligned', reason: 'WebKit reports the computed size as a 32-bit float (19.200001px) where the test expects 19.2px.' },
  { title: 'the gutter hugs the centered source column in a wide pane', reason: 'WebKit reports the computed size as a 32-bit float (19.200001px) where the test expects 19.2px.' },
  { title: 'chrome controls ease their states with the shared motion tokens', reason: 'Asserts a 2px ring after Tab plus a script focus() on a button. macOS WebKit does not treat that as keyboard focus (Tab skips buttons there), so :focus-visible does not match and the computed outline is the unfocused 3px/none. The same steps give 2px solid in WebKitGTK; the ring itself is covered by the Chromium run.' },
  { title: 'overlay scrollbar thumbs hide beneath an open header menu and modal dialogs', reason: 'Asserts computed scrollbar-color, which Safari supports only from 26.2. The rule under test targets engines that composite overlay thumbs above the page and support scrollbar-color (WebKitGTK); the test now skips itself where the property is unsupported, so this entry can go once the CI WebKit supports it.' },
  { title: 'small toolbar preserves selection for pointer and keyboard, native undo and bullets toggle', reason: 'Rich-text formatting through execCommand yields different markup and undo steps in WebKit; needs a check on a real Mac.' },

  // The wheel animator is for notched mice on Linux and Windows and never
  // runs on macOS. Its tests dispatch synthetic wheel events, to which WebKit
  // also applies its own default scrolling.
  { title: 'smooth-scrolling.spec.ts', reason: 'The wheel animator is disabled on macOS; WebKit scrolls natively on synthetic wheel events.' },
  { title: 'small wheel steps animate in the real split editor, preview, and Live Preview', reason: 'The wheel animator is disabled on macOS; WebKit scrolls natively on synthetic wheel events.' },
  { title: 'editor controls use optional smooth scrolling without moving the pinned specimen', reason: 'Toggles the smooth-scrolling preference, which is off and disabled on macOS (covered there by mac-input.spec.ts).' },
  { title: 'smooth scrolling can be disabled and the choice survives a reload', reason: 'Toggles the smooth-scrolling preference, which is off and disabled on macOS (covered there by mac-input.spec.ts).' },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const webkitGrepInvert = webkitExclusions.map(({ title }) => new RegExp(escape(title), 'u'));
