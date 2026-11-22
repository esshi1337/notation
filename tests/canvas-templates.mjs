import assert from 'node:assert/strict';
import { parseCanvas, mutateCanvasDocument, canvasFormat, canvasNodeTitle, newCanvas, MAX_CARDS, MAX_CONNECTIONS } from '../src/canvas.ts';
const mutateCanvas = (text, mutation) => mutateCanvasDocument(text, mutation).text;
import { zoomAtPoint, toDocument, fitBounds, boundsOf, autoSides, edgeSides, pinnedSides, looksRightToLeftOnly, unpinAllSides, rectsTouching, neighbourInDirection, placeBySide, groupMembers, alignmentGuides, applyGeometry, copyFragment, pasteFragment, removeElements, canvasColor, MIN_ZOOM, MAX_ZOOM } from '../src/canvas-flow.ts';
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
test('card deletion removes only connected edges and a new canvas is empty', () => {
  const next = mutateCanvas(original, (canvas) => removeElements(canvas, ['a'], []));
  assert.deepEqual(parseCanvas(next).nodes.map((node) => node.id),['b']); assert.equal(parseCanvas(next).edges.length,0);
  assert.deepEqual(parseCanvas(newCanvas()),{nodes:[],edges:[]});
});
test('resize and direct connection mutations retain unknown document, card and edge fields', () => {
  const next = mutateCanvas(original, (canvas) => {
    canvas.nodes[0].width = 360; canvas.nodes[0].height = 220;
    canvas.edges.push({ id:'edge2', fromNode:'a', toNode:'b', fromSide:'right', toSide:'left' });
  });
  const value = parseCanvas(next);
  assert.deepEqual(value.metadata,{app:'other',unknown:[1,2]});
  assert.deepEqual(value.nodes[0].extension,{future:true});
  assert.equal(value.nodes[0].width,360); assert.equal(value.nodes[0].height,220);
  assert.equal(value.edges[1].id,'edge2'); assert.equal(value.edges[0].future,'retained');
  assert.equal(next.replaceAll('\r\n','').includes('\n'),false);
});
test('invalid, dangling, duplicate and oversized Canvas data rejects without repairing away content', () => {
  for (const mutate of [value=>value.nodes.push({...value.nodes[0]}),value=>value.nodes[0].x=Infinity,value=>value.edges[0].toNode='missing',value=>value.nodes[0].width=0,value=>value.nodes[0].type='unknown']) {
    const value = JSON.parse(original); mutate(value); assert.throws(()=>parseCanvas(JSON.stringify(value)));
  }
  assert.throws(()=>parseCanvas('{broken'));
  const cards=(length)=>Array.from({length},(_,index)=>({id:String(index),type:'text',x:0,y:0,width:1,height:1,text:''}));
  assert.equal(MAX_CARDS,2000); assert.equal(MAX_CONNECTIONS,8000);
  assert.equal(parseCanvas(JSON.stringify({nodes:cards(MAX_CARDS)})).nodes.length,MAX_CARDS);
  assert.throws(()=>parseCanvas(JSON.stringify({nodes:cards(MAX_CARDS+1)})),/2,000 cards/u);
  assert.throws(()=>parseCanvas(JSON.stringify({nodes:cards(2),edges:Array.from({length:MAX_CONNECTIONS+1},(_,index)=>({id:'e'+index,fromNode:'0',toNode:'1'}))})),/8,000 connections/u);
});
test('zoom keeps the document point under the cursor fixed and never pans at a zoom limit', () => {
  const view = { x: 40, y: -25, zoom: 0.8 }, cursor = { x: 317, y: 208 };
  const before = toDocument(view, cursor);
  for (const factor of [1.1, 0.9, 1.37, 0.25]) {
    const next = zoomAtPoint(view, cursor, factor), after = toDocument(next, cursor);
    assert.ok(Math.abs(next.zoom - 0.8 * factor) < 1e-12);
    assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
  }
  // Zooming in then out by the same steps returns to the same view.
  let round = view;
  for (let step = 0; step < 12; step++) round = zoomAtPoint(round, cursor, 1.1);
  for (let step = 0; step < 12; step++) round = zoomAtPoint(round, cursor, 1 / 1.1);
  assert.ok(Math.abs(round.x - view.x) < 1e-9 && Math.abs(round.y - view.y) < 1e-9 && Math.abs(round.zoom - view.zoom) < 1e-12);
  // At a limit the zoom clamps and the view stays put instead of sliding.
  const top = { x: 10, y: 20, zoom: MAX_ZOOM };
  assert.deepEqual(zoomAtPoint(top, cursor, 2), top);
  assert.equal(zoomAtPoint({ x: 0, y: 0, zoom: 0.11 }, cursor, 0.5).zoom, MIN_ZOOM);
  // The old canvas scaled around the board's top-left: the point under the cursor moved.
  const naive = { ...view, zoom: view.zoom * 1.1 };
  assert.ok(Math.abs(toDocument(naive, cursor).x - before.x) > 20);
  // A button zoom is the same maths around the board centre.
  const centre = { x: 400, y: 300 }, zoomed = zoomAtPoint({ x: 0, y: 0, zoom: 1 }, centre, 1.2);
  assert.deepEqual(toDocument(zoomed, centre), { x: 400, y: 300 });
});
test('fit centres the board, respects padding and never zooms in past 100%', () => {
  const bounds = boundsOf([{ x: -100, y: 0, width: 200, height: 100 }, { x: 900, y: 500, width: 100, height: 100 }]);
  assert.deepEqual(bounds, { x: -100, y: 0, width: 1100, height: 600 });
  const view = fitBounds(bounds, 800, 500);
  assert.ok(Math.abs(view.zoom - Math.min(720 / 1100, 420 / 600)) < 1e-12);
  assert.ok(Math.abs(toDocument(view, { x: 400, y: 250 }).x - 450) < 1e-9 && Math.abs(toDocument(view, { x: 400, y: 250 }).y - 300) < 1e-9);
  assert.equal(fitBounds({ x: 0, y: 0, width: 100, height: 50 }, 800, 500).zoom, 1);
  assert.equal(fitBounds({ x: 0, y: 0, width: 1e6, height: 1e6 }, 800, 500).zoom, MIN_ZOOM);
  assert.equal(boundsOf([]), null);
});
test('connections without pinned sides face each other; pinned sides are kept', () => {
  const card = (x, y) => ({ x, y, width: 200, height: 120 }), home = card(0, 0);
  assert.deepEqual(autoSides(home, card(400, 0)), { fromSide: 'right', toSide: 'left' });
  assert.deepEqual(autoSides(home, card(-400, 0)), { fromSide: 'left', toSide: 'right' });
  assert.deepEqual(autoSides(home, card(0, 300)), { fromSide: 'bottom', toSide: 'top' });
  assert.deepEqual(autoSides(home, card(0, -300)), { fromSide: 'top', toSide: 'bottom' });
  // Diagonal: the larger gap between the cards decides, not the centre distance.
  assert.deepEqual(autoSides(home, card(230, 400)), { fromSide: 'bottom', toSide: 'top' });
  assert.deepEqual(autoSides(home, card(500, 150)), { fromSide: 'right', toSide: 'left' });
  // Target left and above, the case that used to loop right → left around the card.
  assert.deepEqual(autoSides(home, card(-600, -200)), { fromSide: 'left', toSide: 'right' });
  // Overlapping cards still get a deterministic answer.
  assert.deepEqual(autoSides(home, card(50, 20)), { fromSide: 'bottom', toSide: 'top' });
  assert.deepEqual(edgeSides({ fromSide: 'top', toSide: 'top' }, home, card(400, 0)), { fromSide: 'top', toSide: 'top' });
  assert.deepEqual(edgeSides({ fromSide: 'bottom' }, home, card(400, 0)), { fromSide: 'bottom', toSide: 'left' });
  assert.deepEqual(edgeSides({}, home, card(-400, 0)), { fromSide: 'left', toSide: 'right' });
  assert.deepEqual(placeBySide({ x: 500, y: 300 }, 'top', 280, 180), { x: 360, y: 300 });
  assert.deepEqual(placeBySide({ x: 500, y: 300 }, 'left', 280, 180), { x: 500, y: 210 });
});
test('connections record only deliberately chosen sides, and boards written right-to-left are recognised and unpinned on request', () => {
  const card = (x, y) => ({ x, y, width: 200, height: 120 }), home = card(0, 0);
  // The automatic choice is never written, so the connection keeps following its cards.
  assert.deepEqual(pinnedSides(home, card(400, 0), { fromSide: 'right', toSide: 'left' }), {});
  assert.deepEqual(pinnedSides(home, card(400, 0), {}), {});
  assert.deepEqual(pinnedSides(home, card(400, 0), { fromSide: 'right' }), {});
  // A side other than the automatic one is the user's decision and is kept.
  assert.deepEqual(pinnedSides(home, card(400, 0), { fromSide: 'top', toSide: 'top' }), { fromSide: 'top', toSide: 'top' });
  assert.deepEqual(pinnedSides(home, card(400, 0), { fromSide: 'bottom', toSide: 'left' }), { fromSide: 'bottom' });
  assert.deepEqual(pinnedSides(home, card(-400, 0), { fromSide: 'right', toSide: null }), { fromSide: 'right' });
  const node = (id, x, y) => ({ id, type: 'text', x, y, width: 200, height: 120, text: id }), rl = (id, fromNode, toNode, extra = {}) => ({ id, fromNode, toNode, fromSide: 'right', toSide: 'left', ...extra });
  const legacy = { nodes: [node('a', 0, 0), node('b', 400, 0), node('c', 0, 300)], edges: [rl('ab', 'a', 'b'), rl('ac', 'a', 'c', { label: 'kept', future: 1 })] };
  assert.equal(looksRightToLeftOnly(legacy), true);
  // Left-to-right layouts drawn right → left look right already; one deliberate side means a person chose them.
  assert.equal(looksRightToLeftOnly({ nodes: legacy.nodes, edges: [rl('ab', 'a', 'b')] }), false);
  assert.equal(looksRightToLeftOnly({ nodes: legacy.nodes, edges: [rl('ab', 'a', 'b'), { id: 'ac', fromNode: 'a', toNode: 'c', fromSide: 'bottom', toSide: 'top' }] }), false);
  assert.equal(looksRightToLeftOnly({ nodes: legacy.nodes, edges: [rl('ab', 'a', 'b'), { id: 'ac', fromNode: 'a', toNode: 'c' }] }), false);
  assert.equal(looksRightToLeftOnly({ nodes: legacy.nodes, edges: [] }), false);
  const unpinned = structuredClone(legacy);
  assert.equal(unpinAllSides(unpinned), 2);
  assert.deepEqual(unpinned.edges, [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'ac', fromNode: 'a', toNode: 'c', label: 'kept', future: 1 }]);
  assert.equal(unpinAllSides(unpinned), 0); assert.equal(looksRightToLeftOnly(unpinned), false);
});
test('a selection box takes every card it touches and arrow keys find the nearest card in a direction', () => {
  const card = (id, x, y) => ({ id, x, y, width: 200, height: 120 });
  const cards = [card('a', 0, 0), card('b', 300, 0), card('c', 0, 200), card('d', 320, 230), card('far', 2000, 0)];
  const ids = (items) => items.map((item) => item.id);
  assert.deepEqual(ids(rectsTouching(cards, { x: -10, y: -10, width: 250, height: 150 })), ['a']);
  assert.deepEqual(ids(rectsTouching(cards, { x: 150, y: 50, width: 200, height: 200 })), ['a', 'b', 'c', 'd']);
  // Touching edges do not count, and an empty box selects nothing.
  assert.deepEqual(ids(rectsTouching(cards, { x: 200, y: 0, width: 100, height: 120 })), []);
  assert.deepEqual(ids(rectsTouching(cards, { x: 250, y: 150, width: 0, height: 0 })), []);
  const from = (id, direction) => neighbourInDirection(cards, cards.find((item) => item.id === id), direction)?.id ?? null;
  assert.equal(from('a', 'right'), 'b'); assert.equal(from('a', 'down'), 'c'); assert.equal(from('b', 'left'), 'a');
  assert.equal(from('b', 'down'), 'd'); assert.equal(from('d', 'up'), 'b'); assert.equal(from('d', 'left'), 'c');
  // Nothing in that direction, or only far off to the side.
  assert.equal(from('a', 'left'), null); assert.equal(from('a', 'up'), null); assert.equal(from('b', 'right'), 'far');
  assert.equal(from('c', 'right'), 'd'); assert.equal(from('far', 'down'), null);
});
test('group membership is geometric and alignment guides snap to the nearest edge or centre', () => {
  const group = { id: 'g', x: 0, y: 0, width: 400, height: 300 };
  const nodes = [group, { id: 'in', x: 40, y: 60, width: 200, height: 120 }, { id: 'edge', x: 200, y: 180, width: 200, height: 120 }, { id: 'half', x: 300, y: 250, width: 200, height: 120 }, { id: 'out', x: 500, y: 0, width: 200, height: 120 }, { id: 'inner', type: 'group', x: 10, y: 10, width: 100, height: 100 }];
  assert.deepEqual(groupMembers(nodes, group), ['in', 'edge', 'inner']);
  const others = [{ x: 0, y: 0, width: 200, height: 120 }];
  assert.deepEqual(alignmentGuides({ x: 300, y: 4, width: 200, height: 120 }, others, 6), { dx: 0, dy: -4, vertical: null, horizontal: 0 });
  assert.deepEqual(alignmentGuides({ x: 3, y: 300, width: 100, height: 50 }, others, 6), { dx: -3, dy: 0, vertical: 0, horizontal: null });
  // Centre on centre wins when it is the closest match.
  assert.deepEqual(alignmentGuides({ x: 51, y: 300, width: 100, height: 50 }, others, 6), { dx: -1, dy: 0, vertical: 100, horizontal: null });
  assert.deepEqual(alignmentGuides({ x: 320, y: 300, width: 100, height: 50 }, others, 6), { dx: 0, dy: 0, vertical: null, horizontal: null });
});
test('a move, resize, paste and delete each round-trip every unknown field, key order and CRLF', () => {
  const moved = mutateCanvasDocument(original, (canvas) => applyGeometry(canvas, new Map([['a', { x: 41.4, y: -12.6 }], ['b', { width: 333.5, height: 90 }]])));
  // Only the touched numbers differ, byte for byte.
  assert.equal(moved.text, original.replace('"x": 10', '"x": 41').replace('"y": 20', '"y": -13').replace('"width": 200', '"width": 334').replace('"height": 100', '"height": 90'));
  assert.deepEqual(parseCanvas(moved.text), moved.canvas);
  // An identity mutation reproduces the file exactly.
  assert.equal(mutateCanvas(original, () => {}), original);
  assert.throws(() => mutateCanvas(original, (canvas) => applyGeometry(canvas, new Map([['gone', { x: 1 }]]))), /removed/u);
  let serial = 0;
  const pasted = mutateCanvasDocument(original, (canvas) => { const ids = pasteFragment(canvas, copyFragment(canvas, ['a', 'b']), { x: 40, y: 40 }, () => 'new-' + ++serial); assert.deepEqual(ids, ['new-1', 'new-2']); }).canvas;
  assert.equal(pasted.nodes.length, 4); assert.equal(pasted.edges.length, 2);
  assert.deepEqual(pasted.nodes[2], { id: 'new-1', type: 'text', x: 50, y: 60, width: 240, height: 160, text: '# Text', extension: { future: true } });
  assert.deepEqual(pasted.nodes[3], { id: 'new-2', type: 'file', x: 440, y: 60, width: 200, height: 100, file: 'notes/example.md', subpath: '#Heading' });
  assert.deepEqual(pasted.edges[1], { id: 'new-3', fromNode: 'new-1', toNode: 'new-2', label: 'related', future: 'retained' });
  // The copies are independent of the originals, and a half-selected connection is not copied.
  pasted.nodes[2].extension.future = false; assert.deepEqual(pasted.nodes[0].extension, { future: true });
  assert.equal(copyFragment(parseCanvas(original), ['a']).edges.length, 0);
  const removed = mutateCanvasDocument(original, (canvas) => removeElements(canvas, [], ['edge'])).canvas;
  assert.equal(removed.edges.length, 0); assert.equal(removed.nodes.length, 2); assert.deepEqual(removed.metadata, { app: 'other', unknown: [1, 2] });
  assert.equal(mutateCanvasDocument(original, (canvas) => removeElements(canvas, ['b'], [])).canvas.edges.length, 0);
  assert.equal(canvasColor('4'), '#3fb26f'); assert.equal(canvasColor('#AABBCC'), '#AABBCC'); assert.equal(canvasColor('red'), null); assert.equal(canvasColor(undefined), null);
  assert.equal(canvasNodeTitle({ id: 't', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' }), 'Empty card');
  assert.equal(canvasNodeTitle({ id: 'g', type: 'group', x: 0, y: 0, width: 1, height: 1 }), 'Group');
});
test('a change keeps the file\'s own indentation, line endings and final newline, and a no-op changes no byte', () => {
  const value = { nodes: [{ id: 'a', type: 'text', x: 1, y: 2, width: 3, height: 4, text: 't' }], edges: [], extra: { kept: [1, { deep: true }] } };
  const styles = { two: JSON.stringify(value, null, 2) + '\n', four: JSON.stringify(value, null, 4) + '\n', tabs: JSON.stringify(value, null, '\t'), crlf: JSON.stringify(value, null, '\t').replaceAll('\n', '\r\n') + '\r\n', compact: JSON.stringify(value), compactNewline: JSON.stringify(value) + '\n' };
  assert.deepEqual(canvasFormat(styles.two), { eol: '\n', indent: '  ', trailing: true });
  assert.deepEqual(canvasFormat(styles.tabs), { eol: '\n', indent: '\t', trailing: false });
  assert.deepEqual(canvasFormat(styles.crlf), { eol: '\r\n', indent: '\t', trailing: true });
  assert.deepEqual(canvasFormat(styles.compact), { eol: '\n', indent: 0, trailing: false });
  for (const [name, text] of Object.entries(styles)) {
    // Nothing changed: the very same string comes back, and it is reported as unchanged.
    const idle = mutateCanvasDocument(text, (canvas) => { canvas.nodes[0].x = 1; });
    assert.equal(idle.text, text, name); assert.equal(idle.changed, false, name);
    // One number changed: only that number differs in the file.
    const moved = mutateCanvasDocument(text, (canvas) => { canvas.nodes[0].x = 77; });
    assert.equal(moved.changed, true, name);
    assert.equal(moved.text, text.replace(/"x":( ?)1/u, '"x":$177'), name);
    assert.deepEqual(parseCanvas(moved.text).extra, value.extra, name);
  }
  // Hand-spaced JSON that no serializer would write is normalised on a real change, never on a no-op.
  const odd = '{ "nodes":[ ],\n\n   "edges":[] }';
  assert.equal(mutateCanvasDocument(odd, () => {}).text, odd);
  assert.deepEqual(parseCanvas(mutateCanvasDocument(odd, (canvas) => { canvas.nodes.push(value.nodes[0]); }).text).nodes, value.nodes);
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
