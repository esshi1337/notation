export type ConverterAsset = { name: string; svg: string };
/** Class of the placeholder the native converter rewrites (src-tauri/src/math_export.rs). */
export const TYPST_MATH_MARKER = 'notation-typst-math';
// The image the Office fallback rasterizes: black ink, no page styling, and
// four times the point size so the bitmap stays sharp in print.
function standaloneEquation(svg: SVGElement, width: number, height: number): string {
  const copy = svg.cloneNode(true) as SVGElement;
  for (const name of ['class', 'style', 'role', 'aria-label', 'focusable']) copy.removeAttribute(name);
  copy.setAttribute('width', String(+(width * 4).toFixed(2))); copy.setAttribute('height', String(+(height * 4).toFixed(2)));
  for (const element of copy.querySelectorAll('*')) for (const name of ['fill', 'stroke']) if (element.getAttribute(name) === 'currentColor') element.setAttribute(name, '#000000');
  const text = new XMLSerializer().serializeToString(copy);
  // The file needs its namespace declared; serializers differ on whether an inherited one is written.
  return /^<svg[^>]*\sxmlns=/u.test(text) ? text : text.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}
/**
 * Turn exported HTML into the converter's input. KaTeX equations become TeX
 * for Pandoc. Typst equations become empty marker spans that carry their
 * source: the PDF engine typesets it natively, and Office export converts it
 * to a native equation, using `images` (the rendered SVG) only when it cannot.
 */
export function prepareConverterHtml(html: string, options: { images?: boolean } = {}): { content: string; assets: ConverterAsset[] } {
  const output = document.createElement('template'); output.innerHTML = html;
  const body = output.content.querySelector('main.markdown-body');
  if (!body) throw new Error('The rendered export has no document body.');
  const inert = output.content.ownerDocument;
  for (const math of body.querySelectorAll<HTMLElement>('.katex')) {
    const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
    if (!annotation) throw new Error('An equation has no source annotation. Repair it before converting this note.');
    const wrapper = math.closest('.rendered-math') ?? math.closest('.katex-display') ?? math;
    const display = !!wrapper.querySelector('.katex-display') || wrapper.classList.contains('katex-display');
    const replacement = inert.createElement(display ? 'div' : 'span'); replacement.className = 'math ' + (display ? 'display' : 'inline');
    replacement.textContent = display ? '\\[' + annotation.textContent + '\\]' : '\\(' + annotation.textContent + '\\)'; wrapper.replaceWith(replacement);
  }
  for (const math of body.querySelectorAll<HTMLElement>('.typst-math')) {
    const svg = math.querySelector<SVGElement>('svg.typst-math-svg'), source = svg?.getAttribute('aria-label')?.trim();
    const box = (svg?.getAttribute('viewBox') ?? '').split(/\s+/u).map(Number);
    if (!svg || !source || box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) throw new Error('A Typst equation has no source. Repair it before converting this note.');
    const display = math.classList.contains('typst-display'), wrapper = math.closest('.rendered-math') ?? math;
    const marker = inert.createElement('span'); marker.className = TYPST_MATH_MARKER;
    marker.setAttribute('data-typst', source); marker.setAttribute('data-display', display ? '1' : '0');
    marker.setAttribute('data-width', String(box[2])); marker.setAttribute('data-height', String(box[3]));
    if (options.images) marker.setAttribute('data-svg', standaloneEquation(svg, box[2], box[3]));
    // A block equation stays a paragraph of its own.
    if (wrapper.localName === 'div') { const paragraph = inert.createElement('p'); paragraph.append(marker); wrapper.replaceWith(paragraph); }
    else wrapper.replaceWith(marker);
  }
  for (const icon of body.querySelectorAll('.callout-icon svg')) icon.remove();
  const assets: ConverterAsset[] = [];
  for (const svg of [...body.querySelectorAll('svg')].filter((svg) => !svg.parentElement?.closest('svg'))) {
    const name = 'note-figure-' + (assets.length + 1) + '.svg'; assets.push({ name, svg: svg.outerHTML });
    const image = inert.createElement('img'); image.setAttribute('src', name); image.setAttribute('alt', 'Diagram ' + assets.length); svg.replaceWith(image);
  }
  for (const input of body.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) input.replaceWith(inert.createTextNode(input.checked ? '☑ ' : '☐ '));
  for (const style of body.querySelectorAll('style')) style.remove();
  for (const element of body.querySelectorAll('[style]')) element.removeAttribute('style');
  return { content: body.innerHTML, assets };
}
