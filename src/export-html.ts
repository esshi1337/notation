import { featureParser, markdownSource } from './markdown-features';
import { renderMarkdown } from './render-markdown';
import { loadLocalMedia } from './media';
import { safeSVG } from './safe-svg';
import type { MediaKind } from './media-path';
import { renderContent, clearRenderedContent } from './render-content';
import type { EmbedDocument } from './render-content';
import { documentExportStyles } from './export-styles';
import { exportFontStyles } from './export-fonts';

export type HtmlExportFormat = 'html' | 'self-contained';
export type HtmlExportSource = { name: string; text: string; documentId: number; path?: string | null; sourcePath?: string; standalone?: boolean };
export type HtmlExportResult = { html: string; warnings: string[]; images: number };
type Resource = { id: string; src: string; sourcePath?: string; kind: MediaKind; label: string };
export function exportFilename(name: string) { return (name.replace(/\.[^.]+$/u, '').replace(/[\\/:*?"<>|]/gu, '-').trim() || 'document') + '.html'; }
function escape(text: string) { return text.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function htmlExportShell(title: string, body: string, styles: string, selfContained: boolean) {
  const policy = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src " + (selfContained ? 'data:' : 'data: https: http: file: blob:') + "; base-uri 'none'; form-action 'none'";
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="' + escape(policy) + '"><title>' + escape(title) + '</title><style>' + styles + '</style></head><body><main class="markdown-body">' + body + '</main></body></html>\n';
}
export function externalStyleResource(css: string): boolean {
  return [...css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/giu)].some((match) => { const value = (match[2] ?? match[3] ?? '').trim(); return !value.startsWith('#') && !value.startsWith('data:'); });
}
function validImageURL(src: string) {
  if (/^data:/iu.test(src)) return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/iu.test(src);
  try { return ['http:', 'https:', 'file:', 'blob:', 'tauri:', 'asset:'].includes(new URL(src, document.baseURI).protocol); } catch { return false; }
}
function safeDataImage(src: string) {
  if (!/^data:image\/svg\+xml[;,]/iu.test(src)) return src;
  const comma = src.indexOf(','), encoded = src.slice(comma + 1);
  const svg = /;base64/iu.test(src.slice(0, comma)) ? new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))) : decodeURIComponent(encoded);
  const input = document.createElement('template'); input.innerHTML = svg;
  for (const element of input.content.querySelectorAll('*')) {
    const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');
    if (href && element.localName !== 'a' && !href.startsWith('#') && !href.startsWith('data:')) throw new Error('An SVG image contains a linked resource. Embed all of its resources or convert it to PNG before exporting.');
    if (externalStyleResource(element.getAttribute('style') || '') || element.localName === 'style' && externalStyleResource(element.textContent || '')) throw new Error('An SVG image contains external styles. Use a self-contained SVG or PNG.');
  }
  const output = document.createElement('template'); output.content.append(safeSVG(svg));
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(output.innerHTML);
}
async function bundledResource(resource: Resource, images: HTMLImageElement[]) {
  if (/^data:/iu.test(resource.src)) return resource.kind === 'image' ? safeDataImage(resource.src) : resource.src;
  if (!/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(resource.src)) {
    try { const loaded = await loadLocalMedia(resource.src, resource.sourcePath); return resource.kind === 'image' ? safeDataImage(loaded.dataUrl) : loaded.dataUrl; }
    catch (cause) { if (resource.kind !== 'image') throw new Error('Cannot bundle attachment "' + resource.src + '": ' + String(cause)); }
  }
  if (resource.kind !== 'image') throw new Error('Cannot bundle remote attachment "' + resource.src + '". Use a local workspace file or normal HTML with a static link. No remote attachment was fetched.');
  const image = images.find((candidate) => (candidate.dataset.originalSrc === resource.src || candidate.getAttribute('src') === resource.src) && candidate.complete && candidate.naturalWidth > 0);
  if (!image) throw new Error('Cannot bundle image "' + resource.src + '"' + (resource.sourcePath ? ' from ' + resource.sourcePath : '') + '. Use a local workspace image or embedded data URL, then export again. No external image was fetched.');
  if (image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error('Image is too large to bundle safely: ' + resource.src + '. Resize it to at most 16 megapixels.');
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  try { const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas is unavailable.'); context.drawImage(image, 0, 0); return canvas.toDataURL('image/png'); }
  catch { throw new Error('Cannot bundle image "' + resource.src + '" because its loaded pixels are unavailable to the app. Use a local workspace image or normal HTML with linked images.'); }
}
export async function buildHtmlExport(source: HtmlExportSource, options: { format: HtmlExportFormat; theme: 'dark' | 'light'; loadEmbed?: (target: string, sourcePath?: string) => Promise<EmbedDocument>; signal?: AbortSignal; progress?: (stage:string) => void }): Promise<HtmlExportResult> {
  const current = () => !options.signal?.aborted;
  const resources: Resource[] = [], warnings: string[] = [], failures: string[] = [];
  const images = [...document.querySelectorAll<HTMLImageElement>('img')];
  const prepareHtml = (html: string, sourcePath?: string) => {
    const template = document.createElement('template'); template.innerHTML = html;
    const reject = (message: string): never => { failures.push(message); throw new Error(message); };
    if (template.content.querySelector('video,audio,source,track,iframe,object,embed,link')) reject('HTML export supports static notes and images. Remove embedded media or external stylesheets before exporting.');
    for (const image of template.content.querySelectorAll<HTMLImageElement>('img')) {
      if (image.hasAttribute('srcset')) reject('Responsive image srcset is unsupported by HTML export. Use one src image instead.');
      const src = image.getAttribute('src')?.trim(); image.removeAttribute('src'); image.removeAttribute('srcset');
      if (!src) continue;
      const kind = (image.dataset.mediaKind || 'image') as MediaKind;
      if (kind === 'image' && !validImageURL(src)) reject('Unsupported image URL in HTML export: ' + src);
      if (kind !== 'image' && !/^data:(?:audio|video)\/|^data:application\/pdf/iu.test(src) && !validImageURL(src)) reject('Unsupported attachment URL in HTML export: ' + src);
      const id = String(resources.length), label = image.alt || src; resources.push({ id, src, sourcePath, kind, label }); image.dataset.exportImage = id;
    }
    // Source HTML styles can trigger resource loads. Only the trusted generated
    // KaTeX/Mermaid styles and our export stylesheet are carried into the file.
    for (const element of template.content.querySelectorAll<HTMLElement>('[style]')) { if (/url\s*\(/iu.test(element.getAttribute('style') || '')) reject('CSS background resources are unsupported by HTML export. Use a Markdown image instead.'); element.removeAttribute('style'); if (!warnings.includes('Custom source HTML styles were omitted; the exported note uses its own embedded stylesheet.')) warnings.push('Custom source HTML styles were omitted; the exported note uses its own embedded stylesheet.'); }
    for (const style of template.content.querySelectorAll('style')) { if (/url\s*\(|@import/iu.test(style.textContent || '')) reject('External or background CSS resources are unsupported by HTML export. Use Markdown images instead.'); style.remove(); }
    return template.innerHTML;
  };
  const result = source.standalone ? { html: '<div class="diagram" data-diagram="0"></div>', tasks: [], maths: [], diagrams: [source.text], callouts: [], links: [], frontmatter: null } : renderMarkdown(source.text);
  const checkDiagrams = (content: string) => {
    featureParser.parse(markdownSource(content)).iterate({ enter(node) {
      if (node.name !== 'FencedCode') return;
      const info = node.node.getChild('CodeInfo'), body = node.node.getChild('CodeText');
      if (info && /^(?:mermaid|graphviz|dot|d2|plantuml)$/iu.test(content.slice(info.from, info.to).trim()) && body && /https?:\/\/|file:\/\/|\b(?:img|image|icon|shapefile)\s*[:=]\s*["']?\/\//iu.test(content.slice(body.from, body.to))) throw new Error('A diagram contains an external URL that HTML export cannot bundle safely. Remove its external image/style references before exporting. No external resource was fetched.');
      return false;
    } });
  };
  checkDiagrams(source.standalone ? '```mermaid\n' + source.text + '\n```' : source.text);
  const loadEmbed = options.loadEmbed ? async (target: string, path?: string) => { const loaded = await options.loadEmbed!(target, path); try { checkDiagrams(loaded.content); } catch (cause) { failures.push(String(cause)); throw cause; } return loaded; } : undefined;
  const host = document.createElement('div'); host.className = 'markdown-body'; host.setAttribute('aria-hidden', 'true'); host.inert = true;
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: '800px', visibility: 'hidden', fontSize: '14px' });
  document.body.append(host);
  try {
    options.progress?.('Rendering note…');
    await renderContent(host, result, { theme: options.theme, folds: new Map(), current, toggle: () => false, edit: () => {}, loadEmbed, sourcePath: source.sourcePath ?? source.path ?? undefined, embedTrail: source.sourcePath || source.path ? [(source.sourcePath ?? source.path) + '#'] : [], prepareHtml });
    if (!current()) throw new DOMException('Export canceled', 'AbortError');
    if (failures.length) throw new Error(failures[0]);
    // Template content is inert. Restoring src there cannot initiate requests.
    const output = document.createElement('template'); output.innerHTML = host.innerHTML;
    options.progress?.('Bundling media…');
    for (const resource of resources) {
      const image = output.content.querySelector<HTMLImageElement>('[data-export-image="' + resource.id + '"]');
      if (!image) continue;
      const url = options.format === 'self-contained' ? await bundledResource(resource, images) : resource.src;
      if (resource.kind === 'image') image.setAttribute('src', url);
      else { const link = output.content.ownerDocument.createElement('a'); link.textContent = resource.label; link.href = url; if (options.format === 'self-contained') link.setAttribute('download', resource.label.split(/[\\/]/u).pop() || 'attachment'); image.replaceWith(link); }
    }
    for (const element of output.content.querySelectorAll<HTMLElement>('[data-callout-body]')) element.hidden = false;
    for (const input of output.content.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) { input.disabled = true; if (input.checked) input.setAttribute('checked', ''); else input.removeAttribute('checked'); }
    for (const control of output.content.querySelectorAll('.cell-actions,[data-callout-edit],[data-callout-toggle] .callout-chevron,[data-edit-properties],.frontmatter-source,.embed-actions button[aria-label^="Refresh"],.query-actions button')) control.remove();
    for (const button of output.content.querySelectorAll('button')) { const span = document.createElement('span'); span.className = button.className; span.append(...button.childNodes); button.replaceWith(span); }
    for (const link of output.content.querySelectorAll<HTMLAnchorElement>('a')) {
      if (link.classList.contains('wiki-link')) { const span = document.createElement('span'); span.className = link.className; span.textContent = link.textContent; link.replaceWith(span); }
      else { link.setAttribute('rel', 'noopener noreferrer'); link.removeAttribute('target'); }
    }
    for (const element of output.content.querySelectorAll('*')) for (const attribute of [...element.attributes]) if (attribute.name.startsWith('data-') || attribute.name.startsWith('on') || ['tabindex','contenteditable','aria-expanded','aria-busy','aria-controls'].includes(attribute.name)) element.removeAttribute(attribute.name);
    for (const element of output.content.querySelectorAll<HTMLElement>('[style],style')) {
      const css = element.tagName.toLowerCase() === 'style' ? element.textContent || '' : element.getAttribute('style') || '';
      if (externalStyleResource(css)) throw new Error('A rendered SVG or equation contains an external style resource. Remove it before exporting.');
    }
    for (const image of output.content.querySelectorAll('svg image')) { const href = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? ''; if (href && !href.startsWith('data:') && !href.startsWith('#')) throw new Error('A rendered diagram contains a linked image. Embed the image data before exporting.'); }
    const alerts = output.content.querySelectorAll('[role=alert]').length;
    if (alerts) warnings.push('The exported note includes ' + alerts + ' rendering error' + (alerts === 1 ? '' : 's') + '. Repair the displayed errors for a complete export.');
    if (resources.length && options.format === 'html') warnings.push('Images remain linked as authored. Keep relative image files beside the exported HTML.');
    options.progress?.('Preparing document styles…');
    const styles = documentExportStyles(options.theme) + exportFontStyles(!!output.content.querySelector('.katex'));
    if (!current()) throw new DOMException('Export canceled', 'AbortError');
    const html = htmlExportShell(source.name, output.innerHTML, styles, options.format === 'self-contained');
    if (new TextEncoder().encode(html).length > 32 * 1024 * 1024) throw new Error('This HTML export exceeds 32 MiB. Export fewer images or a smaller note.');
    return { html, warnings, images: resources.length };
  } finally { clearRenderedContent(host); host.remove(); }
}
