import assert from 'node:assert/strict';
import test from 'node:test';
import { capturedQueryText, isTypingChange } from '../query-capture';

test('captures text typed at the start of the projection', () => {
	assert.equal(capturedQueryText('alpha\nbeta', 'fooalpha\nbeta', 0, 3), 'foo');
});

test('ignores auto-closed characters after the cursor', () => {
	assert.equal(capturedQueryText('alpha', 'call()alpha', 0, 5), 'call(');
});

test('captures text typed at a later cursor position', () => {
	assert.equal(capturedQueryText('one\ntwo', 'one\ntwoxy', 7, 9), 'xy');
});

test('reflects deletions of typed text', () => {
	assert.equal(capturedQueryText('alpha', 'alpha', 0, 0), '');
});

test('drops line breaks', () => {
	assert.equal(capturedQueryText('alpha', 'a\nbalpha', 0, 3), 'ab');
});

test('rejects edits before the capture position', () => {
	assert.equal(capturedQueryText('one\ntwo', 'on\ntwox', 7, 7), undefined);
	assert.equal(capturedQueryText('one\ntwo', 'one\ntwo', 7, 4), undefined);
});

test('treats keystrokes after the capture position as typing', () => {
	assert.equal(isTypingChange({ rangeOffset: 0, rangeLength: 0, text: 'a' }, 0), true);
	assert.equal(isTypingChange({ rangeOffset: 4, rangeLength: 1, text: '' }, 3), true);
	assert.equal(isTypingChange({ rangeOffset: 0, rangeLength: 0, text: '()' }, 0), true);
});

test('treats larger or earlier edits as intentional', () => {
	assert.equal(isTypingChange({ rangeOffset: 0, rangeLength: 40, text: 'x' }, 0), false);
	assert.equal(isTypingChange({ rangeOffset: 0, rangeLength: 0, text: 'a\nb' }, 0), false);
	assert.equal(isTypingChange({ rangeOffset: 2, rangeLength: 0, text: 'a' }, 3), false);
});
