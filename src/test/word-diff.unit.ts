import assert from 'node:assert/strict';
import test from 'node:test';
import { diffWords } from '../word-diff';

const changed = (text: string, ranges: readonly { start: number; end: number }[]) =>
	ranges.map(range => text.slice(range.start, range.end));

test('highlights only the changed words of a paired line', () => {
	const before = 'const total = items.reduce(sum, 0);';
	const after = 'const total = values.reduce(sum, 1);';
	const diff = diffWords(before, after);
	assert.ok(diff);
	assert.deepEqual(changed(before, diff.deleted), ['items', '0']);
	assert.deepEqual(changed(after, diff.added), ['values', '1']);
});

test('reports pure insertions and deletions on one side only', () => {
	const diff = diffWords('call(a, b)', 'call(a, b, c)');
	assert.ok(diff);
	assert.deepEqual(diff.deleted, []);
	assert.deepEqual(changed('call(a, b, c)', diff.added), [', c']);
});

test('joins changed words separated by unchanged whitespace', () => {
	const after = 'return the quick brown fox;';
	const diff = diffWords('return the slow red fox;', after);
	assert.ok(diff);
	assert.deepEqual(changed(after, diff.added), ['quick brown']);
});

test('skips identical, dissimilar, and oversized lines', () => {
	assert.equal(diffWords('same', 'same'), undefined);
	assert.equal(diffWords('import { a } from "b";', 'export default class Widget {}'), undefined);
	assert.equal(diffWords('x'.repeat(1001), 'y'), undefined);
});

test('treats non-ASCII letters as word characters', () => {
	const after = 'grüße an Müller';
	const diff = diffWords('grüße an Meier', after);
	assert.ok(diff);
	assert.deepEqual(changed(after, diff.added), ['Müller']);
});
