import { safeSVG } from './safe-svg';

export type DiagramTheme = 'dark' | 'light';

// Mermaid owns global configuration. Every consumer shares this queue so a
// theme change in one preview cannot change another in-flight diagram.
let renderQueue: Promise<void> = Promise.resolve();
let diagramId = 0;

// Rendered SVG per theme and source. Laying a diagram out costs tens of
// milliseconds of main-thread time, and previews re-render the whole document
// after every edit and on every view-mode switch, mostly with unchanged
// diagrams. Only regenerable output lives here; errors are never kept.
const CACHE_ENTRIES = 48, CACHE_BYTES = 4 * 1024 * 1024;
const rendered = new Map<string, { svg: string; id: string }>();
let renderedBytes = 0;
const cacheKey = (theme: DiagramTheme, source: string) => theme + '\u0000' + source;
function recall(key: string): string | undefined {
  const entry = rendered.get(key);
  if (!entry) return undefined;
  rendered.delete(key); rendered.set(key, entry);
  // Element ids, marker references and the scoped stylesheet all carry the
  // render id; give every insertion its own so ids stay unique in the page.
  return entry.svg.replace(new RegExp(entry.id + '(?!\\d)', 'gu'), `notation-diagram-${++diagramId}`);
}
function remember(key: string, svg: string, id: string) {
  if (svg.length > CACHE_BYTES / 4) return;
  renderedBytes += svg.length - (rendered.get(key)?.svg.length ?? 0);
  rendered.delete(key); rendered.set(key, { svg, id });
  for (const [oldest, entry] of rendered) {
    if (rendered.size <= CACHE_ENTRIES && renderedBytes <= CACHE_BYTES) break;
    rendered.delete(oldest); renderedBytes -= entry.svg.length;
  }
}
// Mermaid sizes boxes from measured text. A layout measured before the
// diagram font arrived would be kept wrong, so such renders are not cached.
const fontsSettled = () => { try { return document.fonts.status === 'loaded'; } catch { return false; } };
// A new task, so what is already in the document can paint before the next
// diagram's layout. Not a timer: those are throttled in background windows.
const nextTask = () => new Promise<void>((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); resolve(); }; channel.port2.postMessage(0); });

export function renderMermaidInto(
  target: HTMLElement,
  source: string,
  theme: DiagramTheme,
  current: () => boolean = () => true,
): Promise<void> {
  const valid = () => current() && target.isConnected;
  const key = cacheKey(theme, source);
  const known = recall(key);
  if (known !== undefined) {
    target.classList.remove('diagram-error');
    target.replaceChildren(safeSVG(known));
    target.setAttribute('aria-busy', 'false');
    return Promise.resolve();
  }
  target.setAttribute('aria-busy', 'true');
  target.classList.remove('diagram-error');
  const loading = document.createElement('span');
  loading.className = 'diagram-loading';
  loading.textContent = 'Rendering diagram…';
  target.replaceChildren(loading);

  const task = renderQueue.catch(() => {}).then(async () => {
    if (!valid()) return;
    let sandbox: HTMLDivElement | undefined;
    try {
      if (!source.trim()) {
        target.textContent = 'Start a Mermaid diagram here.';
        return;
      }
      const { default: mermaid } = await import('mermaid');
      await nextTask();
      if (!valid()) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'neutral',
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        fontFamily: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
      });
      sandbox = document.createElement('div');
      sandbox.className = 'mermaid-sandbox';
      document.body.append(sandbox);
      const id = `notation-diagram-${++diagramId}`;
      const settled = fontsSettled();
      const { svg } = await mermaid.render(id, source, sandbox);
      if (settled && fontsSettled()) remember(key, svg, id);
      if (!valid()) return;
      target.replaceChildren(safeSVG(svg));
    } catch (error) {
      if (!valid()) return;
      target.classList.add('diagram-error');
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      const title = document.createElement('strong');
      title.textContent = 'Diagram error';
      const detail = document.createElement('pre');
      detail.textContent = error instanceof Error ? error.message : String(error);
      alert.append(title, detail);
      target.replaceChildren(alert);
    } finally {
      sandbox?.remove();
      if (valid()) target.setAttribute('aria-busy', 'false');
    }
  });
  renderQueue = task;
  return task;
}
