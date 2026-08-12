import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	allPathSearchMatches,
	byteRangesToFilterMatches,
	compileFffQuery,
	deletedPathMatchesQuery,
	filesExcludeConstraints,
	projectSearchMatchesFromGrep,
	splitFffFilter,
	splitFffQuery,
} from '../project-search';

test('matches deleted paths against fuzzy, glob, exclusion, and Git queries', () => {
	assert.equal(deletedPathMatchesQuery('src/renamed-file.ts', ''), true);
	assert.equal(deletedPathMatchesQuery('src/renamed-file.ts', 'rnmd'), true);
	assert.equal(deletedPathMatchesQuery('src/renamed-file.ts', '*.ts'), true);
	assert.equal(deletedPathMatchesQuery('src/renamed-file.ts', 'git:deleted'), true);
	assert.equal(deletedPathMatchesQuery('src/renamed-file.ts', 'git:modified'), false);
	assert.equal(deletedPathMatchesQuery('src/renamed-file.ts', '!src/'), false);
	assert.equal(deletedPathMatchesQuery('dist/file.ts', '', ['dist/**']), false);
});

test('splits only leading FFF path constraints from diff content', () => {
	assert.deepEqual(splitFffQuery('src/ *.ts !test/ changed value'), {
		constraints: ['src/', '*.ts', '!test/'],
		content: 'changed value',
	});
	assert.deepEqual(splitFffQuery('changed *.ts'), {
		constraints: [],
		content: 'changed *.ts',
	});
});

test('unescapes a constraint-like literal in diff content', () => {
	assert.deepEqual(splitFffFilter({
		text: '\\*.ts changed',
		matchCase: true,
		wholeWord: false,
		useRegex: false,
		contextLines: 0,
	}), {
		constraints: [],
		content: '*.ts changed',
	});
});

test('passes the raw FFF path query through every result page', () => {
	const query = '**/foo/*.ts !test/ git:modified fuzzy term';
	const calls: { query: string; pageIndex?: number; pageSize?: number }[] = [];
	const finder = {
		fileSearch(receivedQuery: string, options?: { pageIndex?: number; pageSize?: number }) {
			calls.push({ query: receivedQuery, ...options });
			const relativePath = options?.pageIndex === 0
				? 'src/foo/one.ts'
				: 'src/foo/two.ts';
			return {
				ok: true as const,
				value: {
					items: [{
						relativePath,
						fileName: relativePath.split('/').at(-1)!,
						size: 0,
						modified: 0,
						accessFrecencyScore: 0,
						modificationFrecencyScore: 0,
						totalFrecencyScore: 0,
						gitStatus: 'clean',
					}],
					scores: [],
					totalMatched: 2,
					totalFiles: 2,
				},
			};
		},
	};

	assert.deepEqual(
		allPathSearchMatches(
			finder as Parameters<typeof allPathSearchMatches>[0],
			query,
			relativePath => `file:///workspace/${relativePath}`,
		),
		[
			{ uri: 'file:///workspace/src/foo/one.ts', relativePath: 'src/foo/one.ts', gitStatus: 'clean' },
			{ uri: 'file:///workspace/src/foo/two.ts', relativePath: 'src/foo/two.ts', gitStatus: 'clean' },
		],
	);
	assert.deepEqual(calls, [
		{ query, pageIndex: 0, pageSize: 1_000 },
		{ query, pageIndex: 1, pageSize: 1_000 },
	]);
});

test('sorts changed path results alphabetically before clean results', () => {
	const entries = [
		{ relativePath: 'clean-first.ts', gitStatus: 'clean' },
		{ relativePath: 'z-modified.ts', gitStatus: 'modified' },
		{ relativePath: 'a-untracked.ts', gitStatus: 'untracked' },
		{ relativePath: 'b-deleted.ts', gitStatus: 'deleted' },
		{ relativePath: 'clean-second.ts', gitStatus: 'clean' },
	];
	const finder = {
		fileSearch() {
			return {
				ok: true as const,
				value: {
					items: entries.map(({ relativePath, gitStatus }) => ({
						relativePath,
						fileName: relativePath,
						size: 0,
						modified: 0,
						accessFrecencyScore: 0,
						modificationFrecencyScore: 0,
						totalFrecencyScore: 0,
						gitStatus,
					})),
					scores: [],
					totalMatched: entries.length,
					totalFiles: entries.length,
				},
			};
		},
	};

	assert.deepEqual(
		allPathSearchMatches(
			finder as Parameters<typeof allPathSearchMatches>[0],
			'',
			relativePath => relativePath,
		).map(match => [match.relativePath, match.gitStatus]),
		[
			['a-untracked.ts', 'untracked'],
			['b-deleted.ts', 'deleted'],
			['z-modified.ts', 'modified'],
			['clean-first.ts', 'clean'],
			['clean-second.ts', 'clean'],
		],
	);
});

