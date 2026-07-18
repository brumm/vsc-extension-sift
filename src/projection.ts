// PROTOTYPE: pure projection logic. Keep this file free of VS Code APIs.

export interface Projection {
	content: string;
	sourceLines: number[];
}

export interface LineFilterOptions {
	matchCase?: boolean;
	wholeWord?: boolean;
	useRegex?: boolean;
}

export interface SourcePosition {
	line: number;
	character: number;
}

export interface SourceLocation extends SourcePosition {
	uri: string;
}

export interface ProjectSearchMatch {
	uri: string;
	relativePath: string;
	line: number;
	text: string;
}

export interface ProjectProjection {
	content: string;
	rows: Array<Omit<SourceLocation, 'character'> | undefined>;
	headers: Array<{ line: number; label: string; uri: string }>;
}

export interface ProjectionSourceEdit {
	uri: string;
	line: number;
	before: string;
	after: string;
}

export type ProjectionSavePlan =
	| { ok: true; edits: ProjectionSourceEdit[] }
	| { ok: false; message: string };

export function formatSourceLineNumber(sourceLine: number, sourceLineCount: number): string {
	const width = String(Math.max(1, sourceLineCount)).length;
	return String(sourceLine + 1).padStart(width, '\u2007');
}

export function projectLines(text: string, query: string, options: LineFilterOptions = {}): Projection {
	const sourceLines = text.split(/\r?\n/);
	const matches: string[] = [];
	const mapping: number[] = [];
	const { matchCase = false, wholeWord = false, useRegex = false } = options;
	const matcher = makeLineMatcher(query, { matchCase, wholeWord, useRegex });

	for (let sourceLine = 0; sourceLine < sourceLines.length; sourceLine += 1) {
		if (matcher(sourceLines[sourceLine])) {
			matches.push(sourceLines[sourceLine]);
			mapping.push(sourceLine);
		}
	}

	return { content: matches.join('\n'), sourceLines: mapping };
}

function makeLineMatcher(query: string, options: Required<LineFilterOptions>): (line: string) => boolean {
	if (query.length === 0) {
		return () => true;
	}
	if (!options.useRegex && !options.wholeWord) {
		const needle = options.matchCase ? query : query.toLocaleLowerCase();
		return line => {
			const candidate = options.matchCase ? line : line.toLocaleLowerCase();
			return candidate.includes(needle);
		};
	}

	let pattern = options.useRegex ? query : escapeRegExp(query);
	if (options.wholeWord) {
		pattern = `\\b(?:${pattern})\\b`;
	}
	const expression = new RegExp(pattern, options.matchCase ? 'u' : 'iu');
	return line => expression.test(line);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function projectSearchMatches(matches: readonly ProjectSearchMatch[]): ProjectProjection {
	const groups = new Map<string, ProjectSearchMatch[]>();

	for (const match of matches) {
		const group = groups.get(match.uri) ?? [];
		group.push(match);
		groups.set(match.uri, group);
	}

	const lines: string[] = [];
	const rows: ProjectProjection['rows'] = [];
	const headers: ProjectProjection['headers'] = [];

	let isFirstGroup = true;
	for (const group of groups.values()) {
		if (!isFirstGroup) {
			lines.push('');
			rows.push(undefined);
		}
		isFirstGroup = false;

		const first = group[0];
		headers.push({ line: lines.length, label: first.relativePath, uri: first.uri });
		lines.push('');
		rows.push(undefined);

		for (const match of group) {
			lines.push(match.text);
			rows.push({ uri: match.uri, line: match.line });
		}
	}

	return { content: lines.join('\n'), rows, headers };
}

export function planProjectionSave(
	baseline: string,
	edited: string,
	rows: readonly (Omit<SourceLocation, 'character'> | undefined)[],
): ProjectionSavePlan {
	const beforeLines = projectionSaveLines(baseline, rows.length);
	const afterLines = projectionSaveLines(edited, rows.length);

	if (beforeLines.length !== rows.length || afterLines.length !== rows.length) {
		return {
			ok: false,
			message: 'This prototype can edit existing result rows, but cannot insert or delete projected rows yet.',
		};
	}

	const edits: ProjectionSourceEdit[] = [];
	const sourceEdits = new Map<string, ProjectionSourceEdit>();
	for (let projectedLine = 0; projectedLine < rows.length; projectedLine += 1) {
		const before = beforeLines[projectedLine];
		const after = afterLines[projectedLine];
		if (before === after) {
			continue;
		}

		const row = rows[projectedLine];
		if (!row) {
			return {
				ok: false,
				message: 'File-boundary and spacer rows are annotations and cannot be edited.',
			};
		}

		const edit = { ...row, before, after };
		const key = `${row.uri}\0${row.line}`;
		const existing = sourceEdits.get(key);
		if (existing && existing.after !== after) {
			return {
				ok: false,
				message: `The same source line was edited to two different values: ${row.uri}:${row.line + 1}`,
			};
		}
		if (!existing) {
			sourceEdits.set(key, edit);
			edits.push(edit);
		}
	}

	return { ok: true, edits };
}

function projectionSaveLines(content: string, expectedRows: number): string[] {
	const lines = content.split(/\r?\n/);
	if (lines.length === expectedRows + 1 && lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}

export function toSourcePosition(
	projectedLine: number,
	character: number,
	sourceLines: readonly number[],
): SourcePosition | undefined {
	const sourceLine = sourceLines[projectedLine];
	return sourceLine === undefined ? undefined : { line: sourceLine, character };
}

export function toProjectedPosition(
	source: SourcePosition,
	sourceLines: readonly number[],
): { line: number; character: number } | undefined {
	if (sourceLines.length === 0) {
		return undefined;
	}

	let projectedLine = sourceLines.findIndex(line => line >= source.line);
	if (projectedLine === -1) {
		projectedLine = sourceLines.length - 1;
	}

	return { line: projectedLine, character: source.character };
}
