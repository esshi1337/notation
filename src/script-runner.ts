import { invoke, isTauri } from '@tauri-apps/api/core';

export type ScriptDocument = { name: string; path: string | null; text: string; selection: string; from: number; to: number };
export type ScriptRequest = { id: string; scriptId?: string | null; code: string; cwd: string | null; document: ScriptDocument };
export type ScriptResult = { id: string; ok: boolean; logs: { level: string; message: string }[]; result: unknown; error?: string };

// Serialized into a dedicated worker: no editor/DOM access, and local APIs
// explicitly fail rather than pretending to modify the user's filesystem.
function browserWorker() {
  const worker = globalThis as unknown as {
    onmessage: (event: MessageEvent<ScriptRequest>) => void;
    postMessage: (value: ScriptResult) => void;
    fetch: unknown; XMLHttpRequest: unknown; WebSocket: unknown; importScripts: unknown;
  };
  worker.onmessage = (event) => {
    const request = event.data;
    const logs: ScriptResult['logs'] = [];
    const display = (value: unknown) => { try { return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); } catch { return String(value); } };
    const console = Object.fromEntries(['log', 'info', 'warn', 'error'].map((level) => [level, (...values: unknown[]) => logs.push({ level, message: values.map(display).join(' ') })]));
    const unavailable = () => { throw new Error('Local file and system APIs are unavailable in browser mode. Use the desktop app.'); };
    const api = Object.freeze({ context: Object.freeze({ document: request.document, cwd: request.cwd }), readText: unavailable, writeText: unavailable, listDir: unavailable, run: unavailable });
    worker.fetch = undefined; worker.XMLHttpRequest = undefined; worker.WebSocket = undefined; worker.importScripts = undefined;
    try {
      const result = new Function('api', 'console', '"use strict";\n' + request.code)(api, console) as unknown;
      if (result && typeof result === 'object' && 'then' in result) throw new Error('Scripts are synchronous. Promise results are unsupported.');
      worker.postMessage({ id: request.id, ok: true, logs, result: result === undefined ? null : result });
    } catch (error) {
      worker.postMessage({ id: request.id, ok: false, logs, result: null, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function runScript(request: ScriptRequest): { result: Promise<ScriptResult>; stop: () => Promise<void> } {
  if (isTauri()) return {
    result: invoke<ScriptResult>('run_script', { request }).catch((error: unknown) => ({ id: request.id, ok: false, logs: [], result: null, error: String(error) })),
    stop: async () => { await invoke<boolean>('stop_script', { id: request.id }); },
  };
  const url = URL.createObjectURL(new Blob(['(' + browserWorker.toString() + ')()'], { type: 'text/javascript' }));
  const worker = new Worker(url); URL.revokeObjectURL(url);
  let finish: (value: ScriptResult) => void;
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;
  const result = new Promise<ScriptResult>((resolve) => {
    finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate(); resolve(value); };
    worker.onmessage = (event: MessageEvent<ScriptResult>) => finish(event.data);
    worker.onerror = (event) => finish({ id: request.id, ok: false, logs: [], result: null, error: event.message || 'Script failed.' });
    timer = setTimeout(() => finish({ id: request.id, ok: false, logs: [], result: null, error: 'Script timed out after 15 seconds.' }), 15_000);
    worker.postMessage(request);
  });
  return { result, stop: async () => finish({ id: request.id, ok: false, logs: [], result: null, error: 'Script stopped.' }) };
}
