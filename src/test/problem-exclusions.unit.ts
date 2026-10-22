import * as assert from 'node:assert/strict';
import test from 'node:test';
import { compileProblemExclusions } from '../problem-exclusions';

test('excludes a problem only when every configured field matches', () => {
	const isExcluded = compileProblemExclusions([{
		source: '^cSpell$',
		message: '^Unknown word',
	}]);

	assert.equal(isExcluded({
		source: 'cSpell',
		message: 'Unknown word (colourise)',
	}), true);
	assert.equal(isExcluded({
		source: 'cSpell',
		message: 'Forbidden word (colourise)',
	}), false);
	assert.equal(isExcluded({
		source: 'typescript',
		message: 'Unknown word (colourise)',
	}), false);
});

test('supports code rules and ignores unknown or invalid rules', () => {
	const isExcluded = compileProblemExclusions([
		{ severity: 'error' } as never,
		{ message: '[' },
		{ code: '^(spell|lint)-\\d+$' },
	]);

	assert.equal(isExcluded({ message: 'Anything' }), false);
	assert.equal(isExcluded({ message: 'Anything', code: 'spell-12' }), true);
});
