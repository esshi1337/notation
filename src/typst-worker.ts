/// <reference lib="webworker" />
// Compiles one math expression at a time with the bundled Typst WebAssembly
// compiler and renderer. Everything is loaded from the app's own assets, and
// the compiler is given no files, no packages and no network (typst-sandbox),
// so Typst code inside an equation stays inside the equation. The host
// terminates this worker if a compilation runs away.
import { createTypstCompiler } from '@myriaddreamin/typst.ts/compiler';
import { createTypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import { withAccessModel, withPackageRegistry } from '@myriaddreamin/typst.ts/options.init';
import * as compilerModule from '@myriaddreamin/typst-ts-web-compiler';
import * as rendererModule from '@myriaddreamin/typst-ts-renderer';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';
import mathFont from './assets/typst/NewCMMath-Book.otf?url';
import { TYPST_METRICS_LABEL, typstDiagnostic, typstMathDocument } from './math-syntax';
import { noFiles, noPackages, refuseSourceEvaluation } from './typst-sandbox';

export type TypstRequest = { id: number; content: string; display: boolean };
export type TypstResponse =
  | { id: number; svg: string; width: number; height: number; descent: number }
  | { id: number; error: string; crashed?: true }
  | { ready: true; ms: number };

// Math renders offline. The engine library can fetch fonts and packages from
// the network when asked to; nothing here asks, and this makes it impossible.
const localFetch = self.fetch.bind(self);
self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, self.location.href);
  if (url.origin !== self.location.origin) return Promise.reject(new TypeError('Typst math does not use the network (blocked ' + url.host + ').'));
  return localFetch(input, init);
};
refuseSourceEvaluation(self);

type Compiler = ReturnType<typeof createTypstCompiler>;
type Renderer = ReturnType<typeof createTypstRenderer>;
let engines: Promise<{ compiler: Compiler; renderer: Renderer }> | undefined;
let compiled = 0;

async function bytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('A bundled Typst asset is missing (' + response.status + ').');
  return new Uint8Array(await response.arrayBuffer());
}
// The library's font loader (also built with `new Function`, and able to add
// CDN fonts) and its default file and package sources are replaced on purpose.
type BeforeBuild = NonNullable<NonNullable<Parameters<Compiler['init']>[0]>['beforeBuild']>[number];
function bundledFont(font: Uint8Array): BeforeBuild {
  const load = async (_: unknown, context: { builder: { add_raw_font(data: Uint8Array): Promise<void> } }) => { await context.builder.add_raw_font(font); };
  // Marks this as the font source, with the remote default assets disabled.
  return Object.assign(load, { _kind: 'fontLoader', _preloadRemoteFontOptions: { assets: false } }) as unknown as BeforeBuild;
}
function start() {
  return engines ??= (async () => {
    const started = performance.now();
    const compiler = createTypstCompiler(), renderer = createTypstRenderer();
    const font = await bytes(mathFont);
    await Promise.all([
      compiler.init({ getWrapper: () => Promise.resolve(compilerModule), getModule: () => compilerWasm, beforeBuild: [bundledFont(font), withAccessModel(noFiles), withPackageRegistry(noPackages)] }),
      renderer.init({ getWrapper: () => Promise.resolve(rendererModule), getModule: () => rendererWasm, beforeBuild: [] }),
    ]);
    (self as DedicatedWorkerGlobalScope).postMessage({ ready: true, ms: performance.now() - started } satisfies TypstResponse);
    return { compiler, renderer };
  })();
}

async function render(request: TypstRequest): Promise<TypstResponse> {
  const { compiler, renderer } = await start();
  compiler.addSource('/main.typ', typstMathDocument(request.content, request.display));
  const result = await compiler.runWithWorld({ mainFilePath: '/main.typ' }, async (world) => {
    const artifact = await world.vector({ diagnostics: 'full' });
    if (!artifact.result) return { error: typstDiagnostic(artifact.diagnostics) };
    const metrics = await world.query({ selector: '<' + TYPST_METRICS_LABEL + '>', field: 'value' }) as unknown;
    return { vector: artifact.result, metrics };
  });
  // comemo keeps every compilation; age out what recent equations do not share.
  if (++compiled % 64 === 0) await compiler.evictCache(8);
  if ('error' in result) return { id: request.id, error: result.error! };
  const [width, height, descent] = (Array.isArray(result.metrics) && Array.isArray(result.metrics[0]) ? result.metrics[0] : []) as number[];
  if (![width, height, descent].every(Number.isFinite) || width <= 0 || height <= 0) return { id: request.id, error: 'the equation produced no output' };
  const svg = await renderer.renderSvg({ format: 'vector', artifactContent: result.vector, data_selection: { body: true, defs: true, css: false, js: false } });
  return { id: request.id, svg, width, height, descent };
}

let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<TypstRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    let response: TypstResponse;
    try { response = await render(request); }
    // A thrown error (as opposed to diagnostics) may be a WebAssembly trap,
    // which leaves the engine unusable; the host replaces this worker.
    catch (error) { response = { id: request.id, error: error instanceof Error ? error.message : String(error), crashed: true }; }
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  });
};
