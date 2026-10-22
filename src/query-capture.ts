/**
 * Returns the text typed into a projection editor between `startOffset` and
 * the cursor, or `undefined` when the edit no longer looks like plain typing
 * at that position (for example after an edit before it).
 */
export function capturedQueryText(
	baseline: string,
	text: string,
	startOffset: number,
	cursorOffset: number,
): string | undefined {
	if (
		cursorOffset < startOffset ||
		text.slice(0, startOffset) !== baseline.slice(0, startOffset)
	) {
		return undefined;
	}
	return text.slice(startOffset, cursorOffset).replaceAll(/\r?\n/g, '');
}

/**
 * Whether a document change looks like a keystroke at or after the capture
 * position: a single-line insertion that replaces at most one character.
 * Anything else (programmatic edits, multi-line pastes) ends the capture.
 */
export function isTypingChange(
	change: { rangeOffset: number; rangeLength: number; text: string },
	startOffset: number,
): boolean {
	return (
		change.rangeOffset >= startOffset &&
		change.rangeLength <= 1 &&
		!/[\r\n]/.test(change.text)
	);
}
