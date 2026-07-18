"use strict";
// PROTOTYPE: pure projection logic. Keep this file free of VS Code APIs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatSourceLineNumber = formatSourceLineNumber;
exports.projectLines = projectLines;
exports.projectSearchMatches = projectSearchMatches;
exports.planProjectionSave = planProjectionSave;
exports.toSourcePosition = toSourcePosition;
exports.toProjectedPosition = toProjectedPosition;
function formatSourceLineNumber(sourceLine, sourceLineCount) {
    const width = String(Math.max(1, sourceLineCount)).length;
    return String(sourceLine + 1).padStart(width, '\u2007');
}
function projectLines(text, query, options = {}) {
    const sourceLines = text.split(/\r?\n/);
    const matches = [];
    const mapping = [];
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
function makeLineMatcher(query, options) {
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
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function projectSearchMatches(matches) {
    const groups = new Map();
    for (const match of matches) {
        const group = groups.get(match.uri) ?? [];
        group.push(match);
        groups.set(match.uri, group);
    }
    const lines = [];
    const rows = [];
    const headers = [];
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
function planProjectionSave(baseline, edited, rows) {
    const beforeLines = projectionSaveLines(baseline, rows.length);
    const afterLines = projectionSaveLines(edited, rows.length);
    if (beforeLines.length !== rows.length || afterLines.length !== rows.length) {
        return {
            ok: false,
            message: 'This prototype can edit existing result rows, but cannot insert or delete projected rows yet.',
        };
    }
    const edits = [];
    const sourceEdits = new Map();
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
function projectionSaveLines(content, expectedRows) {
    const lines = content.split(/\r?\n/);
    if (lines.length === expectedRows + 1 && lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}
function toSourcePosition(projectedLine, character, sourceLines) {
    const sourceLine = sourceLines[projectedLine];
    return sourceLine === undefined ? undefined : { line: sourceLine, character };
}
function toProjectedPosition(source, sourceLines) {
    if (sourceLines.length === 0) {
        return undefined;
    }
    let projectedLine = sourceLines.findIndex(line => line >= source.line);
    if (projectedLine === -1) {
        projectedLine = sourceLines.length - 1;
    }
    return { line: projectedLine, character: source.character };
}
//# sourceMappingURL=projection.js.map