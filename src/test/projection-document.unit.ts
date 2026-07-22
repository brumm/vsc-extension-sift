import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FilterQuery,
	findFilterMatches,
	ProjectionDocument,
} from '../projection-document';

test('finds every literal filter match with case sensitivity options', () => {
	assert.deepEqual(
		findFilterMatches('Needle needle NEEDLE', {
			text: 'needle',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		}),
		[
			{ start: 0, end: 6 },
			{ start: 7, end: 13 },
			{ start: 14, end: 20 },
		],
	);

	assert.deepEqual(
		findFilterMatches('Needle needle', {
			text: 'needle',
			matchCase: true,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		}),
		[{ start: 7, end: 13 }],
	);
});

test('finds whole-word and regular-expression filter matches', () => {
	assert.deepEqual(
		findFilterMatches('cat scatter cat', {
			text: 'cat',
			matchCase: false,
			wholeWord: true,
			useRegex: false,
			contextLines: 0,
		}),
		[
			{ start: 0, end: 3 },
			{ start: 12, end: 15 },
		],
	);

	assert.deepEqual(
		findFilterMatches('item-12 item-345', {
			text: 'item-\\d+',
			matchCase: false,
			wholeWord: false,
			useRegex: true,
			contextLines: 0,
		}),
		[
			{ start: 0, end: 7 },
			{ start: 8, end: 16 },
		],
	);
});

test('empty and zero-length filters do not create highlight ranges', () => {
	assert.deepEqual(
		findFilterMatches('anything', {
			text: '',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		}),
		[],
	);
	assert.deepEqual(
		findFilterMatches('abc', {
			text: '^',
			matchCase: false,
			wholeWord: false,
			useRegex: true,
			contextLines: 0,
		}),
		[],
	);
	assert.deepEqual(
		findFilterMatches('abc', {
			text: '[',
			matchCase: true,
			wholeWord: false,
			useRegex: true,
			contextLines: 0,
		}),
		[],
	);
});

test('file projection exposes one canonical mapped row', () => {
	const filter: FilterQuery = {
		text: 'needle',
		matchCase: false,
		wholeWord: false,
		useRegex: false,
		contextLines: 0,
	};
	const projection = ProjectionDocument.forFile({
		sourceUri: 'file:///workspace/example.ts',
		sourceText: 'zero\nNeedle\nlast',
		filter,
	});

	assert.equal(projection.content, 'Needle');
	assert.deepEqual(projection.rows, [
		{
			kind: 'mapped',
			source: { uri: 'file:///workspace/example.ts', line: 1 },
			baseline: 'Needle',
		},
	]);
	assert.deepEqual(projection.sourceAt(0, 3), {
		uri: 'file:///workspace/example.ts',
		line: 1,
		character: 3,
	});
});

test('file projection includes editable context lines around matches', () => {
	const projection = ProjectionDocument.forFile({
		sourceUri: 'file:///workspace/example.ts',
		sourceText: 'zero\nneedle one\ntwo\nexcluded\nfour\nneedle five\nsix',
		filter: {
			text: 'needle',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 1,
		},
	});

	assert.equal(
		projection.content,
		'zero\nneedle one\ntwo\nfour\nneedle five\nsix',
	);
	assert.deepEqual(
		projection.rows.flatMap(row =>
			row.kind === 'mapped' ? [row.source.line] : [],
		),
		[0, 1, 2, 4, 5, 6],
	);
	assert.deepEqual(projection.planSave(
		'zero changed\nneedle one\ntwo\nfour\nneedle five\nsix',
	), {
		ok: true,
		edits: [{
			uri: 'file:///workspace/example.ts',
			line: 0,
			before: 'zero',
			after: 'zero changed',
		}],
	});
});

test('project projection owns mapped and annotation rows together', () => {
	const projection = ProjectionDocument.forProject([
		{
			uri: 'file:///workspace/a.ts',
			relativePath: 'a.ts',
			line: 4,
			text: 'const a = 1;',
			matches: [{ start: 6, end: 7 }],
		},
		{
			uri: 'file:///workspace/b.ts',
			relativePath: 'b.ts',
			line: 8,
			text: 'const b = 2;',
			matches: [{ start: 6, end: 7 }],
		},
	]);

	assert.equal(projection.content, '\nconst a = 1;\n\n\nconst b = 2;');
	assert.deepEqual(
		projection.rows.map(row => row.kind === 'mapped' ? row.kind : row.role),
		['header', 'mapped', 'spacer', 'header', 'mapped'],
	);
	assert.deepEqual(projection.sourceAt(3, 9), {
		uri: 'file:///workspace/b.ts',
		line: 8,
		character: 0,
	});
	assert.deepEqual(
		projection.rows[1].kind === 'mapped'
			? projection.rows[1].matches
			: undefined,
		[{ start: 6, end: 7 }],
	);
});

