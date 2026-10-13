import assert from 'node:assert/strict';
import { parseCanvas, mutateCanvas, removeCanvasNode, canvasAnchor, newCanvas } from '../src/canvas.ts';
import { resolveVariable, substituteVariables, insertTemplate, readTemplateLibrary, validateTemplateLibrary } from '../src/templates.ts';
let passed = 0;
function test(name, run) { run(); passed++; console.log('✓ ' + name); }
const original = JSON.stringify({ metadata: { app: 'other', unknown: [1,2] }, nodes: [{ id:'a',type:'text',x:10,y:20,width:240,height:160,text:'# Text',extension:{future:true} },{id:'b',type:'file',x:400,y:20,width:200,height:100,file:'notes/example.md',subpath:'#Heading'}], edges:[{id:'edge',fromNode:'a',toNode:'b',label:'related',future:'retained'}] }, null, 2).replaceAll('\n','\r\n') + '\r\n';
test('JSON Canvas 1.0 mutations preserve unknown fields, node metadata, edge data and CRLF', () => {
  const next = mutateCanvas(original, (canvas) => { canvas.nodes[0].x += 30; canvas.nodes[0].text = 'Changed'; });
  const value = parseCanvas(next);
  assert.deepEqual(value.metadata, {app:'other',unknown:[1,2]}); assert.deepEqual(value.nodes[0].extension,{future:true});
  assert.equal(value.edges[0].future,'retained'); assert.equal(value.nodes[0].x,40); assert.equal(value.nodes[0].text,'Changed');
  assert.equal(next.replaceAll('\r\n','').includes('\n'),false); assert.equal(parseCanvas(original).nodes[0].x,10);
});
test('card deletion removes only connected edges and standard anchors follow node geometry', () => {
  const next = mutateCanvas(original, (canvas) => removeCanvasNode(canvas,'a'));
  assert.deepEqual(parseCanvas(next).nodes.map((node) => node.id),['b']); assert.equal(parseCanvas(next).edges.length,0);
  const node = parseCanvas(original).nodes[0];
  assert.deepEqual(canvasAnchor(node,'right'),{x:250,y:100}); assert.deepEqual(canvasAnchor(node,'top'),{x:130,y:20});
  assert.deepEqual(parseCanvas(newCanvas()),{nodes:[],edges:[]});
});
test('invalid, dangling, duplicate and oversized Canvas data rejects without repairing away content', () => {
  for (const mutate of [value=>value.nodes.push({...value.nodes[0]}),value=>value.nodes[0].x=Infinity,value=>value.edges[0].toNode='missing',value=>value.nodes[0].width=0,value=>value.nodes[0].type='unknown']) {
    const value = JSON.parse(original); mutate(value); assert.throws(()=>parseCanvas(JSON.stringify(value)));
  }
  assert.throws(()=>parseCanvas('{broken'));
  assert.throws(()=>parseCanvas(JSON.stringify({nodes:Array.from({length:501},(_,index)=>({id:String(index),type:'text',x:0,y:0,width:1,height:1,text:''}))})),/500/u);
});
test('variables are typed text with own-property lookup and never evaluate expressions', () => {
  const values={title:'Note',count:42,done:false,tags:['one','two'],project:{name:'Nested'},empty:null};
  assert.equal(resolveVariable('title',values),'Note'); assert.equal(resolveVariable('count',values),'42');
  assert.equal(resolveVariable('done',values),'false'); assert.equal(resolveVariable('tags',values),'one, two');
  assert.equal(resolveVariable('project.name',values),'Nested'); assert.equal(resolveVariable('empty',values),'');
  assert.equal(resolveVariable('document.name',values,'file.md'),'file.md');
  assert.equal(resolveVariable('toString',values),null); assert.equal(resolveVariable('project.constructor',values),null);
  const result=substituteVariables('{{title}} {{count+1}} {{missing}} {{missing}}',values);
  assert.equal(result.text,'Note {{count+1}} {{missing}} {{missing}}'); assert.deepEqual(result.missing,['count+1','missing']);
});
test('template insertion replaces exact selection and preserves surrounding CRLF bytes', () => {
  const text='---\r\ntitle: Note\r\n---\r\nBefore SELECT After\r\n', from=text.indexOf('SELECT');
  const next=insertTemplate(text,from,from+6,'New\nText');
  assert.equal(next,text.replace('SELECT','New\r\nText')); assert.throws(()=>insertTemplate(text,-1,4,'x'));
  assert.throws(()=>insertTemplate('x'.repeat(4*1024*1024),0,0,'more'),/4 MiB/u);
  assert.throws(()=>substituteVariables('{{big}}'.repeat(10),{big:'x'.repeat(1024*1024)}),/4 MiB/u);
});
test('template library bounds reject excess data without truncation or mutating saved entries', () => {
  const library=[{id:'one',name:'Note',content:'# Template',updatedAt:1}];
  assert.deepEqual(readTemplateLibrary(library),library); assert.notEqual(readTemplateLibrary(library)[0],library[0]);
  assert.throws(()=>readTemplateLibrary([...library,...library]),/duplicate/u);
  assert.throws(()=>readTemplateLibrary({invalid:true}),/invalid/u);
  assert.throws(()=>validateTemplateLibrary([{...library[0],content:'x'.repeat(32*1024)}]),/32 KiB/u);
  assert.equal(library[0].content,'# Template');
});
console.log(passed+' Canvas and template scenarios passed.');
