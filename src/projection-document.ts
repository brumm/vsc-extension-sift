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
		matches?: readonly FilterMatch[];
	}
	| {
		kind: 'annotation';
		role: 'header' | 'spacer' | 'message' | 'terminal';
		label?: string;
		sourceUri?: string;
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
			return { ...row.source, character };
		}
		if (row?.kind === 'annotation' && row.role === 'header') {
			const next = this.rows
				.slice(projectedLine + 1)
				.find((candidate): candidate is Extract<ProjectionRow, { kind: 'mapped' }> =>
					candidate.kind === 'mapped',
				);
			return next ? { ...next.source, character: 0 } : undefined;
		}
		return undefined;
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

	acceptWorkingCopy(workingCopy: string): ProjectionDocument {
		const lines = workingCopy.split(/\r?\n/);
		const rows = this.rows.map((row, line): ProjectionRow => {
			if (row.kind !== 'mapped') {
				return row;
			}
			const baseline = lines[line] ?? row.baseline;
			return baseline === row.baseline
				? row
				: { ...row, baseline, matches: undefined };
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
