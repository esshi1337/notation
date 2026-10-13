import { safeSVG } from './safe-svg';

export type DiagramTheme = 'dark' | 'light';

// Mermaid owns global configuration. Every consumer shares this queue so a
// theme change in one preview cannot change another in-flight diagram.
let renderQueue: Promise<void> = Promise.resolve();
let diagramId = 0;

export function renderMermaidInto(
  target: HTMLElement,
  source: string,
  theme: DiagramTheme,
  current: () => boolean = () => true,
): Promise<void> {
  const valid = () => current() && target.isConnected;
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
      if (!valid()) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'neutral',
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        fontFamily: 'Geist, Inter, ui-sans-serif, system-ui, sans-serif',
      });
      sandbox = document.createElement('div');
      sandbox.className = 'mermaid-sandbox';
      document.body.append(sandbox);
      const { svg } = await mermaid.render(`notation-diagram-${++diagramId}`, source, sandbox);
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
