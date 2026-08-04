import assert from 'node:assert/strict';
import test from 'node:test';
import {
	adaptParsedDiff,
	loadWorkingTreeDiff,
	resolveDiffBase,
	resolveRemoteDefaultBranch,
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

test('resolves the remote default and its merge base', async () => {
	const runner = new StubGitRunner(args => {
		if (args[0] === 'for-each-ref') {
			return 'upstream/HEAD upstream/trunk\norigin/HEAD origin/main\n';
		}
		assert.deepEqual(args, ['merge-base', 'HEAD', 'origin/main']);
		return 'abc123\n';
	});

	assert.deepEqual(await resolveDiffBase(runner, '/repo'), {
		ref: 'origin/main',
		mergeBase: 'abc123',
	});
});

test('uses an explicit base without resolving the remote default', async () => {
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

test('falls back to the conventional origin main ref', async () => {
	const runner = new StubGitRunner(args => {
		if (args[0] === 'for-each-ref') {
			return '';
		}
		if (args.at(-1) === 'origin/main') {
			return 'abc123\n';
		}
		throw new Error('missing');
	});
	assert.equal(await resolveRemoteDefaultBranch(runner, '/repo'), 'origin/main');
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
