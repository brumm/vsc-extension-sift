import assert from 'node:assert/strict';
import test from 'node:test';
import { projectionLanguageId } from '../projection-language';

test('uses grammar-only language IDs for projected TypeScript documents', () => {
	assert.equal(projectionLanguageId('typescript'), 'sift-typescript');
	assert.equal(
		projectionLanguageId('typescriptreact'),
		'sift-typescriptreact',
	);
});

test('preserves other projected language IDs', () => {
	assert.equal(projectionLanguageId('rust'), 'rust');
});
