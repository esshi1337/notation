// Keep the LSP client out of the default editor's startup graph.
type IntelligenceModule = typeof import('./language-intelligence');
type Hooks = Parameters<IntelligenceModule['configureIntelligence']>[0];
let hooks: Hooks | undefined;
let pending: Promise<IntelligenceModule> | undefined;
export function configureLanguageIntelligence(value: Hooks) { hooks = value; }
export function loadLanguageIntelligence(): Promise<IntelligenceModule> {
  pending ??= import('./language-intelligence').catch(error => { pending = undefined; throw error; });
  return pending.then(module => {
    if (hooks) module.configureIntelligence(hooks);
    return module;
  });
}
