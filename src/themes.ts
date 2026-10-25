// Deliberately small local-only CSS: flat style rules, ASCII, no escapes,
// comments, at-rules, strings in values, nesting or resource-bearing functions.
export const DARK_PRESETS = ['midnight', 'charcoal', 'amoled', 'forest', 'dusk'] as const;
export const LIGHT_PRESETS = ['default', 'paper'] as const;
export const THEME_BASES = [...DARK_PRESETS.map(preset => `dark/${preset}`), ...LIGHT_PRESETS.map(preset => `light/${preset}`)];
export const MAX_THEME_CSS_BYTES = 4096;
export const MAX_THEMES = 8;
export const MAX_THEME_LIBRARY_BYTES = 24 * 1024;
export const MAX_THEME_FILE_BYTES = 12 * 1024;
export type UserTheme = { id: string; name: string; base: string; css: string };
export const STARTER_CSS = ':root {\n  --bg: #202838;\n  --bar: #283448;\n  --accent: #a6d8ff;\n}\n.workspace-bar { color: #a6d8ff; }';
export const byteLength = (value: string) => new TextEncoder().encode(value).length;
const fail = (message: string): never => { throw new Error(message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeVariables = new Set(('bg bar panel preview text heading muted subtle border hover active code selection error menu accent scrollbar-track scrollbar-thumb scrollbar-thumb-hover code-keyword code-string code-number editor-font-family editor-line-height reading-width sidebar-width rail-size document-padding').split(' ').map(name => '--' + name));
type Rule = { selector: string; declarations: { property: string; value: string }[] };

function parseCSS(css: string): Rule[] {
  if (byteLength(css) > MAX_THEME_CSS_BYTES) fail('CSS must be at most 4096 UTF-8 bytes. Shorten it before saving.');
  if (/[^\x09\x0a\x0d\x20-\x7e]|[\\@]|\/\*|\*\//u.test(css)) fail('Use ASCII flat CSS rules only; escapes, comments and @ rules are not supported.');
  const rules: Rule[] = [];
  let rest = css.trim();
  while (rest) {
    const match = /^([^{}]+)\{([^{}]*)\}/u.exec(rest);
    if (!match) fail('Invalid CSS. Use selector { property: value; } without nested rules.');
    const selector = match![1].trim();
    if (!selector || /[;<>]/u.test(selector)) fail('Invalid CSS selector.');
    const declarations = match![2].split(';').filter(part => part.trim()).map(part => {
      const declaration = /^\s*(--[a-zA-Z][\w-]*|[a-zA-Z][\w-]*)\s*:\s*(.+?)\s*$/u.exec(part);
      if (!declaration) fail('Invalid declaration. Use property: value; (no semicolons inside values).');
      const [, property, value] = declaration!;
      if (!/^[\w\s#.,%()+*/!\-]+$/u.test(value)) fail('Values support plain keywords, numbers, colors and safe functions; no quoted strings or URLs.');
      for (const fn of value.matchAll(/([\w-]+)\s*\(/gu)) {
        if (!['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'var'].includes(fn[1].toLowerCase())) fail('Only rgb, rgba, hsl, hsla, calc, min, max, clamp and var functions are supported. No URLs, fonts or images.');
      }
      for (const variable of value.matchAll(/var\s*\(\s*(--[\w-]+)/giu)) {
        if (!safeVariables.has(variable[1])) fail('var() may reference only documented built-in color and layout tokens, not resource variables.');
      }
      return { property, value };
    });
    if (!declarations.length) fail('Each rule needs at least one declaration.');
    rules.push({ selector, declarations });
    rest = rest.slice(match![0].length).trim();
  }
  if (!rules.length) fail('Enter at least one CSS rule.');
  return rules;
}

export function normalizeTheme(value: unknown): UserTheme {
  if (!record(value)) return fail('Theme must be a JSON object.');
  const { id, name, base, css } = value;
  if (typeof id !== 'string' || !/^theme-[a-zA-Z0-9-]{1,64}$/u.test(id)) fail('Invalid local theme ID.');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || /[\x00-\x1f\x7f]/u.test(name)) fail('Name must contain 1–60 characters without control characters.');
  if (typeof base !== 'string' || !THEME_BASES.includes(base)) fail('Choose a built-in theme base.');
  if (typeof css !== 'string') fail('Theme CSS must be text.');
  parseCSS(css as string);
  return { id: id as string, name: (name as string).trim(), base: base as string, css: css as string };
}

export function normalizeThemeLibrary(value: unknown): UserTheme[] {
  if (!Array.isArray(value) || value.length > MAX_THEMES) return fail('Keep at most 8 local themes. Delete one before adding another.');
  const library = value.map(normalizeTheme);
  if (new Set(library.map(theme => theme.id)).size !== library.length) fail('Theme IDs must be unique.');
  // Measure the actual serialized, escaped UTF-8 representation, not CSS length.
  if (byteLength(JSON.stringify(library)) > MAX_THEME_LIBRARY_BYTES) fail('Theme library exceeds 24 KiB. Shorten CSS or delete a theme first.');
  return library;
}

export function readThemePreferences(settings: Record<string, unknown>) {
  const raw = settings.userThemes;
  if (!Array.isArray(raw)) return { userThemes: [] as UserTheme[], selectedThemeId: '' };
  const userThemes: UserTheme[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (userThemes.length >= MAX_THEMES) break;
    let theme: UserTheme;
    try { theme = normalizeTheme(entry); } catch { continue; }
    if (ids.has(theme.id)) continue;
    // Keep the serialized bound; a later, smaller valid entry may still fit.
    if (byteLength(JSON.stringify([...userThemes, theme])) > MAX_THEME_LIBRARY_BYTES) continue;
    ids.add(theme.id);
    userThemes.push(theme);
  }
  const selectedThemeId = typeof settings.selectedThemeId === 'string' && ids.has(settings.selectedThemeId) ? settings.selectedThemeId : '';
  return { userThemes, selectedThemeId };
}

export function importTheme(text: string, id: string): UserTheme {
  if (byteLength(text) > MAX_THEME_FILE_BYTES) fail('Theme file exceeds 12 KiB. Choose a smaller standalone theme JSON file.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { return fail('Invalid JSON. Import a version 1 Notation theme JSON file.'); }
  if (!record(data) || data.version !== 1) return fail('Expected a version 1 Notation theme JSON object.');
  // Validate a supplied ID but never use it as the new local identity.
  return normalizeTheme({ ...normalizeTheme(data), id });
}

export function exportTheme(theme: UserTheme): string {
  return JSON.stringify({ version: 1, ...normalizeTheme(theme) }, null, 2);
}

// No unvalidated text is ever attached to a document, even for parsing.
// SSR normalization above is pure; unsupported browsers fail closed here.
export function compileThemeCSS(css: string): string {
  const rules = parseCSS(css);
  if (typeof CSSStyleSheet === 'undefined' || typeof CSS === 'undefined' || !CSS.supports) fail('This browser cannot safely validate themes. Use a current desktop browser.');
  let sheet: CSSStyleSheet;
  try { sheet = new CSSStyleSheet(); } catch { return fail('This browser needs constructable stylesheet support to validate themes.'); }
  const output: string[] = [];
  for (const rule of rules) {
    try {
      sheet.insertRule(`${rule.selector} {}`, 0);
      if (sheet.cssRules.length !== 1 || sheet.cssRules[0].type !== 1) fail('Invalid selector.');
      sheet.deleteRule(0);
    } catch { return fail('Invalid CSS selector: ' + rule.selector); }
    const declarations = rule.declarations.map(({ property, value }) => {
      const plain = value.replace(/\s*!important\s*$/iu, '');
      if (!CSS.supports(property, plain)) fail(`Invalid CSS value for ${property}. Check the property and value.`);
      return `${property}:${value};`;
    }).join('');
    output.push(`${rule.selector}{${declarations}}`);
    if (rule.selector.toLowerCase() === ':root') {
      // Tokens must beat preset specificity AND the app's inline preferences.
      const tokens = rule.declarations.filter(item => item.property.startsWith('--')).map(({ property, value }) => `${property}:${value.replace(/\s*!important\s*$/iu, '')}!important;`).join('');
      if (tokens) output.push(`:root:root:root:root,.app{${tokens}}`);
    }
  }
  return output.join('\n');
}
