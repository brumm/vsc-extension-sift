export interface FilterQuery {
	text: string;
	matchCase: boolean;
	wholeWord: boolean;
	useRegex: boolean;
	contextLines: number;
}

export const maximumContextLines = 5;

export function normalizeContextLines(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(maximumContextLines, Math.max(0, Math.trunc(value)))
		: 0;
}

export interface SourcePosition {
	line: number;
	character: number;
}

export interface SourceLocation extends SourcePosition {
	uri: string;
}

export interface SourceLine {
	uri: string;
	line: number;
}

export interface FilterMatch {
	start: number;
	end: number;
}

export type ProjectionRow =
	| {
		kind: 'mapped';
		source: SourceLine;
		baseline: string;
		role?: 'path';
		gitStatus?: string;
		matches?: readonly FilterMatch[];
		change?: 'added';
		hunkStart?: boolean;
	}
	| {
		kind: 'annotation';
		role: 'header' | 'spacer' | 'message' | 'terminal' | 'deletion' | 'deleted-path';
		label?: string;
		gitStatus?: string;
		sourceUri?: string;
		sourceLine?: number;
		changeStatus?: DiffProjectionFile['status'];
		hunkStart?: boolean;
	};

export interface ProjectionSourceEdit {
	uri: string;
	line: number;
	before: string;
	after: string;
}

export type ProjectionSavePlan =
	| { ok: true; edits: ProjectionSourceEdit[] }
	| { ok: false; message: string };

export interface FileProjectionInput {
	sourceUri: string;
	sourceText: string;
	filter: FilterQuery;
}

export interface ProjectSearchMatch {
	uri: string;
	relativePath: string;
	line: number;
	text: string;
	matches: readonly FilterMatch[];
}

export interface PathProjectionInput {
	uri?: string;
	relativePath: string;
	gitStatus?: string;
}

export interface DiffProjectionFile {
	uri?: string;
	relativePath: string;
	previousPath?: string;
	status: 'added' | 'modified' | 'deleted' | 'renamed';
	lines: readonly {
		kind: 'added' | 'deleted';
		line: number;
		text: string;
		hunk?: number;
	}[];
}

export interface ProjectionPathRename {
	sourceUri: string;
	before: string;
	after: string;
}

export interface ProjectionUriRename {
	before: string;
	after: string;
}

export type ProjectionPathSavePlan =
	| { ok: true; renames: ProjectionPathRename[] }
	| { ok: false; message: string };

export class ProjectionDocument {
	private constructor(
		readonly content: string,
		readonly rows: readonly ProjectionRow[],
		readonly sourceLineCount: number,
	) {}

	static forFile(input: FileProjectionInput): ProjectionDocument {
		const sourceLines = input.sourceText.split(/\r?\n/);
		const matcher = makeLineMatcher(input.filter);
		const matchingLines = sourceLines.map(matcher);
		const contextLines = normalizeContextLines(input.filter.contextLines);
		const rows: ProjectionRow[] = [];
		const content: string[] = [];

		for (let line = 0; line < sourceLines.length; line += 1) {
			const text = sourceLines[line];
			const contextStart = Math.max(0, line - contextLines);
			const contextEnd = Math.min(
				matchingLines.length,
				line + contextLines + 1,
			);
			if (matchingLines.slice(contextStart, contextEnd).some(Boolean)) {
				content.push(text);
				rows.push({
					kind: 'mapped',
					source: { uri: input.sourceUri, line },
					baseline: text,
				});
			}
		}

		return new ProjectionDocument(
			content.join('\n'),
			rows.length > 0
				? rows
				: [{ kind: 'annotation', role: 'message' }],
			sourceLines.length,
		);
	}

