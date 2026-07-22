import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	byteRangesToFilterMatches,
	compileFffQuery,
	projectSearchMatchesFromGrep,
} from '../project-search';

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

test('compiles path constraints separately from literal and regex content', () => {
	assert.deepEqual(
		compileFffQuery({
			text: 'src/ *.ts !test/ UseState',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		}),
		{
			query: 'src/ *.ts !test/ usestate',
			mode: 'plain',
			smartCase: true,
			gitConstraints: [],
		},
	);

	assert.deepEqual(
		compileFffQuery({
			text: 'git:modified src/ *.ts ^use(State|Effect)$',
			matchCase: false,
			wholeWord: true,
			useRegex: true,
			contextLines: 0,
		}),
		{
			query:
				'src/ *.ts (?i:\\b(?:^use(State|Effect)$)\\b)',
			mode: 'regex',
			smartCase: false,
			gitConstraints: ['git:modified'],
		},
	);

	assert.deepEqual(
		compileFffQuery({
			text: '!git:untracked UseState',
			matchCase: true,
			wholeWord: true,
			useRegex: false,
			contextLines: 0,
		}),
		{
			query: '(?:\\b(?:UseState)\\b)',
			mode: 'regex',
			smartCase: false,
			gitConstraints: ['!git:untracked'],
		},
	);
});

test('uses an explicit leading path-constraint grammar', () => {
	assert.deepEqual(
		compileFffQuery({
			text: 'https://example.com UseState *.ts',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		}),
		{
			query: '(?i:https:\\x2f\\x2fexample\\.com\\x20usestate\\x20\\*\\.ts)',
			mode: 'regex',
			smartCase: false,
			gitConstraints: [],
		},
	);

	assert.deepEqual(
		compileFffQuery({
			text: '\\*.ts UseState',
			matchCase: true,
			wholeWord: true,
			useRegex: false,
			contextLines: 0,
		}),
		{
			query: '(?:\\b(?:\\*\\.ts\\x20UseState)\\b)',
			mode: 'regex',
			smartCase: false,
			gitConstraints: [],
		},
	);
});

test('protects literal regex braces without changing semantic quantifiers', () => {
	assert.equal(
		compileFffQuery({
			text: '\\{src,lib\\}',
			matchCase: true,
			wholeWord: false,
			useRegex: true,
			contextLines: 0,
		}).query,
		'(?:\\x7bsrc,lib\\x7d)',
	);
	assert.equal(
		compileFffQuery({
			text: '\\\\{2}',
			matchCase: true,
			wholeWord: false,
			useRegex: true,
			contextLines: 0,
		}).query,
		'(?:\\\\{2})',
	);
	assert.equal(
		compileFffQuery({
			text: '\\/foo.*\\/',
			matchCase: true,
			wholeWord: false,
			useRegex: true,
			contextLines: 0,
		}).query,
		'(?:\\x2ffoo.*\\x2f)',
	);
});

test('fff treats a middle constraint-looking token as search content', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'sift-fff-query-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(
		join(directory, 'one.ts'),
		'UseState *.ts\nUseState {src,lib}\nUseState {src,lib} marker\n/foo123/\n',
	);
	await writeFile(
		join(directory, 'two.txt'),
		'UseState *.ts\nUseState {src,lib}\nUseState {src,lib} marker\n/foo123/\n',
	);

	const { FileFinder } = await import('@ff-labs/fff-node');
	const created = FileFinder.create({ basePath: directory });
	assert.equal(created.ok, true);
	if (!created.ok) {
		return;
	}
	const finder = created.value;
	t.after(() => finder.destroy());
	const indexed = await finder.waitForIndexReady(10_000);
	assert.equal(indexed.ok, true);

	const compiled = compileFffQuery({
		text: 'UseState *.ts',
		matchCase: true,
		wholeWord: false,
		useRegex: false,
		contextLines: 0,
	});
	const result = finder.grep(compiled.query, {
		mode: compiled.mode,
		smartCase: compiled.smartCase,
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(
			result.value.items.map(item => item.relativePath).sort(),
			['one.ts', 'two.txt'],
		);
	}

	const braceCompiled = compileFffQuery({
		text: 'UseState {src,lib}',
		matchCase: true,
		wholeWord: false,
		useRegex: false,
		contextLines: 0,
	});
	const braceResult = finder.grep(braceCompiled.query, {
		mode: braceCompiled.mode,
		smartCase: braceCompiled.smartCase,
	});
	assert.equal(braceResult.ok, true);
	if (braceResult.ok) {
		assert.deepEqual(
			[...new Set(
				braceResult.value.items.map(item => item.relativePath),
			)].sort(),
			['one.ts', 'two.txt'],
		);
	}

	const wholeWordBraceCompiled = compileFffQuery({
		text: 'UseState {src,lib} marker',
		matchCase: true,
		wholeWord: true,
		useRegex: false,
		contextLines: 0,
	});
	const wholeWordBraceResult = finder.grep(wholeWordBraceCompiled.query, {
		mode: wholeWordBraceCompiled.mode,
		smartCase: wholeWordBraceCompiled.smartCase,
	});
	assert.equal(wholeWordBraceResult.ok, true);
	if (wholeWordBraceResult.ok) {
		assert.deepEqual(
			wholeWordBraceResult.value.items
				.map(item => item.relativePath)
				.sort(),
			['one.ts', 'two.txt'],
		);
	}

	const slashRegexCompiled = compileFffQuery({
		text: '\\/foo.*\\/',
		matchCase: true,
		wholeWord: false,
		useRegex: true,
		contextLines: 0,
	});
	const slashRegexResult = finder.grep(slashRegexCompiled.query, {
		mode: slashRegexCompiled.mode,
		smartCase: slashRegexCompiled.smartCase,
	});
	assert.equal(slashRegexResult.ok, true);
	if (slashRegexResult.ok) {
		assert.deepEqual(
			slashRegexResult.value.items.map(item => item.relativePath).sort(),
			['one.ts', 'two.txt'],
		);
	}
});

test('turns overlapping fff context into deduplicated mapped lines', () => {
	const matches = projectSearchMatchesFromGrep(
		[
			{
				relativePath: 'src/example.ts',
				lineNumber: 2,
				lineContent: 'target one',
				matchRanges: [[0, 6]],
				contextBefore: ['zero'],
				contextAfter: ['middle', 'target two'],
			},
			{
				relativePath: 'src/example.ts',
				lineNumber: 4,
				lineContent: 'target two',
				matchRanges: [[0, 6]],
				contextBefore: ['target one', 'middle'],
				contextAfter: ['last'],
			},
		],
		path => `file:///workspace/${path}`,
	);

	assert.deepEqual(matches, [
		{
			uri: 'file:///workspace/src/example.ts',
			relativePath: 'src/example.ts',
			line: 0,
			text: 'zero',
			matches: [],
		},
		{
			uri: 'file:///workspace/src/example.ts',
			relativePath: 'src/example.ts',
			line: 1,
			text: 'target one',
			matches: [{ start: 0, end: 6 }],
		},
		{
			uri: 'file:///workspace/src/example.ts',
			relativePath: 'src/example.ts',
			line: 2,
			text: 'middle',
			matches: [],
		},
		{
			uri: 'file:///workspace/src/example.ts',
			relativePath: 'src/example.ts',
			line: 3,
			text: 'target two',
			matches: [{ start: 0, end: 6 }],
		},
		{
			uri: 'file:///workspace/src/example.ts',
			relativePath: 'src/example.ts',
			line: 4,
			text: 'last',
			matches: [],
		},
	]);
});
