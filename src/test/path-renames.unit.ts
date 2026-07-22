import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidRelativePath } from '../path-renames';

test('accepts normalized workspace-relative file paths', () => {
	assert.equal(invalidRelativePath('src/new-parent/example.test.ts'), undefined);
});

test('rejects unsafe or non-file destination paths', () => {
	for (const value of [
		'',
		'/absolute.ts',
		'C:\\absolute.ts',
		'../outside.ts',
		'src/../outside.ts',
		'src//file.ts',
		'src/folder/',
		'src\\file.ts',
	]) {
		assert.ok(invalidRelativePath(value), value);
	}
});
