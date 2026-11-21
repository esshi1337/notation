// Tests the macOS WebKit job does not run, each with the reason. Everything
// else in tests/e2e runs on WebKit. Remove an entry when its cause is fixed;
// do not add one without a reason that names the WebKit or macOS difference.
export const webkitExclusions: Array<{ title: string; reason: string }> = [
  { title: 'code buffers stay usable with many tabs and a large source file', reason: 'Measures heap through a Chromium DevTools (CDP) session.' },
  { title: 'closed heavy buffers release their editors across repeated workload rounds', reason: 'Measures heap through a Chromium DevTools (CDP) session.' },
  { title: 'restored buffers can be closed without retaining the startup session snapshot', reason: 'Measures heap through a Chromium DevTools (CDP) session.' },
  { title: 'Hemingway mode permits typing, newlines, and paste at an empty caret', reason: 'Needs the clipboard-write permission, which Playwright can grant only in Chromium.' },
  { title: 'large clipboard paste uses reduced source, retains undo and restores the chosen layout', reason: 'Needs the clipboard-write permission, which Playwright can grant only in Chromium.' },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const webkitGrepInvert = webkitExclusions.map(({ title }) => new RegExp(escape(title), 'u'));