	static forProject(matches: readonly ProjectSearchMatch[]): ProjectionDocument {
		const groups = new Map<string, ProjectSearchMatch[]>();
		for (const match of matches) {
			const group = groups.get(match.uri) ?? [];
			group.push(match);
			groups.set(match.uri, group);
		}

		const content: string[] = [];
		const rows: ProjectionRow[] = [];
		let isFirstGroup = true;
		for (const group of groups.values()) {
			if (!isFirstGroup) {
				content.push('');
				rows.push({ kind: 'annotation', role: 'spacer' });
			}
			isFirstGroup = false;

			const first = group[0];
			content.push('');
			rows.push({
				kind: 'annotation',
				role: 'header',
				label: first.relativePath,
				sourceUri: first.uri,
			});
			for (const match of group) {
				content.push(match.text);
				rows.push({
					kind: 'mapped',
					source: { uri: match.uri, line: match.line },
					baseline: match.text,
					matches: match.matches,
				});
			}
		}

		return new ProjectionDocument(
			content.join('\n'),
			rows.length > 0
				? rows
				: [{ kind: 'annotation', role: 'message' }],
			Math.max(
				1,
				...matches.map(match => match.line + 1),
			),
		);
	}

	static forDiff(
		files: readonly DiffProjectionFile[],
		filter: FilterQuery,
	): ProjectionDocument {
		const hasContentFilter = filter.text.length > 0;
		const findMatches = makeFilterMatchFinder(filter);
		const content: string[] = [];
		const rows: ProjectionRow[] = [];
		let maximumLine = 0;

		for (const file of files) {
			const visibleLines = file.lines.flatMap(line => {
				if (line.kind === 'deleted') {
					return hasContentFilter ? [] : [line];
				}
				return !hasContentFilter || findMatches(line.text).length > 0 ? [line] : [];
			});
			if (visibleLines.length === 0 && hasContentFilter) {
				continue;
			}
			if (rows.length > 0) {
				content.push('');
				rows.push({ kind: 'annotation', role: 'spacer' });
			}
			const status = file.status === 'renamed' && file.previousPath
				? `${file.previousPath} → ${file.relativePath}`
				: `${file.relativePath} (${file.status})`;
			content.push('');
			rows.push({
				kind: 'annotation',
				role: 'header',
				label: status,
				sourceUri: file.uri,
				changeStatus: file.status,
			});
			let visibleHunk: number | undefined;
			for (const line of visibleLines) {
				const hunk = line.hunk ?? 0;
				const hunkStart = visibleHunk !== undefined && hunk !== visibleHunk;
				visibleHunk = hunk;
				maximumLine = Math.max(maximumLine, line.line);
				if (line.kind === 'deleted') {
					content.push(line.text);
					rows.push({
						kind: 'annotation',
						role: 'deletion',
						label: 'Deleted line',
						sourceLine: line.line,
						hunkStart,
					});
					continue;
				}
				if (!file.uri) {
					continue;
				}
				content.push(line.text);
				rows.push({
					kind: 'mapped',
					source: { uri: file.uri, line: line.line },
					baseline: line.text,
					matches: hasContentFilter ? findMatches(line.text) : [],
					change: 'added',
					hunkStart,
				});
			}
		}

		return new ProjectionDocument(
			content.join('\n'),
			rows.length > 0
				? rows
				: [{ kind: 'annotation', role: 'message' }],
			maximumLine + 1,
		);
	}

	static forPaths(paths: readonly PathProjectionInput[]): ProjectionDocument {
		if (paths.length === 0) {
			return ProjectionDocument.message('');
		}
		return new ProjectionDocument(
			paths.map(path => path.relativePath).join('\n'),
			paths.map((path): ProjectionRow => path.uri
				? {
					kind: 'mapped',
					source: { uri: path.uri, line: 0 },
					baseline: path.relativePath,
					role: 'path',
					gitStatus: path.gitStatus,
				}
				: {
					kind: 'annotation',
					role: 'deleted-path',
					label: path.relativePath,
					gitStatus: path.gitStatus,
				}),
			1,
		);
	}

