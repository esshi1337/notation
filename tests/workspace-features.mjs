import assert from 'node:assert/strict';
import {createServer} from 'vite';
const server=await createServer({cacheDir:'node_modules/.vite-workspace-features',optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},logLevel:'error'});
let count=0;function test(name,fn){fn();count++;console.log('✓ '+name);}
try{
  const {scanBlockReferences,referenceContent}=await server.ssrLoadModule('/src/block-references.ts');
  const {parseQuery,queryValue}=await server.ssrLoadModule('/src/database-query.ts');
  const {renderMarkdown}=await server.ssrLoadModule('/src/render-markdown.ts');
  const {extractFootnotes}=await server.ssrLoadModule('/src/footnotes.ts');
  const {codeCells}=await server.ssrLoadModule('/src/cells.ts');
  test('block references exclude syntax examples and preserve exact selected paragraph',()=>{
    const text='---\ntitle: ^fake\n---\n# Start\n\nTwo lines\nmake one paragraph. ^para\n\n```md\nLiteral ^code\n```\n\n`inline ^literal`\n\n$x^math$';
    assert.deepEqual(scanBlockReferences(text).map(x=>x.id),['para']);
    assert.equal(referenceContent(text,'^para').text,'Two lines\nmake one paragraph. ');
    assert.throws(()=>referenceContent('First ^same\n\nSecond ^same','^same'),/duplicated/);
    assert.throws(()=>referenceContent(text,'^absent'),/not found/);
  });
  test('standalone IDs attach preceding blocks including fenced code and preserve CRLF',()=>{
    const text='```js\r\nlet n=1;\r\n```\r\n\r\n^snippet\r\n';
    const block=scanBlockReferences(text)[0];assert.equal(block.from,0);assert.match(referenceContent(text,'^snippet').text,/let n=1;/);assert.ok(!referenceContent(text,'^snippet').text.includes('^snippet'));
  });
  test('heading embeds include descendants and stop at peer heading',()=>{
    const text='---\ntitle: Metadata\n---\n# First\nAlpha\n## Child\nBeta\n# Next\nGamma';
    assert.equal(referenceContent(text,'First').text,'# First\nAlpha\n## Child\nBeta\n');
    assert.equal(referenceContent(text,null).from,text.indexOf('# First'));
    assert.equal(referenceContent('---\nunclosed\n# Body',null).from,0);
  });
  test('query syntax preserves typed values and metadata sort without evaluating code',()=>{
    const parsed=parseQuery('view: table\ncolumns: [title, priority]\ntags: [work]\nwhere:\n  - key: priority\n    op: gte\n    value: 2\nsort:\n  by: priority\n  direction: desc\nlimit: 12');
    assert.equal(parsed.request.properties[0].value,2);assert.equal(parsed.request.sortProperty,'priority');assert.equal(parsed.request.descending,true);assert.equal(parsed.request.limit,12);
    assert.throws(()=>parseQuery('sql: DROP TABLE files'),/Unknown query/);assert.throws(()=>parseQuery('limit: 9999'),/1–200/);assert.throws(()=>parseQuery('where: [{key: x, op: eq}]'),/Missing value/);
    assert.equal(queryValue({title:'Title',name:'n',path:'n.md',tags:[],properties:{state:'<script>'}},'state'),'<script>');
  });
  test('embeds stay opt-in and do not consume ordinary links or fenced syntax',()=>{
    const result=renderMarkdown('![[Note#Heading|Excerpt]] [[Note]] `![[literal]]`\n\n```md\n![[code]]\n```');
    assert.equal(result.embeds.length,1);assert.equal(result.embeds[0].target,'Note#Heading|Excerpt');assert.equal(result.links.length,1);
    assert.match(renderMarkdown('![[image.png]]').html,/data-media-kind="image"/);
  });
  test('footnotes render repeated references, backlinks, math and exact task offsets',()=>{
    const text='Read[^note] and again[^note].\n\n[^note]: $x$ and words\n\n    - [ ] Footnote task\n\nOutside.';
    const result=renderMarkdown(text);assert.equal((result.html.match(/data-footnote-id=/g)||[]).length,1);assert.equal((result.html.match(/data-footnote-ref=/g)||[]).length,2);assert.match(result.html,/data-footnote-back/);assert.equal(result.maths.length,1);assert.equal(result.tasks.length,1);assert.equal(text.slice(result.tasks[0].from,result.tasks[0].to),'[ ]');
    assert.equal(extractFootnotes('```md\n[^no]: literal\n```\n\nReal[^ok]\n\n[^ok]: Yes').definitions.length,1);
  });
  test('code cells require explicit names and exclude nested/source examples',()=>{
    const text='```js\nreturn 0;\n```\n\n```javascript cell:data\nreturn {n:1};\n```\n\n> ```js cell:nested\n> return 2;\n> ```';
    const cells=codeCells(text);assert.deepEqual(cells.map(c=>c.id),['data']);assert.equal(text.slice(cells[0].codeFrom,cells[0].codeTo),cells[0].code);
    const result=renderMarkdown(text);assert.match(result.html,/data-cell-index/);assert.equal(result.cells[0].id,'data');assert.equal(result.cells[0].runnable,true);assert.equal(result.cells[1].runnable,false);
  });
  test('variables render as escaped text, keep code literal, and preserve source',()=>{
    const source='---\nstatus: "<b>active</b>"\n---\n\n{{status}} `{{status}}`';
    const result=renderMarkdown(source);assert.match(result.html, /class="document-variable"[^>]*>&lt;b&gt;active&lt;\/b&gt;/);assert.match(result.html, /<code>\{\{status\}\}<\/code>/);assert.equal(source.includes('{{status}}'),true);
  });
  test('advanced fences map to bundled renderers while ordinary code stays code',()=>{
    const result=renderMarkdown('```dot\ndigraph {a -> b}\n```\n\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n\n```d2\na -> b\n```\n\n```rust\nlet x=1;\n```');
    assert.deepEqual(result.advanced.map(d=>d.engine),['dot','plantuml','d2']);assert.match(result.html,/language-rust/);
  });
  console.log(count+' workspace feature scenarios passed');
}finally{await server.close();}
