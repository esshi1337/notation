import katexCSS from 'katex/dist/katex.min.css?raw';
import geist400 from '@fontsource/geist/files/geist-latin-400-normal.woff2?inline';
import geist500 from '@fontsource/geist/files/geist-latin-500-normal.woff2?inline';
import geist600 from '@fontsource/geist/files/geist-latin-600-normal.woff2?inline';
import mono400 from '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2?inline';
// Include offline font data in the static module graph so export does not
// require additional module loading or font requests.
const maths = import.meta.glob<string>('/node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?inline', import: 'default' });
const bodyFonts = [
  { family: 'Geist', weight: 400, url: geist400 },
  { family: 'Geist', weight: 500, url: geist500 },
  { family: 'Geist', weight: 600, url: geist600 },
  { family: 'Geist Mono', weight: 400, url: mono400 },
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
