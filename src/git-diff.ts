import parseDiff = require('parse-diff');
import { GitRunner } from './git-process';

export interface GitDiffLine {
	kind: 'added' | 'deleted';
	line: number;
	text: string;
	hunk: number;
}

export interface GitDiffFile {
	relativePath: string;
	previousPath?: string;
	status: 'added' | 'modified' | 'deleted' | 'renamed';
	lines: GitDiffLine[];
}

export interface ResolvedDiffBase {
	ref: string;
	mergeBase: string;
}

export async function resolveDiffBase(
	runner: GitRunner,
	rootPath: string,
	requestedRef?: string,
): Promise<ResolvedDiffBase> {
	const ref = requestedRef ?? await resolveRemoteDefaultBranch(runner, rootPath);
	const mergeBase = (await runner.run(rootPath, [
		'merge-base',
		'HEAD',
		ref,
	])).trim();
	if (!mergeBase) {
		throw new Error(`Git could not find a merge base with ${ref}.`);
	}
	return { ref, mergeBase };
}

export async function resolveRemoteDefaultBranch(
	runner: GitRunner,
	rootPath: string,
): Promise<string> {
	const symbolicRefs = (await runner.run(rootPath, [
		'for-each-ref',
		'--format=%(refname:short) %(symref:short)',
		'refs/remotes',
	])).trim().split('\n').filter(Boolean);
	const defaults = symbolicRefs.flatMap(line => {
		const [name, target] = line.split(' ');
		return name?.endsWith('/HEAD') && target ? [{ name, target }] : [];
	});
	const preferred = defaults.find(item => item.name === 'origin/HEAD') ?? defaults[0];
	if (preferred) {
		return preferred.target;
	}

	const remotes = [...new Set(symbolicRefs.flatMap(line => {
		const name = line.split(' ')[0];
		const separator = name?.indexOf('/');
		return separator && separator > 0 ? [name.slice(0, separator)] : [];
	}))];
	const conventionalRefs = [
		'origin/main',
		'origin/master',
		...remotes.flatMap(remote => [`${remote}/main`, `${remote}/master`]),
	];
	for (const candidate of new Set(conventionalRefs)) {
		try {
			await runner.run(rootPath, ['rev-parse', '--verify', '--quiet', candidate]);
			return candidate;
		} catch {
			// Try the next conventional remote branch.
		}
	}
	throw new Error(
		'Git remote default branch is unavailable. Use “Sift: Diff Against…” to choose a base.',
	);
}

export async function listDiffBaseRefs(
	runner: GitRunner,
	rootPath: string,
): Promise<string[]> {
	const output = await runner.run(rootPath, [
		'for-each-ref',
		'--format=%(refname:short)',
		'refs/heads',
		'refs/remotes',
		'refs/tags',
	]);
	return [...new Set(output.split('\n').map(value => value.trim()).filter(
		value => value && !value.endsWith('/HEAD'),
	))].sort((left, right) => left.localeCompare(right));
}

export async function loadWorkingTreeDiff(
	runner: GitRunner,
	rootPath: string,
	mergeBase: string,
): Promise<GitDiffFile[]> {
	const tracked = await runner.run(rootPath, [
		'-c',
		'core.quotePath=false',
		'diff',
		'--no-ext-diff',
		'--no-color',
		'--find-renames',
		'--unified=0',
		mergeBase,
		'--',
	]);
	const untrackedPaths = (await runner.run(rootPath, [
		'ls-files',
		'--others',
		'--exclude-standard',
		'-z',
	])).split('\0').filter(Boolean);
	const untrackedDiffs = await Promise.all(untrackedPaths.map(relativePath =>
		runner.run(rootPath, [
			'-c',
			'core.quotePath=false',
			'diff',
			'--no-index',
			'--no-ext-diff',
			'--no-color',
			'--unified=0',
			'--',
			'/dev/null',
			relativePath,
		], { acceptedExitCodes: [1] }),
	));
	return adaptParsedDiff(`${tracked}${untrackedDiffs.join('')}`);
}

export function adaptParsedDiff(unifiedDiff: string): GitDiffFile[] {
	return parseDiff(unifiedDiff).flatMap(file => {
		const from = normalizeDiffPath(file.from);
		const to = normalizeDiffPath(file.to);
		const relativePath = file.deleted ? from : to;
		if (!relativePath) {
			return [];
		}
		const renamed = Boolean(from && to && from !== to && !file.new && !file.deleted);
		return [{
			relativePath,
			previousPath: renamed ? from : undefined,
			status: file.new
				? 'added' as const
				: file.deleted
					? 'deleted' as const
					: renamed
						? 'renamed' as const
						: 'modified' as const,
			lines: file.chunks.flatMap((chunk, hunk) =>
				chunk.changes.flatMap<GitDiffLine>(change => {
					if (change.type === 'add') {
						return [{ kind: 'added' as const, line: change.ln - 1, text: change.content.slice(1), hunk }];
					}
					if (change.type === 'del') {
						return [{ kind: 'deleted' as const, line: change.ln - 1, text: change.content.slice(1), hunk }];
					}
					return [];
				})),
		}];
	});
}

function normalizeDiffPath(value?: string): string | undefined {
	if (!value || value === '/dev/null') {
		return undefined;
	}
	return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}
