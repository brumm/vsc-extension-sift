export interface WordChange {
	start: number;
	end: number;
}

export interface WordDiff {
	deleted: WordChange[];
	added: WordChange[];
}

interface Token {
	text: string;
	start: number;
	end: number;
}

// Pairs beyond these limits keep whole-line highlighting only, which bounds
// the quadratic token comparison for minified or generated lines.
const maximumLineLength = 1000;
const maximumComparedTokens = 10_000;
const minimumSimilarity = 0.4;

export function diffWords(before: string, after: string): WordDiff | undefined {
	if (
		before === after ||
		before.length > maximumLineLength ||
		after.length > maximumLineLength
	) {
		return undefined;
	}
	const left = tokenize(before);
	const right = tokenize(after);
	let prefix = 0;
	while (
		prefix < left.length &&
		prefix < right.length &&
		left[prefix].text === right[prefix].text
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < left.length - prefix &&
		suffix < right.length - prefix &&
		left[left.length - 1 - suffix].text === right[right.length - 1 - suffix].text
	) {
		suffix++;
	}
	const leftMiddle = left.slice(prefix, left.length - suffix);
	const rightMiddle = right.slice(prefix, right.length - suffix);
	const [leftKept, rightKept] = leftMiddle.length * rightMiddle.length <= maximumComparedTokens
		? commonTokens(leftMiddle, rightMiddle)
		: [new Set<number>(), new Set<number>()];

	const unchanged = significantLength(left.slice(0, prefix)) +
		significantLength(left.slice(left.length - suffix)) +
		significantLength(leftMiddle.filter((_, index) => leftKept.has(index)));
	const total = significantLength(left) + significantLength(right);
	if (total === 0 || (2 * unchanged) / total < minimumSimilarity) {
		return undefined;
	}

	return {
		deleted: changedRanges(leftMiddle, leftKept),
		added: changedRanges(rightMiddle, rightKept),
	};
}

function tokenize(text: string): Token[] {
	return [...text.matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu)].map(match => ({
		text: match[0],
		start: match.index,
		end: match.index + match[0].length,
	}));
}

// Longest common subsequence over tokens, returning the kept indexes per side.
function commonTokens(
	left: readonly Token[],
	right: readonly Token[],
): [Set<number>, Set<number>] {
	const width = right.length + 1;
	const lengths = new Uint32Array((left.length + 1) * width);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			lengths[i * width + j] = left[i].text === right[j].text
				? lengths[(i + 1) * width + j + 1] + 1
				: Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
		}
	}
	const leftKept = new Set<number>();
	const rightKept = new Set<number>();
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i].text === right[j].text) {
			leftKept.add(i++);
			rightKept.add(j++);
		} else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return [leftKept, rightKept];
}

function significantLength(tokens: readonly Token[]): number {
	return tokens.reduce((length, token) => length + token.text.trim().length, 0);
}

// Joins changed tokens into ranges, absorbing unchanged whitespace between two
// changes so a rewritten phrase reads as one highlight.
function changedRanges(tokens: readonly Token[], kept: ReadonlySet<number>): WordChange[] {
	const ranges: WordChange[] = [];
	let gapEnd: number | undefined;
	for (const [index, token] of tokens.entries()) {
		const last = ranges.at(-1);
		if (kept.has(index)) {
			gapEnd = last?.end === token.start && token.text.trim() === ''
				? token.end
				: undefined;
			continue;
		}
		if (last && (last.end === token.start || gapEnd === token.start)) {
			last.end = token.end;
		} else {
			ranges.push({ start: token.start, end: token.end });
		}
		gapEnd = undefined;
	}
	return ranges;
}
