import { insertionCommands } from './insertion-templates';
export const COMMANDS = [
  { id: 'file.new', label: 'New', group: 'Document', defaultShortcut: 'Mod+N' },
  { id: 'file.newCanvas', label: 'New canvas', group: 'Document', defaultShortcut: '' },
  { id: 'file.open', label: 'Open', group: 'Document', defaultShortcut: 'Mod+O' },
  { id: 'file.save', label: 'Save', group: 'Document', defaultShortcut: 'Mod+S' },
  { id: 'file.saveAs', label: 'Save As', group: 'Document', defaultShortcut: 'Mod+Shift+S' },
  { id: 'file.rename', label: 'Rename document', group: 'Document', defaultShortcut: 'F2' },
  { id: 'panel.export', label: 'Export', group: 'Document', defaultShortcut: '' },
  { id: 'edit.undo', label: 'Undo', group: 'Editing', defaultShortcut: '' },
  { id: 'edit.redo', label: 'Redo', group: 'Editing', defaultShortcut: '' },
  { id: 'edit.replace', label: 'Find and replace', group: 'Editing', defaultShortcut: 'Mod+H' },
  { id: 'edit.gotoLine', label: 'Go to line', group: 'Editing', defaultShortcut: 'Mod+L' },
  { id: 'edit.find', label: 'Find', group: 'Editing', defaultShortcut: 'Mod+F' },
  { id: 'tab.close', label: 'Close tab', group: 'Tabs', defaultShortcut: 'Mod+W' },
  { id: 'tab.next', label: 'Next tab', group: 'Tabs', defaultShortcut: 'Mod+PageDown' },
  { id: 'tab.previous', label: 'Previous tab', group: 'Tabs', defaultShortcut: 'Mod+PageUp' },
  { id: 'view.hemingway', label: 'Hemingway mode', group: 'View', defaultShortcut: '' },
  { id: 'view.source', label: 'Source', group: 'View', defaultShortcut: 'Mod+Alt+1' },
  { id: 'view.split', label: 'Split', group: 'View', defaultShortcut: 'Mod+Alt+2' },
  { id: 'view.preview', label: 'Preview', group: 'View', defaultShortcut: 'Mod+Alt+3' },
  { id: 'view.live', label: 'Live Preview', group: 'View', defaultShortcut: 'Mod+Alt+4' },
  { id: 'view.focus', label: 'Focus mode', group: 'View', defaultShortcut: 'Mod+Shift+F' },
  { id: 'panel.templates', label: 'Templates', group: 'Panels', defaultShortcut: '' },
  { id: 'panel.table', label: 'Table editor', group: 'Panels', defaultShortcut: '' },
  { id: 'panel.explorer', label: 'Explorer', group: 'Panels', defaultShortcut: 'Mod+Shift+E' },
  { id: 'panel.workspace', label: 'Workspace', group: 'Panels', defaultShortcut: 'Mod+Shift+O' },
  { id: 'panel.graph', label: 'Note graph', group: 'Panels', defaultShortcut: '' },
  { id: 'panel.git', label: 'Git', group: 'Panels', defaultShortcut: 'Mod+Shift+G' },
  { id: 'panel.history', label: 'History', group: 'Panels', defaultShortcut: 'Mod+Alt+H' },
  { id: 'panel.properties', label: 'Properties', group: 'Panels', defaultShortcut: '' },
  { id: 'panel.scripts', label: 'Scripts', group: 'Panels', defaultShortcut: 'Mod+Alt+S' },
  { id: 'app.settings', label: 'Settings', group: 'Application', defaultShortcut: 'Mod+,' },
  { id: 'app.commands', label: 'Commands', group: 'Application', defaultShortcut: 'Mod+K' },
  { id: 'block.actions', label: 'Block actions', group: 'Blocks', defaultShortcut: 'Mod+/' },
  { id: 'block.moveUp', label: 'Move up', group: 'Blocks', defaultShortcut: '' },
  { id: 'block.moveDown', label: 'Move down', group: 'Blocks', defaultShortcut: '' },
  { id: 'block.duplicate', label: 'Duplicate', group: 'Blocks', defaultShortcut: '' },
  { id: 'block.delete', label: 'Delete', group: 'Blocks', defaultShortcut: '' },
  { id: 'block.heading', label: 'Turn into heading', group: 'Blocks', defaultShortcut: '' },
  { id: 'block.paragraph', label: 'Turn into paragraph', group: 'Blocks', defaultShortcut: '' },
  { id: 'block.task', label: 'Turn into task', group: 'Blocks', defaultShortcut: '' },
  { id: 'fold.block', label: 'Fold block', group: 'Folding', defaultShortcut: 'Mod+Shift+[' },
  { id: 'fold.unfold', label: 'Unfold block', group: 'Folding', defaultShortcut: 'Mod+Shift+]' },
  { id: 'fold.all', label: 'Fold all', group: 'Folding', defaultShortcut: 'Mod+Alt+[' },
  { id: 'fold.none', label: 'Unfold all', group: 'Folding', defaultShortcut: 'Mod+Alt+]' },
  ...insertionCommands,
] as const;

