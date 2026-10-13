export type ConverterAsset = { name: string; svg: string };
export function prepareConverterHtml(html: string): { content: string; assets: ConverterAsset[] } {
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
