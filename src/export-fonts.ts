import katexCSS from 'katex/dist/katex.min.css?raw';
import sans400 from '@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2?inline';
import sans500 from '@fontsource/source-sans-3/files/source-sans-3-latin-500-normal.woff2?inline';
import sans600 from '@fontsource/source-sans-3/files/source-sans-3-latin-600-normal.woff2?inline';
import mono400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?inline';
// Include offline font data in the static module graph so export does not
// require additional module loading or font requests.
const maths = import.meta.glob<string>('/node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?inline', import: 'default' });
const bodyFonts = [
  { family: 'Source Sans 3', weight: 400, url: sans400 },
  { family: 'Source Sans 3', weight: 500, url: sans500 },
  { family: 'Source Sans 3', weight: 600, url: sans600 },
  { family: 'IBM Plex Mono', weight: 400, url: mono400 },
];
let bodyStyles: string | undefined, mathStyles: string | undefined;
function dataFont(url: string) { if (!url.startsWith('data:font/woff2;base64,') && !url.startsWith('data:application/font-woff2;base64,')) throw new Error('A bundled font could not be inlined. Rebuild the app before exporting a self-contained webpage.'); return url; }
export function exportFontStyles(withMath: boolean): string {
  bodyStyles ??= bodyFonts.map(font => '@font-face{font-family:"' + font.family + '";font-weight:' + font.weight + ';font-style:normal;font-display:swap;src:url("' + dataFont(font.url) + '") format("woff2")}').join('');
  if (!withMath) return bodyStyles;
  mathStyles ??= [...katexCSS.matchAll(/@font-face\{[^}]*\}/gu)].map(match => {
    const file = /url\(fonts\/([^)]*\.woff2)\)/u.exec(match[0])?.[1];
    const url = file && maths['/node_modules/katex/dist/fonts/' + file];
    if (!url) throw new Error('A bundled KaTeX font is unavailable: ' + (file || 'unknown'));
    return match[0].replace(/src:[^}]+/u, 'src:url("' + dataFont(url) + '") format("woff2")');
  }).join('') + katexCSS.replace(/@font-face\{[^}]*\}/gu, '');
  return bodyStyles + mathStyles;
}
