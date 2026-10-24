import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { Text } from '@codemirror/state';
const server = await createServer({cacheDir:'node_modules/.vite-code-tests',optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},logLevel:'error'});
try {
  const {detectLanguage,documentFileName}=await server.ssrLoadModule('/src/code-languages.ts');
  for(const [name,language] of [['index.ts','typescript'],['App.svelte','svelte'],['main.rs','rust'],['module.mjs','javascript'],['notes.md','markdown'],['LICENSE','plaintext']])assert.equal(detectLanguage(name),language);
  assert.equal(detectLanguage('notes.md','rust'),'rust'); assert.equal(detectLanguage('notes.md','bogus'),'markdown');
  for(const name of ['main.rs','App.svelte','.gitignore','Dockerfile','entry'])assert.equal(documentFileName(name,false),name);
  assert.equal(documentFileName('Note'),'Note.md');
  const {validatedEdits,localPath,fileUri,safeCompletions,initializeMessage}=await server.ssrLoadModule('/src/language-intelligence.ts');
  const doc=Text.of(['hello 👋','world']);
  assert.deepEqual(validatedEdits(doc,[{range:{start:{line:0,character:6},end:{line:0,character:8}},newText:'x'}]),[{from:6,to:8,insert:'x'}]);
  assert.throws(()=>validatedEdits(doc,[{range:{start:{line:0,character:20},end:{line:0,character:21}},newText:''}]),/column/);
  assert.throws(()=>validatedEdits(doc,[{range:{start:{line:0,character:0},end:{line:0,character:2}},newText:''},{range:{start:{line:0,character:1},end:{line:0,character:3}},newText:''}]),/Overlapping/);
  assert.throws(()=>validatedEdits(doc,[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'🦀'.repeat(1100000)}]),/byte limit/);
  assert.equal(localPath(fileUri('/tmp/a # café.ts')),'/tmp/a # café.ts');
  for(const uri of ['https://example.com/a','file://host/etc/passwd','file:///tmp/a?x','file:///tmp/a%00'])assert.throws(()=>localPath(uri));
  const handshake=JSON.parse(initializeMessage(JSON.stringify({method:'initialize',params:{capabilities:{textDocument:{diagnostic:{},publishDiagnostics:{versionSupport:true}}}}})));
  assert.equal(handshake.params.capabilities.textDocument.diagnostic,undefined); assert.equal(handshake.params.capabilities.textDocument.publishDiagnostics.versionSupport,true);
  const completionDoc=Text.of(['person.na', 'second line']);
  const range={start:{line:0,character:7},end:{line:0,character:9}};
  const valid={label:'name',textEdit:{range,newText:'name'}};
  const unsafe=[{label:'wrong line',textEdit:{range:{start:{line:1,character:0},end:{line:1,character:10}},newText:'bad'}},{label:'outside cursor',textEdit:{range:{start:{line:0,character:0},end:{line:0,character:2}},newText:'bad'}},{...valid,additionalTextEdits:[{range,newText:'overlap'}]},{...valid,insertText:'x',textEdit:{range,newText:'x'.repeat(70000)}}];
  assert.deepEqual(safeCompletions([valid,...unsafe],completionDoc,{line:0,character:9}).items,[valid]);
  console.log('Code language, filenames, UTF-16 edit ranges, overlap, UTF-8 limits, and local URI checks passed');
}finally{await server.close();}
