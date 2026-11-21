import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ cacheDir:'node_modules/.vite/citation-tests', optimizeDeps:{noDiscovery:true,include:[]}, server:{middlewareMode:true,hmr:false}, logLevel:'error' });
let passed=0;
function test(name,run){run();passed++;console.log('✓ '+name);}
try {
  const { citationAt, scanCitations, orderedCitationGroups }=await server.ssrLoadModule('/src/citations.ts');
  const { renderMarkdown }=await server.ssrLoadModule('/src/render-markdown.ts');
  const { insertionTemplates, insertionCommands }=await server.ssrLoadModule('/src/insertion-templates.ts');
  const { insertEditorTemplate }=await server.ssrLoadModule('/src/editor-commands.ts');
  const { EditorState }=await import('@codemirror/state');
  const { history, undo }=await import('@codemirror/commands');
  test('Pandoc bracket groups preserve exact source and identify combined locators and suppressed authors',()=>{
    assert.deepEqual(citationAt('[@doe2024]').keys,['doe2024']);
    assert.deepEqual(citationAt('[@one; @two, p. 2]').keys,['one','two']);
    assert.deepEqual(citationAt('[see -@doe:2024, pp. 3–4]').keys,['doe:2024']);
    assert.equal(citationAt('[user@example.com]'),null);assert.equal(citationAt('[[@key]]'),null);
    assert.equal(citationAt('\\[@key]',1),null);assert.equal(citationAt('[@broken\nkey]'),null);
  });
  test('citation scans exclude metadata, code, math, escaped groups, email and Markdown links',()=>{
    const text='---\ntitle: "[@metadata]"\n---\n`[@inline]`\n\n```md\n[@fenced]\n```\n\n$\\text{[@math]}$ \\[@escaped] [user@example.com] [label [@linked]](https://example.com) [@url](https://example.com) [[@wiki]] [@real; @other, p. 2]';
    assert.deepEqual(scanCitations(text).map(span=>span.raw),['[@real; @other, p. 2]']);
    assert.deepEqual(renderMarkdown(text).citations.map(span=>span.raw),['[@real; @other, p. 2]']);
  });
  test('actual marked groups retain exact CRLF callout, table and footnote source positions',()=>{
    const text='---\r\ntitle: Note\r\n---\r\n> [!NOTE] Quote\r\n> Cite [@same].\r\n\r\nOutside [@same] and [@later].\r\n\r\n| A | B |\r\n| --- | --- |\r\n| [@table] | text |\r\n\r\nReference[^note]\r\n\r\n[^note]: A citation [@footnote].\r\n';
    const result=renderMarkdown(text);
    assert.deepEqual(result.citations.map(span=>span.raw),['[@same]','[@same]','[@later]','[@table]','[@footnote]']);
    for(const span of result.citations)assert.equal(text.slice(span.from,span.to),span.raw);
    assert.equal(result.documentSource,text);
    assert.deepEqual(orderedCitationGroups(text,result.citations.map(span=>span.raw)),['[@same]','[@later]','[@table]','[@footnote]']);
  });
  test('all slash templates have a palette command and insert as one isolated undo event',()=>{
    assert.equal(insertionTemplates.length,insertionCommands.length);
    for(const template of insertionTemplates){
      assert.ok(insertionCommands.some(command=>command.id==='insert.'+template.key));
      const original='Before X After';let state=EditorState.create({doc:original,selection:{anchor:7,head:8},extensions:history()});
      const view={get state(){return state},dispatch(spec){state=spec.state??state.update(spec).state},focus(){}};
      assert.equal(insertEditorTemplate(view,template.key),true);assert.equal(state.doc.toString(),'Before '+template.text+' After');
      assert.equal(undo(view),true);assert.equal(state.doc.toString(),original);
    }
  });
  {
    // The engine reads only frontmatter, so body edits must reuse the result.
    const calls = [];
    globalThis.isTauri = true;
    globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push({ command, ...args }); return { citations: args.citations.map(raw => ({ raw, html: '<span>' + raw + '</span>' })), bibliographyHtml: '' }; } } };
    const { formatCitations, citationMetadataSource } = await server.ssrLoadModule('/src/render-citations.ts');
    const front = '---\nbibliography: refs.bib\nlang: en\n---\n';
    const body = 'First claim [@doe2020]. Second claim [@roe2021; @doe2020].\n';
    assert.equal(citationMetadataSource(front + body), front);
    assert.equal(citationMetadataSource('\uFEFF' + front + body), '\uFEFF' + front);
    assert.equal(citationMetadataSource(front.replace('---\n', '---\r\n') + body), front.replace('---\n', '---\r\n'));
    assert.equal(citationMetadataSource(body), body, 'no frontmatter: the source is sent unchanged');
    assert.equal(citationMetadataSource('---\nbibliography: refs.bib\n' + body), '---\nbibliography: refs.bib\n' + body, 'unclosed frontmatter: the source is sent unchanged');
    const groups = ['[@doe2020]', '[@roe2021; @doe2020]'];
    const first = await formatCitations(front + body, '/notes/a.md', groups);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].content, front, 'only the frontmatter block is sent');
    assert.deepEqual(calls[0].citations, groups);
    // Typing in the body: same frontmatter, same groups in the same order.
    const second = await formatCitations(front + 'A new opening sentence. ' + body + 'And a closing one.\n', '/notes/a.md', groups);
    assert.equal(calls.length, 1, 'a body edit reuses the formatted citations');
    assert.deepEqual(second, first);
    // Each of these changes what the engine would produce.
    await formatCitations(front.replace('lang: en', 'lang: de') + body, '/notes/a.md', groups);
    assert.equal(calls.length, 2, 'frontmatter change');
    await formatCitations(front + 'Second claim [@roe2021; @doe2020]. First claim [@doe2020].\n', '/notes/a.md', groups);
    assert.equal(calls.length, 3, 'citation order change');
    await formatCitations(front + body + 'Third [@new2022].\n', '/notes/a.md', [...groups, '[@new2022]']);
    assert.equal(calls.length, 4, 'new citation group');
    await formatCitations(front + body, '/notes/b.md', groups);
    assert.equal(calls.length, 5, 'another note');
    passed++; console.log('✓ citation formatting is keyed on frontmatter and citation groups, not the note body');
  }
  console.log(passed+' citation and insertion scenarios passed.');
} finally {await server.close();}
