import type { FileFinder } from '@ff-labs/fff-node' with {
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

export class FffProjectSearch {
	private readonly finders = new Map<string, FinderEntry>();
	private readonly finderPromises = new Map<string, Promise<FileFinder>>();

	constructor(private readonly onDidChange: (rootUri: string) => void) {}

	async search(input: {
		rootUri: string;
		rootPath: string;
		filter: FilterQuery;
		resolveUri(relativePath: string): string;
	}): Promise<ProjectSearchPage> {
		const finder = await this.getFinder(input.rootUri, input.rootPath);
		const grep = compileFffQuery(input.filter);
		const result = finder.grep(grep.query, {
			mode: grep.mode,
			smartCase: grep.smartCase,
			pageSize: 1_000,
			maxMatchesPerFile: 200,
			timeBudgetMs: 250,
		});
		if (!result.ok) {
			throw new Error(result.error);
		}
		return {
			matches: result.value.items.map(match => ({
				uri: input.resolveUri(match.relativePath),
				relativePath: match.relativePath,
				line: Math.max(0, match.lineNumber - 1),
				text: match.lineContent,
				matches: byteRangesToFilterMatches(
					match.lineContent,
					match.matchRanges,
				),
			})),
			hasMore: Boolean(result.value.nextCursor),
		};
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
		const watched = finder.watch(() => this.onDidChange(rootUri));
		this.finders.set(rootUri, {
			finder,
			unsubscribe: watched.ok ? watched.value : undefined,
		});
		return finder;
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

export function compileFffQuery(filter: FilterQuery): {
	query: string;
	mode: 'plain' | 'regex';
	smartCase: boolean;
} {
	if (!filter.wholeWord && !filter.useRegex) {
		return {
			query: filter.matchCase ? filter.text : filter.text.toLocaleLowerCase(),
			mode: 'plain',
			smartCase: !filter.matchCase,
		};
	}

	let pattern = filter.useRegex ? filter.text : escapeRegExp(filter.text);
	if (filter.wholeWord) {
		pattern = `\\b(?:${pattern})\\b`;
	}
	if (!filter.matchCase) {
		pattern = `(?i:${pattern})`;
	}
	return { query: pattern, mode: 'regex', smartCase: false };
}
