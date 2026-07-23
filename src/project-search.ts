import type { FileFinder, GrepMatch } from '@ff-labs/fff-node' with {
	'resolution-mode': 'import',
};
import {
	escapeRegExp,
	FilterQuery,
	ProjectSearchMatch,
} from './projection-document';

interface FinderEntry {
	finder: FileFinder;
	unsubscribe?: () => void;
}

export interface ProjectSearchPage {
	matches: ProjectSearchMatch[];
	hasMore: boolean;
}

export interface PathSearchMatch {
	uri: string;
	relativePath: string;
}

export class FffProjectSearch {
	private readonly finders = new Map<string, FinderEntry>();
	private readonly finderPromises = new Map<string, Promise<FileFinder>>();

	constructor(private readonly onDidChange: (rootUri: string) => void) {}

	async search(input: {
		rootUri: string;
		rootPath: string;
		filter: FilterQuery;
		excludeGlobs?: readonly string[];
		resolveUri(relativePath: string): string;
	}): Promise<ProjectSearchPage> {
		const finder = await this.getFinder(input.rootUri, input.rootPath);
		const grep = compileFffQuery(
			input.filter,
			filesExcludeConstraints(input.excludeGlobs ?? []),
		);
		const gitFiles = this.filesMatchingGitConstraints(
			finder,
			grep.gitConstraints,
		);
		const result = finder.grep(grep.query, {
			mode: grep.mode,
			smartCase: grep.smartCase,
			pageSize: 1_000,
			maxMatchesPerFile: 200,
			timeBudgetMs: 250,
			beforeContext: input.filter.contextLines,
			afterContext: input.filter.contextLines,
		});
		if (!result.ok) {
			throw new Error(result.error);
		}
		return {
			matches: projectSearchMatchesFromGrep(
				gitFiles
					? result.value.items.filter(item =>
						gitFiles.has(item.relativePath),
					)
					: result.value.items,
				input.resolveUri,
			),
			hasMore: Boolean(result.value.nextCursor),
		};
	}

	async searchPaths(input: {
		rootUri: string;
		rootPath: string;
		query: string;
		excludeGlobs?: readonly string[];
		resolveUri(relativePath: string): string;
	}): Promise<PathSearchMatch[]> {
		const finder = await this.getFinder(input.rootUri, input.rootPath);
		return allPathSearchMatches(
			finder,
			joinFffQuery(
				filesExcludeConstraints(input.excludeGlobs ?? []),
				input.query,
			),
			input.resolveUri,
		);
	}

	private filesMatchingGitConstraints(
		finder: FileFinder,
		constraints: readonly string[],
	): Set<string> | undefined {
		if (constraints.length === 0) {
			return undefined;
		}
		const refreshed = finder.refreshGitStatus();
		if (!refreshed.ok) {
			throw new Error(refreshed.error);
		}

		const files = new Set<string>();
		const pageSize = 1_000;
		for (let pageIndex = 0; ; pageIndex += 1) {
			const result = finder.fileSearch(constraints.join(' '), {
				pageIndex,
				pageSize,
			});
			if (!result.ok) {
				throw new Error(result.error);
			}
			for (const item of result.value.items) {
				files.add(item.relativePath);
			}
			if ((pageIndex + 1) * pageSize >= result.value.totalMatched) {
				break;
			}
		}
		return files;
	}

	dispose(): void {
		for (const entry of this.finders.values()) {
			entry.unsubscribe?.();
			entry.finder.destroy();
		}
		this.finders.clear();
		this.finderPromises.clear();
	}

	private async getFinder(rootUri: string, rootPath: string): Promise<FileFinder> {
		const existing = this.finders.get(rootUri);
		if (existing) {
			return existing.finder;
		}
		const pending = this.finderPromises.get(rootUri);
		if (pending) {
			return pending;
		}

		const promise = this.createFinder(rootUri, rootPath);
		this.finderPromises.set(rootUri, promise);
		try {
			return await promise;
		} catch (error) {
			this.finderPromises.delete(rootUri);
			throw error;
		}
	}

	private async createFinder(rootUri: string, rootPath: string): Promise<FileFinder> {
		const { FileFinder } = await import('@ff-labs/fff-node');
		const created = FileFinder.create({ basePath: rootPath });
		if (!created.ok) {
			throw new Error(created.error);
		}
		const finder = created.value;
		const indexed = await finder.waitForIndexReady(10_000);
		if (!indexed.ok) {
			finder.destroy();
			throw new Error(indexed.error);
		}
		const watched = finder.watch(() => {
			finder.refreshGitStatus();
			this.onDidChange(rootUri);
		});
		this.finders.set(rootUri, {
			finder,
			unsubscribe: watched.ok ? watched.value : undefined,
		});
		return finder;
	}
}

