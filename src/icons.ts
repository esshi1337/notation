import type { CommandId } from './shortcuts';

export type IconTheme = 'dark' | 'light';
export type IconName = 'mark' | 'settings' | 'export' | 'code' | 'table' | 'history' | 'graph' | 'workspace' | 'folder' | 'plus' | 'save' | 'file' | 'close' | 'search' | 'chevron' | 'play' | 'check' | 'checkbox-check';

type SizedAssets = Record<number, string>;
type IconAsset = { dark: SizedAssets; light: SizedAssets };
const path = (context: number, file: string) => `/identity/${context}-${file}.svg`;

// These are the unmodified Figma exports. Size-specific entries keep each icon
// on its exported canvas; the component only scales when a context has no
// matching export (for example, the 20px light search icon).
export const ICON_ASSETS: Record<IconName, IconAsset> = {
  mark: { dark: { 18: path(0, '9dfae') }, light: { 18: path(4, '7cd9f') } },
  settings: { dark: { 18: path(0, 'eddad') }, light: { 18: path(4, '63c20') } },
  export: { dark: { 18: path(0, '517f1') }, light: { 18: path(4, '8654c') } },
  code: { dark: { 18: path(0, 'd5643') }, light: { 18: path(4, '619a9') } },
  table: { dark: { 18: path(0, '102d5') }, light: { 18: path(4, 'e0a91') } },
  history: { dark: { 18: path(0, 'd4caf') }, light: { 18: path(4, '4ea46') } },
  graph: { dark: { 18: path(0, '0f3b6') }, light: { 18: path(4, '85789') } },
  workspace: { dark: { 18: path(0, 'c9aaa') }, light: { 18: path(4, '814b1') } },
  folder: { dark: { 18: path(0, '5ab1b') }, light: { 18: path(4, '77aff') } },
  plus: { dark: { 18: path(0, 'a3bc6') }, light: { 18: path(4, '0e332') } },
  save: { dark: { 18: path(2, '3d886') }, light: { 18: path(2, '3d886') } },
  file: { dark: { 14: path(0, 'cdc53') }, light: { 14: path(4, '53750') } },
  close: { dark: { 12: path(0, 'c0cd2'), 14: path(1, '5ecdd') }, light: { 12: path(4, '7db3a') } },
  search: { dark: { 16: path(0, '2cf7a'), 18: path(2, '54b64'), 20: path(3, '0eb1a') }, light: { 16: path(4, '6002f') } },
  chevron: { dark: { 14: path(0, '1fc89') }, light: { 14: path(4, '80597') } },
  play: { dark: { 12: path(0, '83198') }, light: { 12: path(4, 'b5aa4') } },
  check: { dark: { 12: path(0, '9bd4d') }, light: { 12: path(4, '7bfac') } },
  'checkbox-check': { dark: { 16: path(1, 'decbc') }, light: { 16: path(1, 'decbc') } },
};

function sizedSource(assets: SizedAssets, size: number) {
  if (assets[size]) return assets[size];
  const nearest = Object.keys(assets).map(Number).sort((a, b) => Math.abs(a - size) - Math.abs(b - size))[0];
  return assets[nearest];
}

export function iconSource(name: IconName, size: number, theme: IconTheme) {
  return sizedSource(ICON_ASSETS[name][theme], size);
}

const commandIcons: Partial<Record<CommandId, IconName>> = {
  'file.new': 'plus', 'file.newCanvas': 'plus', 'file.open': 'folder', 'file.save': 'save', 'file.saveAs': 'save', 'file.rename': 'file', 'panel.export': 'export',
  'edit.undo': 'history', 'edit.redo': 'history', 'edit.replace': 'search', 'edit.gotoLine': 'search', 'edit.find': 'search',
  'tab.close': 'close', 'tab.next': 'file', 'tab.previous': 'file',
  'view.hemingway': 'file', 'view.source': 'code', 'view.split': 'table', 'view.preview': 'file', 'view.live': 'file', 'view.focus': 'file',
  'panel.templates': 'file', 'panel.table': 'table', 'panel.explorer': 'folder', 'panel.workspace': 'workspace', 'panel.graph': 'graph', 'panel.git': 'graph',
  'panel.history': 'history', 'panel.properties': 'table', 'panel.scripts': 'code', 'app.settings': 'settings', 'app.commands': 'search', 'block.actions': 'code',
};

export function commandIcon(id: CommandId): IconName {
  return commandIcons[id] ?? (id.startsWith('fold.') ? 'chevron' : id.startsWith('insert.') ? 'plus' : id.startsWith('block.') ? 'code' : 'file');
}
