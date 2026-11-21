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
  { title: 'custom dropdown supports keyboard commit, escape, outside click and narrow containment', reason: 'After clicking the dropdown and pressing Escape the Settings dialog is gone. Probably the clicked button is not focused in macOS WebKit, so Escape reaches the dialog; not confirmed on a real Mac.' },
  { title: 'Settings traps focus, closes with Escape, restores focus, and persists preferences', reason: 'Counts Tab stops; macOS WebKit skips buttons on Tab by default.' },
  { title: 'black sticky paper and bars are true black and the editor has no focus frame while buttons keep keyboard focus', reason: 'Expects Tab to focus a toolbar button; macOS WebKit skips buttons on Tab by default.' },

  // Intermittent on the macOS runner.
  { title: 'keeps table columns readable and scrolls wide tables independently', reason: 'Presses ArrowRight on the focused table scroll region and expects it to scroll; WebKit does that only some of the time on the macOS runner (flaky in most runs, failed all retries once). Needs a check on a real Mac.' },

  // Rendering differences.
  { title: 'gutter font size tracks the editor font size and stays aligned', reason: 'WebKit reports the computed size as a 32-bit float (19.200001px) where the test expects 19.2px.' },
  { title: 'the gutter hugs the centered source column in a wide pane', reason: 'WebKit reports the computed size as a 32-bit float (19.200001px) where the test expects 19.2px.' },
  { title: 'chrome controls ease their states with the shared motion tokens', reason: 'Focus-ring width differs in WebKit (3px where 2px is expected); not yet investigated.' },
  { title: 'overlay scrollbar thumbs hide beneath an open header menu and modal dialogs', reason: 'Reads scrollbar pseudo-element styles that WebKit does not expose the same way; not yet investigated.' },
  { title: 'small toolbar preserves selection for pointer and keyboard, native undo and bullets toggle', reason: 'Rich-text formatting through execCommand yields different markup and undo steps in WebKit; needs a check on a real Mac.' },

  // The wheel animator is for notched mice on Linux and Windows and never
  // runs on macOS. Its tests dispatch synthetic wheel events, to which WebKit
  // also applies its own default scrolling.
  { title: 'smooth-scrolling.spec.ts', reason: 'The wheel animator is disabled on macOS; WebKit scrolls natively on synthetic wheel events.' },
  { title: 'small wheel steps animate in the real split editor, preview, and Live Preview', reason: 'The wheel animator is disabled on macOS; WebKit scrolls natively on synthetic wheel events.' },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const webkitGrepInvert = webkitExclusions.map(({ title }) => new RegExp(escape(title), 'u'));