	static forPathContent(
		content: string,
		resolveUri: (relativePath: string) => string,
		deletedPaths: ReadonlySet<string> = new Set(),
	): ProjectionDocument {
		const relativePaths = content.split(/\r?\n/);
		if (relativePaths.length > 1 && relativePaths.at(-1) === '') {
			relativePaths.pop();
		}
		if (relativePaths.length === 1 && relativePaths[0] === '') {
			return ProjectionDocument.forPaths([]);
		}
		return ProjectionDocument.forPaths(relativePaths.map(relativePath => ({
			uri: deletedPaths.has(relativePath) ? undefined : resolveUri(relativePath),
			relativePath,
			gitStatus: deletedPaths.has(relativePath) ? 'deleted' : undefined,
		})));
	}

	static message(content: string, options?: {
		label?: string;
		sourceUri?: string;
	}): ProjectionDocument {
		const lines = content.split(/\r?\n/);
		return new ProjectionDocument(
			content,
			lines.map((_, line) => ({
				kind: 'annotation' as const,
				role: line === 0 && options?.label ? 'header' as const : 'message' as const,
				label: line === 0 ? options?.label : undefined,
				sourceUri: line === 0 ? options?.sourceUri : undefined,
			})),
			1,
		);
	}

	sourceAt(projectedLine: number, character: number): SourceLocation | undefined {
		const row = this.rows[projectedLine];
		if (row?.kind === 'mapped') {
			return { ...row.source, character: row.role === 'path' ? 0 : character };
		}
		if (row?.kind === 'annotation' && row.role === 'header') {
			const next = this.rows
				.slice(projectedLine + 1)
				.find((candidate): candidate is Extract<ProjectionRow, { kind: 'mapped' }> =>
					candidate.kind === 'mapped' &&
					(!row.sourceUri || candidate.source.uri === row.sourceUri),
				);
			return next
				? { ...next.source, character: 0 }
				: row.sourceUri
					? { uri: row.sourceUri, line: 0, character: 0 }
					: undefined;
		}
		return undefined;
	}

	sourcesAt(positions: readonly SourcePosition[]): SourceLocation[] {
		const sources = new Map<string, SourceLocation>();
		for (const position of positions) {
			const source = this.sourceAt(position.line, position.character);
			if (source && !sources.has(source.uri)) {
				sources.set(source.uri, source);
			}
		}
		return [...sources.values()];
	}

	projectedAt(source: SourceLocation): SourcePosition | undefined {
		const candidates = this.rows.flatMap((row, line) =>
			row.kind === 'mapped' && row.source.uri === source.uri
				? [{ row, line }]
				: [],
		);
		if (candidates.length === 0) {
			return undefined;
		}
		const candidate =
			candidates.find(({ row }) => row.source.line >= source.line) ??
			candidates[candidates.length - 1];
		return { line: candidate.line, character: source.character };
	}

	acceptWorkingCopy(
		workingCopy: string,
		uriRenames: readonly ProjectionUriRename[] = [],
	): ProjectionDocument {
		const lines = workingCopy.split(/\r?\n/);
		const renamedUris = new Map(
			uriRenames.map(rename => [rename.before, rename.after]),
		);
		const rows = this.rows.map((row, line): ProjectionRow => {
			if (row.kind !== 'mapped') {
				return row;
			}
			const baseline = lines[line] ?? row.baseline;
			const renamedUri = renamedUris.get(row.source.uri);
			return baseline === row.baseline && !renamedUri
				? row
				: {
					...row,
					source: renamedUri
						? { ...row.source, uri: renamedUri }
						: row.source,
					baseline,
					matches: undefined,
				};
		});
		if (lines.length === rows.length + 1 && lines.at(-1) === '') {
			rows.push({ kind: 'annotation', role: 'terminal' });
		}
		return new ProjectionDocument(workingCopy, rows, this.sourceLineCount);
	}

