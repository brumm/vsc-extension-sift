import assert from 'node:assert/strict';
import test from 'node:test';
import { byteRangesToFilterMatches } from '../project-search';

test('converts fff UTF-8 byte ranges to VS Code UTF-16 columns', () => {
	assert.deepEqual(
		byteRangesToFilterMatches('a😀café', [
			[1, 5],
			[6, 10],
		]),
		[
			{ start: 1, end: 3 },
			{ start: 4, end: 7 },
		],
	);
});
