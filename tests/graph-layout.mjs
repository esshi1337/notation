import assert from 'node:assert/strict';
import { displayLabel, layoutGraph } from '../src/graph-layout.ts';

function overlaps(a, b) {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.01
    && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.01;
}

function assertBounded(layout, count) {
  assert.equal(layout.points.length, count);
  assert.ok(layout.width > 0, 'layout has a content width');
  assert.ok(layout.height > 0, 'layout has a content height');
  for (const point of layout.points) {
    assert.ok(point.x >= -0.01, `${point.id} starts inside the content extent`);
    assert.ok(point.y >= -0.01, `${point.id} starts inside the content extent`);
    assert.ok(point.x + point.width <= layout.width + 0.01, `${point.id} label ends inside the content extent`);
    assert.ok(point.y + point.height <= layout.height + 0.01, `${point.id} label ends inside the content extent`);
  }
  for (let left = 0; left < layout.points.length; left += 1) {
    for (let right = left + 1; right < layout.points.length; right += 1) {
      assert.ok(!overlaps(layout.points[left], layout.points[right]), `${layout.points[left].id} overlaps ${layout.points[right].id}`);
    }
  }
}

const denseNodes = Array.from({ length: 24 }, (_, index) => ({
  id: `note-${String(index).padStart(2, '0')}`,
  path: `/vault/a-rather-long-folder/note-${index}.md`,
  name: `note-${index}.md`,
  title: `A deliberately descriptive note title number ${index}`,
}));
const denseEdges = denseNodes.slice(1).map((node, index) => ({ source: denseNodes[index].id, target: node.id }));
denseEdges.push({ source: 'note-00', target: 'note-11' }, { source: 'note-04', target: 'note-18' }, { source: 'note-07', target: 'note-21' });

const dense = layoutGraph(denseNodes, denseEdges);
assertBounded(dense, 24);
assert.ok(dense.links.length >= denseEdges.length - 1, 'connected links are drawn');
assert.ok(dense.points.every((point) => point.label.length > 0 && point.label.length <= 40), 'labels are present and bounded');
assert.equal(displayLabel({ id: 'x', title: 'A deliberately descriptive note title number 0' }, 60).endsWith('…'), true, 'long labels use an ellipsis');

const reordered = layoutGraph([...denseNodes].reverse(), [...denseEdges].reverse());
assert.equal(reordered.signature, dense.signature, 'layout is deterministic regardless of input order');
assert.deepEqual(
  reordered.points.map(({ id, x, y }) => [id, x.toFixed(2), y.toFixed(2)]),
  dense.points.map(({ id, x, y }) => [id, x.toFixed(2), y.toFixed(2)]),
  'node positions are deterministic',
);

const single = layoutGraph([{ id: 'only', title: 'Only note', path: '/only.md' }], []);
assertBounded(single, 1);
assert.ok(single.width >= 56 && single.height >= 28, 'single node keeps a readable card');

const disconnectedNodes = [
  { id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }, { id: 'c', title: 'Gamma' },
  { id: 'd', title: 'Delta' }, { id: 'e', title: 'Epsilon' },
];
const disconnected = layoutGraph(disconnectedNodes, [{ source: 'a', target: 'b' }, { source: 'd', target: 'e' }]);
assertBounded(disconnected, 5);

const empty = layoutGraph([], []);
assert.equal(empty.points.length, 0);
assert.equal(empty.width, 0);
assert.equal(empty.height, 0);

const largeNodes = Array.from({ length: 200 }, (_, index) => ({ id: `n-${index}`, title: `Note ${index} with a readable label` }));
const largeEdges = largeNodes.slice(1).map((node, index) => ({ source: largeNodes[index].id, target: node.id }));
const large = layoutGraph(largeNodes, largeEdges);
assertBounded(large, 200);

console.log('graph-layout: 24 dense, 1 single, 5 disconnected, 0 empty, 200 linked nodes passed');
