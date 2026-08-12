import assert from 'node:assert/strict';
import test from 'node:test';
import {
	adaptParsedDiff,
	loadCommitDiff,
	loadDeletedPaths,
	loadWorkingTreeDiff,
	listDiffBaseRefs,
	listRecentCommits,
	resolveDiffBase,
} from '../git-diff';
import { GitRunOptions, GitRunner } from '../git-process';

class StubGitRunner implements GitRunner {
	readonly calls: { args: readonly string[]; options?: GitRunOptions }[] = [];

	constructor(
		private readonly respond: (
			args: readonly string[],
			options?: GitRunOptions,
		) => string | Promise<string>,
	) {}

	async run(
		_rootPath: string,
		args: readonly string[],
		options?: GitRunOptions,
	): Promise<string> {
		this.calls.push({ args, options });
		return this.respond(args, options);
	}
}

test('loads deleted paths without including detected renames', async () => {
	const runner = new StubGitRunner(args => {
		assert.deepEqual(args, [
			'diff', 'HEAD', '--name-only', '--diff-filter=D', '--find-renames', '-z', '--',
		]);
		return 'old/path.ts\0gone.ts\0';
	});

	assert.deepEqual(await loadDeletedPaths(runner, '/repo'), [
		'old/path.ts',
		'gone.ts',
	]);
});

test('treats deleted paths as optional outside a Git worktree', async () => {
	const runner = new StubGitRunner(() => {
		throw new Error('not a Git repository');
	});
	assert.deepEqual(await loadDeletedPaths(runner, '/repo'), []);
});

test('resolves HEAD as the default diff base', async () => {
	const runner = new StubGitRunner(args => {
		assert.deepEqual(args, ['merge-base', 'HEAD', 'HEAD']);
		return 'abc123\n';
	});

	assert.deepEqual(await resolveDiffBase(runner, '/repo'), {
		ref: 'HEAD',
		mergeBase: 'abc123',
	});
});

test('uses an explicitly selected diff base', async () => {
	const runner = new StubGitRunner(args => {
		assert.deepEqual(args, ['merge-base', 'HEAD', 'release']);
		return 'def456\n';
	});

	assert.deepEqual(await resolveDiffBase(runner, '/repo', 'release'), {
		ref: 'release',
		mergeBase: 'def456',
	});
	assert.equal(runner.calls.length, 1);
});

test('groups diff refs and finds base and upstream branches', async () => {
	const runner = new StubGitRunner(args => {
		switch (args[0]) {
			case 'for-each-ref':
				return [
					'refs/remotes/origin/main',
					'refs/heads/release',
					'refs/heads/main',
					'refs/heads/feature',
					'refs/remotes/origin/HEAD',
					'refs/tags/v1.0',
					'refs/heads/feature',
				].join('\n');
			case 'symbolic-ref':
				return 'feature\n';
			case 'reflog':
				return [
					'checkout: moving from release to feature',
					'checkout: moving from main to feature',
				].join('\n');
			case 'rev-parse':
				return 'origin/main\n';
			default:
				throw new Error(`Unexpected Git command: ${args.join(' ')}`);
		}
	});

	assert.deepEqual(await listDiffBaseRefs(runner, '/repo'), {
		baseBranch: 'main',
		upstreamBranch: 'origin/main',
		localBranches: ['feature', 'main', 'release'],
		remoteBranches: ['origin/main'],
		tags: ['v1.0'],
	});
});

test('omits unavailable diff base hints', async () => {
	const runner = new StubGitRunner(args => {
		if (args[0] === 'for-each-ref') {
			return 'refs/heads/main\n';
		}
		throw new Error('Ref hint is unavailable');
	});

	assert.deepEqual(await listDiffBaseRefs(runner, '/repo'), {
		baseBranch: undefined,
		upstreamBranch: undefined,
		localBranches: ['main'],
		remoteBranches: [],
		tags: [],
	});
});

test('lists recent commits with display metadata', async () => {
	const runner = new StubGitRunner(args => {
		assert.deepEqual(args, [
			'log',
			'HEAD',
			'--first-parent',
			'--max-count=25',
			'--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1e',
		]);
		return [
			'abcdef123456\x1fabcdef1\x1fAdd commit picker\x1fAda Lovelace\x1f2 hours ago\x1e',
			'\n123456abcdef\x1f123456a\x1fFix rename handling\x1fGrace Hopper\x1fyesterday\x1e',
		].join('');
	});

	assert.deepEqual(await listRecentCommits(runner, '/repo', 25), [
		{
			ref: 'abcdef123456',
			shortSha: 'abcdef1',
			message: 'Add commit picker',
			author: 'Ada Lovelace',
			relativeDate: '2 hours ago',
		},
		{
			ref: '123456abcdef',
			shortSha: '123456a',
			message: 'Fix rename handling',
			author: 'Grace Hopper',
			relativeDate: 'yesterday',
		},
	]);
});

test('loads a commit patch against its first parent', async () => {
	const runner = new StubGitRunner(args => {
		assert.deepEqual(args, [
			'-c',
			'core.quotePath=false',
			'diff-tree',
			'--root',
			'--no-commit-id',
			'--diff-merges=first-parent',
			'-r',
			'-p',
			'--find-renames',
			'--unified=0',
			'abcdef123456',
			'--',
		]);
		return `diff --git a/file.ts b/file.ts
index 1111111..2222222 100644
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-old
+new
`;
	});

	assert.deepEqual(await loadCommitDiff(runner, '/repo', 'abcdef123456'), [{
		relativePath: 'file.ts',
		previousPath: undefined,
		status: 'modified',
		lines: [
			{ kind: 'deleted', line: 0, text: 'old', hunk: 0 },
			{ kind: 'added', line: 0, text: 'new', hunk: 0 },
		],
	}]);
});

test('adapts additions, deletions, and current line numbers', () => {
	const files = adaptParsedDiff(`diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -2,2 +2,2 @@
-old two
-old three
+new two
+new three
`);

	assert.deepEqual(files, [{
		relativePath: 'src/a.ts',
		previousPath: undefined,
		status: 'modified',
		lines: [
			{ kind: 'deleted', line: 1, text: 'old two', hunk: 0 },
			{ kind: 'deleted', line: 2, text: 'old three', hunk: 0 },
			{ kind: 'added', line: 1, text: 'new two', hunk: 0 },
			{ kind: 'added', line: 2, text: 'new three', hunk: 0 },
		],
	}]);
});

test('adapts a rename and a deleted file', () => {
	const files = adaptParsedDiff(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 1111111..0000000
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`);

	assert.deepEqual(files.map(file => ({
		path: file.relativePath,
		previousPath: file.previousPath,
		status: file.status,
	})), [
		{ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' },
		{ path: 'gone.ts', previousPath: undefined, status: 'deleted' },
	]);
});

test('loads untracked files as full additions through Git diff output', async () => {
	const runner = new StubGitRunner(args => {
		if (args.includes('ls-files')) {
			return 'new.ts\0';
		}
		if (args.includes('--no-index')) {
			return `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`;
		}
		return '';
	});

	assert.deepEqual(await loadWorkingTreeDiff(runner, '/repo', 'base'), [{
		relativePath: 'new.ts',
		previousPath: undefined,
		status: 'added',
		lines: [
			{ kind: 'added', line: 0, text: 'one', hunk: 0 },
			{ kind: 'added', line: 1, text: 'two', hunk: 0 },
		],
	}]);
	assert.deepEqual(runner.calls.at(-1)?.options, { acceptedExitCodes: [1] });
});
