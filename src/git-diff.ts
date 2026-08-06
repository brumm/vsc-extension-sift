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

export interface DiffBaseRefs {
	baseBranch?: string;
	upstreamBranch?: string;
	localBranches: string[];
	remoteBranches: string[];
	tags: string[];
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
): Promise<DiffBaseRefs> {
	const output = await runner.run(rootPath, [
		'for-each-ref',
		'--format=%(refname)',
		'refs/heads',
		'refs/remotes',
		'refs/tags',
	]);
	const fullRefs = output.split('\n').map(value => value.trim()).filter(Boolean);
	const localBranches = sortedUnique(fullRefs.flatMap(ref =>
		ref.startsWith('refs/heads/') ? [ref.slice('refs/heads/'.length)] : [],
	));
	const remoteBranches = sortedUnique(fullRefs.flatMap(ref =>
		ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')
			? [ref.slice('refs/remotes/'.length)]
			: [],
	));
	const tags = sortedUnique(fullRefs.flatMap(ref =>
		ref.startsWith('refs/tags/') ? [ref.slice('refs/tags/'.length)] : [],
	));
	const branchRefs = new Set([...localBranches, ...remoteBranches]);
	const [baseBranch, upstreamBranch] = await Promise.all([
		inferBaseBranch(runner, rootPath, branchRefs),
		readOptionalRef(runner, rootPath, [
			'rev-parse',
			'--abbrev-ref',
			'--symbolic-full-name',
			'@{upstream}',
		]),
	]);

	return {
		baseBranch,
		upstreamBranch: upstreamBranch && remoteBranches.includes(upstreamBranch)
			? upstreamBranch
			: undefined,
		localBranches,
		remoteBranches,
		tags,
	};
}

async function inferBaseBranch(
	runner: GitRunner,
	rootPath: string,
	branchRefs: ReadonlySet<string>,
): Promise<string | undefined> {
	const currentBranch = await readOptionalRef(runner, rootPath, [
		'symbolic-ref',
		'--quiet',
		'--short',
		'HEAD',
	]);
	if (!currentBranch) {
		return undefined;
	}
	try {
		const reflog = await runner.run(rootPath, [
			'reflog',
			'show',
			'--format=%gs',
			'HEAD',
		]);
		const candidates = reflog.split('\n').flatMap(message => {
			const match = /^checkout: moving from (.+) to (.+)$/u.exec(message.trim());
			return match?.[2] === currentBranch ? [normalizeBranchRef(match[1])] : [];
		});
		return candidates.reverse().find(candidate =>
			candidate !== currentBranch && branchRefs.has(candidate),
		);
	} catch {
		return undefined;
	}
}

async function readOptionalRef(
	runner: GitRunner,
	rootPath: string,
	args: readonly string[],
): Promise<string | undefined> {
	try {
		return (await runner.run(rootPath, args)).trim() || undefined;
	} catch {
		return undefined;
	}
}

function normalizeBranchRef(ref: string): string {
	return ref.replace(/^refs\/(?:heads|remotes)\//u, '');
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
