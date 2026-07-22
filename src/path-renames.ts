import * as path from 'node:path';

export function invalidRelativePath(value: string): string | undefined {
	if (!value) {
		return 'Path cannot be empty.';
	}
	if (value.includes('\0')) {
		return 'Path cannot contain a null character.';
	}
	if (value.includes('\\')) {
		return 'Use forward slashes as path separators.';
	}
	if (value.endsWith('/')) {
		return 'Path must name a file, not a directory.';
	}
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
		return 'Path must be relative to the workspace.';
	}
	if (value.split('/').some(part => part === '' || part === '.' || part === '..')) {
		return 'Path cannot contain empty, current-directory, or parent-directory segments.';
	}
	if (path.posix.normalize(value) !== value) {
		return 'Path must be a normalized workspace-relative path.';
	}
	return undefined;
}