test('path projection maps editable relative paths to source files', () => {
	const projection = ProjectionDocument.forPaths([
		{ uri: 'file:///workspace/src/one.ts', relativePath: 'src/one.ts' },
		{ uri: 'file:///workspace/src/two.ts', relativePath: 'src/two.ts' },
	]);

	assert.equal(projection.content, 'src/one.ts\nsrc/two.ts');
	assert.deepEqual(projection.sourceAt(1, 8), {
		uri: 'file:///workspace/src/two.ts',
		line: 0,
		character: 0,
	});
	assert.deepEqual(projection.planPathSave('lib/one.ts\nsrc/two.ts'), {
		ok: true,
		renames: [{
			sourceUri: 'file:///workspace/src/one.ts',
			before: 'src/one.ts',
			after: 'lib/one.ts',
		}],
	});
	assert.deepEqual(projection.sourcesAt([
		{ line: 1, character: 4 },
		{ line: 0, character: 4 },
		{ line: 1, character: 9 },
	]), [
		{ uri: 'file:///workspace/src/two.ts', line: 0, character: 0 },
		{ uri: 'file:///workspace/src/one.ts', line: 0, character: 0 },
	]);

	const accepted = projection.acceptWorkingCopy('lib/one.ts\nsrc/two.ts', [{
		before: 'file:///workspace/src/one.ts',
		after: 'file:///workspace/lib/one.ts',
	}]);
	assert.deepEqual(accepted.sourceAt(0, 5), {
		uri: 'file:///workspace/lib/one.ts',
		line: 0,
		character: 0,
	});
	assert.deepEqual(accepted.planPathSave('archive/one.ts\nsrc/two.ts'), {
		ok: true,
		renames: [{
			sourceUri: 'file:///workspace/lib/one.ts',
			before: 'lib/one.ts',
			after: 'archive/one.ts',
		}],
	});
});

test('path save planning rejects inserted rows', () => {
	const projection = ProjectionDocument.forPaths([
		{ uri: 'file:///workspace/one.ts', relativePath: 'one.ts' },
	]);

	assert.deepEqual(projection.planPathSave('one.ts\ntwo.ts'), {
		ok: false,
		message: 'Existing path rows may be edited, but rows cannot be inserted or deleted.',
	});
});

test('rebuilds a path projection from the last saved editor content', () => {
	const projection = ProjectionDocument.forPathContent(
		'new/one.ts\nnew/two.ts\n',
		(relativePath) => `file:///workspace/${relativePath}`,
	);

	assert.deepEqual(projection.planPathSave('old/one.ts\nold/two.ts\n'), {
		ok: true,
		renames: [
			{
				sourceUri: 'file:///workspace/new/one.ts',
				before: 'new/one.ts',
				after: 'old/one.ts',
			},
			{
				sourceUri: 'file:///workspace/new/two.ts',
				before: 'new/two.ts',
				after: 'old/two.ts',
			},
		],
	});
});

test('save planning maps an edited projected row back to its source line', () => {
	const projection = ProjectionDocument.forFile({
		sourceUri: 'file:///workspace/example.ts',
		sourceText: 'keep\nchange me',
		filter: {
			text: '',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		},
	});

	assert.deepEqual(projection.planSave('keep\nchanged'), {
		ok: true,
		edits: [
			{
				uri: 'file:///workspace/example.ts',
				line: 1,
				before: 'change me',
				after: 'changed',
			},
		],
	});
});

test('accepted terminal newline becomes a non-editable normalization row', () => {
	const projection = ProjectionDocument.forFile({
		sourceUri: 'file:///workspace/example.ts',
		sourceText: 'needle',
		filter: {
			text: '',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		},
	}).acceptWorkingCopy('needle\n');

	assert.equal(projection.rows.length, 2);
	assert.deepEqual(projection.rows[1], {
		kind: 'annotation',
		role: 'terminal',
	});
	assert.deepEqual(projection.planSave('changed\n'), {
		ok: true,
		edits: [{
			uri: 'file:///workspace/example.ts',
			line: 0,
			before: 'needle',
			after: 'changed',
		}],
	});
});

test('accepting an edited project row clears stale backend match ranges', () => {
	const projection = ProjectionDocument.forProject([{
		uri: 'file:///workspace/example.ts',
		relativePath: 'example.ts',
		line: 0,
		text: 'before',
		matches: [{ start: 0, end: 6 }],
	}]).acceptWorkingCopy('\nafter');

	assert.deepEqual(projection.rows[1], {
		kind: 'mapped',
		source: { uri: 'file:///workspace/example.ts', line: 0 },
		baseline: 'after',
		matches: undefined,
	});
});

test('save planning rejects inserted projected rows', () => {
	const projection = ProjectionDocument.forFile({
		sourceUri: 'file:///workspace/example.ts',
		sourceText: 'one\ntwo',
		filter: {
			text: '',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		},
	});

	const plan = projection.planSave('one\ninserted\ntwo');
	assert.equal(plan.ok, false);
});

test('save planning rejects edits to annotation rows', () => {
	const projection = ProjectionDocument.forProject([{
		uri: 'file:///workspace/example.ts',
		relativePath: 'example.ts',
		line: 0,
		text: 'mapped',
		matches: [{ start: 0, end: 6 }],
	}]);

	const plan = projection.planSave('edited header\nmapped');
	assert.deepEqual(plan, {
		ok: false,
		message: 'Annotation rows cannot be edited.',
	});
});

test('save planning rejects contradictory edits to a duplicated source line', () => {
	const projection = ProjectionDocument.forProject([
		{
			uri: 'file:///workspace/example.ts',
			relativePath: 'example.ts',
			line: 0,
			text: 'mapped',
			matches: [{ start: 0, end: 6 }],
		},
		{
			uri: 'file:///workspace/example.ts',
			relativePath: 'example.ts',
			line: 0,
			text: 'mapped',
			matches: [{ start: 0, end: 6 }],
		},
	]);

	const plan = projection.planSave('\nfirst\nsecond');
	assert.equal(plan.ok, false);
});
