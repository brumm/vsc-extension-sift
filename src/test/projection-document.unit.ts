import assert from 'node:assert/strict';
import test from 'node:test';
import {
	FilterQuery,
	ProjectionDocument,
} from '../projection-document';

test('file projection exposes one canonical mapped row', () => {
	const filter: FilterQuery = {
		text: 'needle',
		matchCase: false,
		wholeWord: false,
		useRegex: false,
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

test('project projection owns mapped and annotation rows together', () => {
	const projection = ProjectionDocument.forProject([
		{
			uri: 'file:///workspace/a.ts',
			relativePath: 'a.ts',
			line: 4,
			text: 'const a = 1;',
		},
		{
			uri: 'file:///workspace/b.ts',
			relativePath: 'b.ts',
			line: 8,
			text: 'const b = 2;',
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

test('save planning rejects inserted projected rows', () => {
	const projection = ProjectionDocument.forFile({
		sourceUri: 'file:///workspace/example.ts',
		sourceText: 'one\ntwo',
		filter: {
			text: '',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
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
		},
		{
			uri: 'file:///workspace/example.ts',
			relativePath: 'example.ts',
			line: 0,
			text: 'mapped',
		},
	]);

	const plan = projection.planSave('\nfirst\nsecond');
	assert.equal(plan.ok, false);
});