export function allPathSearchMatches(
	finder: Pick<FileFinder, 'fileSearch'>,
	query: string,
	resolveUri: (relativePath: string) => string,
): PathSearchMatch[] {
	const matches: PathSearchMatch[] = [];
	const pageSize = 1_000;
	for (let pageIndex = 0; ; pageIndex += 1) {
		const result = finder.fileSearch(query, { pageIndex, pageSize });
		if (!result.ok) {
			throw new Error(result.error);
		}
		matches.push(...result.value.items.map(item => ({
			uri: resolveUri(item.relativePath),
			relativePath: item.relativePath.replaceAll('\\', '/'),
		})));
		if (
			matches.length >= result.value.totalMatched ||
			result.value.items.length === 0
		) {
			return matches;
		}
	}
}

export function byteRangesToFilterMatches(
	line: string,
	ranges: readonly (readonly [number, number])[],
): { start: number; end: number }[] {
	const bytes = Buffer.from(line, 'utf8');
	const utf16Offset = (byteOffset: number): number =>
		bytes.subarray(0, Math.min(Math.max(0, byteOffset), bytes.length))
			.toString('utf8').length;
	return ranges.map(([start, end]) => ({
		start: utf16Offset(start),
		end: utf16Offset(end),
	}));
}

type ContextualGrepMatch = Pick<
	GrepMatch,
	| 'relativePath'
	| 'lineNumber'
	| 'lineContent'
	| 'matchRanges'
	| 'contextBefore'
	| 'contextAfter'
>;

export function projectSearchMatchesFromGrep(
	matches: readonly ContextualGrepMatch[],
	resolveUri: (relativePath: string) => string,
): ProjectSearchMatch[] {
	const files = new Map<string, Map<number, ProjectSearchMatch>>();
	const addContextLine = (
		match: ContextualGrepMatch,
		line: number,
		text: string,
	): void => {
		const lines = files.get(match.relativePath) ?? new Map();
		if (!lines.has(line)) {
			lines.set(line, {
				uri: resolveUri(match.relativePath),
				relativePath: match.relativePath,
				line,
				text,
				matches: [],
			});
		}
		files.set(match.relativePath, lines);
	};

	for (const match of matches) {
		const matchLine = Math.max(0, match.lineNumber - 1);
		const contextBefore = match.contextBefore ?? [];
		for (let index = 0; index < contextBefore.length; index += 1) {
			addContextLine(
				match,
				matchLine - contextBefore.length + index,
				contextBefore[index],
			);
		}

		const lines = files.get(match.relativePath) ?? new Map();
		lines.set(matchLine, {
			uri: resolveUri(match.relativePath),
			relativePath: match.relativePath,
			line: matchLine,
			text: match.lineContent,
			matches: byteRangesToFilterMatches(
				match.lineContent,
				match.matchRanges,
			),
		});
		files.set(match.relativePath, lines);

		const contextAfter = match.contextAfter ?? [];
		for (let index = 0; index < contextAfter.length; index += 1) {
			addContextLine(
				match,
				matchLine + index + 1,
				contextAfter[index],
			);
		}
	}

	return [...files.values()].flatMap(lines =>
		[...lines.values()].sort((left, right) => left.line - right.line),
	);
}

export function compileFffQuery(
	filter: FilterQuery,
	implicitConstraints: readonly string[] = [],
): {
	query: string;
	mode: 'plain' | 'regex';
	smartCase: boolean;
	gitConstraints: string[];
} {
	const split = splitFffQuery(filter.text);
	const gitConstraints = split.constraints.filter(isGitConstraint);
	const constraints = split.constraints.filter(
		constraint => !isGitConstraint(constraint),
	);
	const content = filter.useRegex
		? split.content
		: split.content
			.split(/\s+/)
			.map(unescapeConstraintToken)
			.join(' ');
	if (!filter.wholeWord && !filter.useRegex) {
		const compiledContent = filter.matchCase
			? content
			: content.toLocaleLowerCase();
		if (needsFffParserProtection(content)) {
			const escaped = escapeRegExp(compiledContent);
			const pattern = filter.matchCase
				? `(?:${escaped})`
				: `(?i:${escaped})`;
			return {
				query: joinFffQuery(
					[...implicitConstraints, ...constraints],
					encodePatternForFff(pattern),
				),
				mode: 'regex',
				smartCase: false,
				gitConstraints,
			};
		}
		return {
			query: joinFffQuery(
				[...implicitConstraints, ...constraints],
				compiledContent,
			),
			mode: 'plain',
			smartCase: !filter.matchCase,
			gitConstraints,
		};
	}

	let pattern = filter.useRegex ? content : escapeRegExp(content);
	if (filter.wholeWord) {
		pattern = `\\b(?:${pattern})\\b`;
	}
	if (!filter.matchCase) {
		pattern = `(?i:${pattern})`;
	} else {
		pattern = `(?:${pattern})`;
	}
	return {
		query: joinFffQuery(
			[...implicitConstraints, ...constraints],
			encodePatternForFff(pattern),
		),
		mode: 'regex',
		smartCase: false,
		gitConstraints,
	};
}

