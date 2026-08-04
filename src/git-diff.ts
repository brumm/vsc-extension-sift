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
	const ref = requestedRef ?? 'HEAD';
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
	const refs = [...new Set(output.split('\n').map(value => value.trim()).filter(
		value => value && !value.endsWith('/HEAD'),
	))].sort((left, right) => left.localeCompare(right));
	return ['HEAD', ...refs];
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