export type CommandId = typeof COMMANDS[number]['id'];
export type ShortcutOverrides = Partial<Record<CommandId, string>>;
type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'> & { getModifierState?: (key: string) => boolean };
const modifiers = new Set(['Mod', 'Alt', 'Shift']);
const aliases: Record<string, string> = { control: 'Mod', ctrl: 'Mod', command: 'Mod', cmd: 'Mod', meta: 'Mod', mod: 'Mod', alt: 'Alt', option: 'Alt', shift: 'Shift', esc: 'Escape', space: 'Space', ' ': 'Space', pagedown: 'PageDown', pageup: 'PageUp', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', escape: 'Escape' };

export function normalizeShortcut(value: string): string | null {
  if (!value.trim()) return '';
  const parts = value.split('+').map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  const keys = parts.map((part) => aliases[part.toLowerCase()] ?? (part.length === 1 || /^f\d{1,2}$/i.test(part) ? part.toUpperCase() : part));
  const key = keys.pop()!;
  if (modifiers.has(key) || keys.some((part) => !modifiers.has(part)) || new Set(keys).size !== keys.length) return null;
  if (!(key.length === 1 || /^(F([1-9]|1[0-2])|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|Tab|Backspace|Delete|Escape|Space)$/u.test(key))) return null;
  // Plain text, navigation, and AltGr input belong to the document. Bind app
  // commands to Mod combinations or function keys so typing stays intact.
  if (!keys.includes('Mod') && !/^F([1-9]|1[0-2])$/u.test(key)) return null;
  return [...['Mod', 'Alt', 'Shift'].filter((part) => keys.includes(part)), key].join('+');
}

export function shortcutFor(id: CommandId, overrides: ShortcutOverrides): string {
  return overrides[id] ?? COMMANDS.find((command) => command.id === id)!.defaultShortcut;
}

const reserved = new Set(['Mod+A', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+Q', 'Mod+R', 'Mod+Shift+R', 'Mod+Alt+Delete']);

export function validateShortcut(id: CommandId, binding: string, overrides: ShortcutOverrides): string | null {
  const normalized = normalizeShortcut(binding);
  if (normalized === null) return 'Use Ctrl/Cmd with a key, or a function key (F1–F12).';
  if (!normalized) return null;
  if (reserved.has(normalized)) return 'This shortcut is reserved for editing or the system.';
  const conflict = COMMANDS.find((command) => command.id !== id && shortcutFor(command.id, overrides) === normalized);
  return conflict ? `Already assigned to ${conflict.label}. Clear or change that binding first.` : null;
}

export function readShortcutOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate: ShortcutOverrides = {};
  for (const command of COMMANDS) {
    const raw = (value as Record<string, unknown>)[command.id];
    if (typeof raw !== 'string') continue;
    const binding = normalizeShortcut(raw);
    if (binding !== null && !reserved.has(binding)) candidate[command.id] = binding;
  }
  // Keep disabled commands; drop conflicting custom values rather than letting
  // malformed stored preferences silently shadow an existing action.
  for (let attempt = 0; attempt < COMMANDS.length; attempt++) {
    const conflicts = COMMANDS.filter((command) => candidate[command.id] !== undefined && !!validateShortcut(command.id, candidate[command.id]!, candidate));
    if (!conflicts.length) break;
    for (const command of conflicts) delete candidate[command.id];
  }
  return candidate;
}

export function shortcutFromEvent(event: KeyEvent): string | null {
  if (event.isComposing || event.getModifierState?.('AltGraph') || event.key === 'Dead' || ['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'].includes(event.key)) return null;
  const punctuation: Record<string, string> = { Slash: '/', Comma: ',', Period: '.', Equal: '=', Minus: '-', Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
  const key = /^Key[A-Z]$/u.test(event.code) ? event.code.slice(3) : /^Digit\d$/u.test(event.code) ? event.code.slice(5) : punctuation[event.code] ?? event.key;
  return normalizeShortcut([...(event.ctrlKey || event.metaKey ? ['Mod'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+'));
}

export function commandForEvent(event: KeyEvent, overrides: ShortcutOverrides): CommandId | null {
  const binding = shortcutFromEvent(event);
  return binding ? COMMANDS.find((command) => shortcutFor(command.id, overrides) === binding)?.id ?? null : null;
}

export function formatShortcut(binding: string, mac = false): string {
  return binding.replace('Mod', mac ? '⌘' : 'Ctrl').replace('PageDown', 'PgDn').replace('PageUp', 'PgUp');
}
