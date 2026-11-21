// What the Typst compiler is allowed to reach while it renders an equation:
// no files, no packages, and no JavaScript evaluated from source text. Kept
// apart from the worker so the Node suite can run the compiler the same way.

/** No file exists: `read`, `image`, `include` and `import "file"` all fail. */
export const noFiles = {
  getMTime: (_path: string): Date | undefined => undefined,
  isFile: (_path: string): boolean | undefined => undefined,
  getRealPath: (path: string): string | undefined => path,
  readAll: (_path: string): Uint8Array | undefined => undefined,
};
/** No package exists: `import "@preview/…"` fails without a lookup. */
export const noPackages = { resolve: (): string | undefined => undefined };

// The app's Content-Security-Policy forbids `new Function`, and the compiler
// calls it while it is constructed: its placeholder file-system and package
// callbacks are compiled from five fixed source strings before the real ones
// above replace them. Those strings are answered with ordinary functions;
// anything else is refused exactly as the policy would refuse it.
const placeholders: Record<string, (...values: unknown[]) => unknown> = { 'return 0': () => 0, 'return true': () => true, 'return path': (path) => path };
function compileSource(parameters: unknown[]): (...values: unknown[]) => unknown {
  const body = String(parameters[parameters.length - 1] ?? '');
  if (Object.hasOwn(placeholders, body)) return placeholders[body];
  const failure = /^throw new Error\('([^'\\]*)'\)$/u.exec(body);
  if (failure) return () => { throw new Error(failure[1]); };
  throw new EvalError('Typst math does not evaluate JavaScript source.');
}
/** Replace `Function` in this global scope (a dedicated worker) with the refusing constructor. */
export function refuseSourceEvaluation(scope: object): void {
  (scope as { Function: unknown }).Function = new Proxy(Function, {
    construct: (_target, parameters) => compileSource(parameters),
    apply: (_target, _self, parameters) => compileSource(parameters),
  });
}