	planSave(workingCopy: string): ProjectionSavePlan {
		const beforeLines = projectionSaveLines(this.content, this.rows.length);
		const afterLines = projectionSaveLines(workingCopy, this.rows.length);
		if (
			beforeLines.length !== this.rows.length ||
			afterLines.length !== this.rows.length
		) {
			return {
				ok: false,
				message: 'Existing projected rows may be edited, but rows cannot be inserted or deleted yet.',
			};
		}

		const edits: ProjectionSourceEdit[] = [];
		const sourceEdits = new Map<string, ProjectionSourceEdit>();
		for (let line = 0; line < this.rows.length; line += 1) {
			const before = beforeLines[line];
			const after = afterLines[line];
			if (before === after) {
				continue;
			}

			const row = this.rows[line];
			if (row.kind !== 'mapped') {
				return {
					ok: false,
					message: 'Annotation rows cannot be edited.',
				};
			}
			const edit = { ...row.source, before, after };
			const key = `${row.source.uri}\0${row.source.line}`;
			const existing = sourceEdits.get(key);
			if (existing && existing.after !== after) {
				return {
					ok: false,
					message: `The same source line was edited to two different values: ${row.source.uri}:${row.source.line + 1}`,
				};
			}
			if (!existing) {
				sourceEdits.set(key, edit);
				edits.push(edit);
			}
		}
		return { ok: true, edits };
	}

	planPathSave(workingCopy: string): ProjectionPathSavePlan {
		const beforeLines = projectionSaveLines(this.content, this.rows.length);
		const afterLines = projectionSaveLines(workingCopy, this.rows.length);
		if (
			beforeLines.length !== this.rows.length ||
			afterLines.length !== this.rows.length
		) {
			return {
				ok: false,
				message: 'Existing path rows may be edited, but rows cannot be inserted or deleted.',
			};
		}

		const renames: ProjectionPathRename[] = [];
		for (let line = 0; line < this.rows.length; line += 1) {
			if (beforeLines[line] === afterLines[line]) {
				continue;
			}
			const row = this.rows[line];
			if (row.kind !== 'mapped' || row.role !== 'path') {
				return { ok: false, message: 'Only path rows can be renamed.' };
			}
			renames.push({
				sourceUri: row.source.uri,
				before: beforeLines[line],
				after: afterLines[line],
			});
		}
		return { ok: true, renames };
	}
}

function makeLineMatcher(filter: FilterQuery): (line: string) => boolean {
	if (filter.text.length === 0) {
		return () => true;
	}
	const expression = makeFilterExpression(filter);
	return line => expression.test(line);
}

export function findFilterMatches(
	line: string,
	filter: FilterQuery,
): FilterMatch[] {
	return makeFilterMatchFinder(filter)(line);
}

export function makeFilterMatchFinder(
	filter: FilterQuery,
): (line: string) => FilterMatch[] {
	if (filter.text.length === 0) {
		return () => [];
	}
	let expression: RegExp;
	try {
		expression = makeFilterExpression(filter, true);
	} catch {
		return () => [];
	}
	return line =>
		[...line.matchAll(expression)].flatMap(match =>
			match[0].length > 0
				? [{ start: match.index, end: match.index + match[0].length }]
				: [],
		);
}

function makeFilterExpression(filter: FilterQuery, global = false): RegExp {
	let pattern = filter.useRegex ? filter.text : escapeRegExp(filter.text);
	if (filter.wholeWord) {
		pattern = `\\b(?:${pattern})\\b`;
	}
	const flags = `${global ? 'g' : ''}${filter.matchCase ? '' : 'i'}u`;
	return new RegExp(pattern, flags);
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatSourceLineNumber(
	sourceLine: number,
	sourceLineCount: number,
): string {
	const width = String(Math.max(1, sourceLineCount)).length;
	return String(sourceLine + 1).padStart(width, '\u2007');
}

function projectionSaveLines(content: string, expectedRows: number): string[] {
	const lines = content.split(/\r?\n/);
	if (lines.length === expectedRows + 1 && lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