test('keeps FFF scoring order when a path query is active', () => {
	const finder = {
		fileSearch() {
			return {
				ok: true as const,
				value: {
					items: [
						{ relativePath: 'z-clean.ts', gitStatus: 'clean' },
						{ relativePath: 'a-modified.ts', gitStatus: 'modified' },
					].map(item => ({
						...item,
						fileName: item.relativePath,
						size: 0,
						modified: 0,
						accessFrecencyScore: 0,
						modificationFrecencyScore: 0,
						totalFrecencyScore: 0,
					})),
					scores: [],
					totalMatched: 2,
					totalFiles: 2,
				},
			};
		},
	};

	assert.deepEqual(
		allPathSearchMatches(
			finder as Parameters<typeof allPathSearchMatches>[0],
			'file',
			relativePath => relativePath,
		).map(match => match.relativePath),
		['z-clean.ts', 'a-modified.ts'],
	);
});

test('FFF path search applies inline glob and exclusion constraints', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'sift-fff-paths-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, 'src/foo'), { recursive: true });
	await mkdir(join(directory, 'test/foo'), { recursive: true });
	await writeFile(join(directory, 'src/foo/one.ts'), '');
	await writeFile(join(directory, 'src/foo/two.js'), '');
	await writeFile(join(directory, 'test/foo/one.ts'), '');

	const { FileFinder } = await import('@ff-labs/fff-node');
	const created = FileFinder.create({ basePath: directory });
	assert.equal(created.ok, true);
	if (!created.ok) {
		return;
	}
	const finder = created.value;
	t.after(() => finder.destroy());
	assert.equal((await finder.waitForIndexReady(10_000)).ok, true);

	assert.deepEqual(
		allPathSearchMatches(
			finder,
			'**/foo/*.ts !test/ one',
			relativePath => relativePath,
		).map(match => match.relativePath),
		['src/foo/one.ts'],
	);
});

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

test('prepends normalized files.exclude constraints opaquely', () => {
	const constraints = filesExcludeConstraints([
		'**/.agents',
		'skills-lock.json',
		'build/**',
		'./root-only.txt',
		'folder with spaces/**',
		'',
	]);
	assert.deepEqual(constraints, [
		'!.agents',
		'!skills-lock.json',
		'!/build',
		'!/root-only.txt',
		'!/folder\\x20with\\x20spaces',
	]);
	assert.equal(
		compileFffQuery({
			text: 'UseState',
			matchCase: false,
			wholeWord: false,
			useRegex: false,
			contextLines: 0,
		}, constraints).query,
		'!.agents !skills-lock.json !/build !/root-only.txt !/folder\\x20with\\x20spaces usestate',
	);
});

test('FFF grep applies normalized files.exclude constraints', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'sift-fff-excludes-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, '.agents'), { recursive: true });
	await mkdir(join(directory, 'src/.agents'), { recursive: true });
	await mkdir(join(directory, 'build'), { recursive: true });
	await writeFile(join(directory, '.agents/root.txt'), 'needle');
	await writeFile(join(directory, 'src/.agents/nested.txt'), 'needle');
	await writeFile(join(directory, 'build/output.txt'), 'needle');
	await writeFile(join(directory, 'skills-lock.json'), 'needle');
	await writeFile(join(directory, 'visible.txt'), 'needle');

	const { FileFinder } = await import('@ff-labs/fff-node');
	const created = FileFinder.create({ basePath: directory });
	assert.equal(created.ok, true);
	if (!created.ok) {
		return;
	}
	const finder = created.value;
	t.after(() => finder.destroy());
	assert.equal((await finder.waitForIndexReady(10_000)).ok, true);

	const compiled = compileFffQuery({
		text: 'needle',
		matchCase: false,
		wholeWord: false,
		useRegex: false,
		contextLines: 0,
	}, filesExcludeConstraints([
		'**/.agents',
		'skills-lock.json',
		'build/**',
	]));
	const result = finder.grep(compiled.query, {
		mode: compiled.mode,
		smartCase: compiled.smartCase,
	});
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(
			result.value.items.map(item => item.relativePath),
			['visible.txt'],
		);
	}
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