export function filesExcludeConstraints(
	patterns: readonly string[],
): string[] {
	return patterns.flatMap(pattern => {
		let normalized = pattern.trim().replaceAll('\\', '/');
		if (!normalized) {
			return [];
		}
		while (normalized.startsWith('./')) {
			normalized = normalized.slice(2);
		}
		while (normalized.endsWith('/**')) {
			normalized = normalized.slice(0, -3).replace(/\/+$/u, '');
		}
		if (!normalized) {
			return [];
		}
		if (normalized.startsWith('**/')) {
			normalized = normalized.slice(3);
		} else if (!normalized.startsWith('/')) {
			normalized = `/${normalized}`;
		}
		return [`!${encodePatternWhitespace(normalized)}`];
	});
}

function splitFffQuery(text: string): {
	constraints: string[];
	content: string;
} {
	const tokens = text.trim().split(/\s+/);
	const constraints: string[] = [];
	while (tokens[0] && isFffConstraint(tokens[0])) {
		constraints.push(tokens.shift()!);
	}
	return {
		constraints,
		content: tokens.join(' '),
	};
}

function isFffConstraint(token: string): boolean {
	if (token.startsWith('\\')) {
		return false;
	}
	const candidate = token.startsWith('!') ? token.slice(1) : token;
	if (!candidate || candidate.includes('://')) {
		return false;
	}
	if (isGitConstraint(token)) {
		return true;
	}
	if (
		(candidate.startsWith('/') || candidate.endsWith('/')) &&
		candidate.replace(/^\/+|\/+$/g, '')
	) {
		return true;
	}
	if (candidate.startsWith('*.')) {
		return !/[?*[{]/u.test(candidate.slice(2));
	}
	return candidate.includes('/') && /[?*[{]/u.test(candidate);
}

function isGitConstraint(token: string): boolean {
	const candidate = token.startsWith('!') ? token.slice(1) : token;
	return /^git:(modified|staged|deleted|renamed|untracked|ignored)$/iu.test(
		candidate,
	);
}

function needsFffParserProtection(content: string): boolean {
	return content.split(/\s+/).some(token => {
		if (!token || token.startsWith('\\')) {
			return false;
		}
		return (
			token.startsWith('!') ||
			token.startsWith('/') ||
			token.startsWith('*.') ||
			token.startsWith('git:') ||
			token.startsWith('type:') ||
			token.endsWith('/') ||
			(token.includes('/') && /[?*[{]/u.test(token))
			|| hasBraceExpansion(token)
		);
	});
}

function hasBraceExpansion(token: string): boolean {
	const open = token.indexOf('{');
	const close = token.lastIndexOf('}');
	if (open < 0 || close <= open) {
		return false;
	}
	const inner = token.slice(open + 1, close);
	return inner.includes(',') && /[a-z]/iu.test(inner);
}

function unescapeConstraintToken(token: string): string {
	return token.startsWith('\\') && isFffConstraint(token.slice(1))
		? token.slice(1)
		: token;
}

function encodePatternWhitespace(pattern: string): string {
	return pattern.replaceAll(' ', '\\x20');
}

function encodePatternForFff(pattern: string): string {
	const withoutPathSeparators = encodePatternWhitespace(pattern).replace(
		/\\*\//gu,
		sequence => {
			const backslashCount = sequence.length - 1;
			const preservedBackslashes = backslashCount - (backslashCount % 2);
			return '\\'.repeat(preservedBackslashes) + '\\x2f';
		},
	);
	return withoutPathSeparators.replace(/\\+[{}]/gu, sequence => {
		const brace = sequence.at(-1)!;
		const backslashCount = sequence.length - 1;
		if (backslashCount % 2 === 0) {
			return sequence;
		}
		const encodedBrace = brace === '{' ? '\\x7b' : '\\x7d';
		return '\\'.repeat(backslashCount - 1) + encodedBrace;
	});
}

function joinFffQuery(constraints: readonly string[], content: string): string {
	return [...constraints, content].filter(Boolean).join(' ');
}
