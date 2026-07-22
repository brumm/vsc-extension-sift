import { randomUUID } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	ProjectionDocument,
	ProjectionPathRename,
} from './projection-document';
import { invalidRelativePath } from './path-renames';

export type ProjectionSaveFailure = {
	ok: false;
	kind: 'invalid-working-copy' | 'source-conflict' | 'apply-failed' | 'save-failed';
	message: string;
};

export type ProjectionSaveSuccess = {
	ok: true;
	editCount: number;
	fileCount: number;
	warnings?: string[];
	uriRenames?: { before: string; after: string }[];
};

export type ProjectionSaveOutcome = ProjectionSaveFailure | ProjectionSaveSuccess;

export class ProjectionSaveCoordinator {
	async save(
		projection: ProjectionDocument,
		workingCopy: string,
		beforeApply?: () => void,
	): Promise<ProjectionSaveOutcome> {
		const plan = projection.planSave(workingCopy);
		if (!plan.ok) {
			return {
				ok: false,
				kind: 'invalid-working-copy',
				message: plan.message,
			};
		}

		const sourceDocuments = new Map<string, vscode.TextDocument>();
		for (const edit of plan.edits) {
			let document = sourceDocuments.get(edit.uri);
			if (!document) {
				document = await vscode.workspace.openTextDocument(vscode.Uri.parse(edit.uri));
				sourceDocuments.set(edit.uri, document);
			}
			if (
				edit.line >= document.lineCount ||
				document.lineAt(edit.line).text !== edit.before
			) {
				return {
					ok: false,
					kind: 'source-conflict',
					message: `Source changed since this result was projected: ${document.uri.fsPath}:${edit.line + 1}`,
				};
			}
		}

		if (plan.edits.length === 0) {
			return {
				ok: true,
				editCount: 0,
				fileCount: 0,
			};
		}

		const workspaceEdit = new vscode.WorkspaceEdit();
		for (const edit of plan.edits) {
			const document = sourceDocuments.get(edit.uri)!;
			workspaceEdit.replace(
				document.uri,
				document.lineAt(edit.line).range,
				edit.after,
			);
		}
		beforeApply?.();
		if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
			return {
				ok: false,
				kind: 'apply-failed',
				message: 'VS Code could not apply the projected source edits.',
			};
		}

		for (const document of sourceDocuments.values()) {
			if (!(await document.save())) {
				return {
					ok: false,
					kind: 'save-failed',
					message: `Could not save ${document.uri.fsPath}`,
				};
			}
		}

		return {
			ok: true,
			editCount: plan.edits.length,
			fileCount: sourceDocuments.size,
		};
	}

	async savePaths(
		projection: ProjectionDocument,
		workingCopy: string,
		rootUri: vscode.Uri,
		beforeApply?: () => void,
	): Promise<ProjectionSaveOutcome> {
		const plan = projection.planPathSave(workingCopy);
		if (!plan.ok) {
			return {
				ok: false,
				kind: 'invalid-working-copy',
				message: plan.message,
			};
		}
		if (plan.renames.length === 0) {
			return { ok: true, editCount: 0, fileCount: 0 };
		}

		const validation = await validatePathRenames(plan.renames, rootUri);
		if (!validation.ok) {
			return validation;
		}

		const createdDirectories: vscode.Uri[] = [];
		try {
			for (const directory of validation.missingDirectories) {
				await vscode.workspace.fs.createDirectory(directory);
				createdDirectories.push(directory);
			}
		} catch (error) {
			await removeEmptyDirectories(createdDirectories);
			return {
				ok: false,
				kind: 'apply-failed',
				message: `Could not create a destination folder: ${errorMessage(error)}`,
			};
		}

		beforeApply?.();
		const applied = await applyPathRenameTransaction(validation.renames);
		if (!applied.ok) {
			await removeEmptyDirectories(createdDirectories);
			return {
				ok: false,
				kind: 'apply-failed',
				message: `VS Code could not apply the projected path renames: ${applied.message}`,
			};
		}

		const warnings = await removeEmptySourceDirectories(
			validation.renames.map(rename => rename.sourceUri),
			rootUri,
		);
		return {
			ok: true,
			editCount: validation.renames.length,
			fileCount: validation.renames.length,
			warnings: warnings.length > 0 ? warnings : undefined,
			uriRenames: validation.renames.map(rename => ({
				before: rename.sourceUri.toString(),
				after: rename.destinationUri.toString(),
			})),
		};
	}
}

async function tryApplyWorkspaceEdit(
	edit: vscode.WorkspaceEdit,
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		return await vscode.workspace.applyEdit(edit)
			? { ok: true }
			: { ok: false, message: 'The workspace edit was rejected.' };
	} catch (error) {
		return { ok: false, message: errorMessage(error) };
	}
}

interface ValidatedPathRename {
	sourceUri: vscode.Uri;
	destinationUri: vscode.Uri;
	temporaryUri?: vscode.Uri;
}

async function applyPathRenameTransaction(
	renames: readonly ValidatedPathRename[],
): Promise<{ ok: true } | { ok: false; message: string }> {
	const stagedRenames = renames.filter(
		(rename): rename is ValidatedPathRename & { temporaryUri: vscode.Uri } =>
			Boolean(rename.temporaryUri),
	);
	let stagedCount = 0;
	for (const rename of stagedRenames) {
		const staged = await tryRenameFile(rename.sourceUri, rename.temporaryUri);
		if (!staged.ok) {
			const rollbackErrors = await rollbackRenames(
				stagedRenames.slice(0, stagedCount).reverse().map(item => ({
					from: item.temporaryUri,
					to: item.sourceUri,
				})),
			);
			return {
				ok: false,
				message: `Could not stage ${rename.sourceUri.fsPath}: ${staged.message}${rollbackMessage(rollbackErrors)}`,
			};
		}
		stagedCount += 1;
	}

	let committedCount = 0;
	for (const rename of renames) {
		const committed = await tryRenameFile(
			rename.temporaryUri ?? rename.sourceUri,
			rename.destinationUri,
		);
		if (!committed.ok) {
			const rollbackErrors = await rollbackRenames([
				...renames.slice(0, committedCount).reverse().map(item => ({
					from: item.destinationUri,
					to: item.sourceUri,
				})),
				...renames.slice(committedCount).filter(
					(item): item is ValidatedPathRename & { temporaryUri: vscode.Uri } =>
						Boolean(item.temporaryUri),
				).reverse().map(item => ({
					from: item.temporaryUri,
					to: item.sourceUri,
				})),
			]);
			return {
				ok: false,
				message: `Could not move ${rename.sourceUri.fsPath} to ${rename.destinationUri.fsPath}: ${committed.message}${rollbackMessage(rollbackErrors)}`,
			};
		}
		committedCount += 1;
	}
	return { ok: true };
}

async function tryRenameFile(
	from: vscode.Uri,
	to: vscode.Uri,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const edit = new vscode.WorkspaceEdit();
	edit.renameFile(from, to);
	return tryApplyWorkspaceEdit(edit);
}

async function rollbackRenames(
	renames: readonly { from: vscode.Uri; to: vscode.Uri }[],
): Promise<string[]> {
	const errors: string[] = [];
	for (const rename of renames) {
		const rolledBack = await tryRenameFile(rename.from, rename.to);
		if (!rolledBack.ok) {
			errors.push(`${rename.from.fsPath}: ${rolledBack.message}`);
		}
	}
	return errors;
}

function rollbackMessage(errors: readonly string[]): string {
	return errors.length > 0
		? ` Rollback was incomplete: ${errors.join('; ')}`
		: '';
}

type PathRenameValidation =
	| {
		ok: true;
		renames: ValidatedPathRename[];
		missingDirectories: vscode.Uri[];
	}
	| ProjectionSaveFailure;

async function validatePathRenames(
	renames: readonly ProjectionPathRename[],
	rootUri: vscode.Uri,
): Promise<PathRenameValidation> {
	const destinationKeys = new Set<string>();
	const validated: ValidatedPathRename[] = [];

	for (const rename of renames) {
		const invalid = invalidRelativePath(rename.after);
		if (invalid) {
			return invalidPath(rename.after, invalid);
		}
		const sourceUri = vscode.Uri.parse(rename.sourceUri);
		const expectedSource = relativeFsPath(rootUri, sourceUri);
		if (expectedSource !== rename.before) {
			return invalidPath(rename.before, 'The source path is outside the workspace or no longer matches the result.');
		}
		const destinationUri = vscode.Uri.joinPath(rootUri, ...rename.after.split('/'));
		const destinationKey = pathComparisonKey(destinationUri.fsPath);
		if (destinationKeys.has(destinationKey)) {
			return invalidPath(rename.after, 'More than one row has this destination.');
		}
		destinationKeys.add(destinationKey);

		let sourceStat;
		try {
			sourceStat = await stat(sourceUri.fsPath);
		} catch {
			return sourceConflict(`Source file is unavailable: ${sourceUri.fsPath}`);
		}
		if (!sourceStat.isFile()) {
			return sourceConflict(`Source is not a file: ${sourceUri.fsPath}`);
		}

		let caseOnly = false;
		try {
			const destinationStat = await stat(destinationUri.fsPath);
			const sameFile =
				sourceStat.dev === destinationStat.dev &&
				sourceStat.ino === destinationStat.ino;
			const isCaseOnly =
				sameFile &&
				sourceUri.fsPath !== destinationUri.fsPath &&
				pathComparisonKey(sourceUri.fsPath) === destinationKey;
			if (!isCaseOnly) {
				return sourceConflict(`Destination already exists: ${destinationUri.fsPath}`);
			}
			caseOnly = true;
		} catch (error) {
			if (!isMissingFileError(error)) {
				return sourceConflict(`Could not inspect destination ${destinationUri.fsPath}: ${errorMessage(error)}`);
			}
		}
		let temporaryUri: vscode.Uri | undefined;
		if (caseOnly) {
			try {
				temporaryUri = await unusedSiblingUri(sourceUri);
			} catch (error) {
				return sourceConflict(`Could not prepare a temporary path for ${sourceUri.fsPath}: ${errorMessage(error)}`);
			}
		}
		validated.push({ sourceUri, destinationUri, temporaryUri });
	}

	const missingDirectories = await findMissingDestinationDirectories(
		validated.map(rename => vscode.Uri.file(path.dirname(rename.destinationUri.fsPath))),
		rootUri,
	);
	if (!missingDirectories.ok) {
		return missingDirectories;
	}
	return { ok: true, renames: validated, missingDirectories: missingDirectories.uris };
}

function relativeFsPath(rootUri: vscode.Uri, uri: vscode.Uri): string | undefined {
	const relative = path.relative(rootUri.fsPath, uri.fsPath);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	return relative.split(path.sep).join('/');
}

async function findMissingDestinationDirectories(
	directories: readonly vscode.Uri[],
	rootUri: vscode.Uri,
): Promise<{ ok: true; uris: vscode.Uri[] } | ProjectionSaveFailure> {
	const missing = new Map<string, vscode.Uri>();
	for (const initial of directories) {
		let directory = initial;
		while (directory.fsPath !== rootUri.fsPath) {
			try {
				const info = await lstat(directory.fsPath);
				if (!info.isDirectory()) {
					return sourceConflict(`Destination parent is not a directory: ${directory.fsPath}`);
				}
				break;
			} catch (error) {
				if (!isMissingFileError(error)) {
					return sourceConflict(`Could not inspect destination folder ${directory.fsPath}: ${errorMessage(error)}`);
				}
				missing.set(directory.fsPath, directory);
				directory = vscode.Uri.file(path.dirname(directory.fsPath));
			}
		}
	}
	return {
		ok: true,
		uris: [...missing.values()].sort((left, right) => pathDepth(left.fsPath) - pathDepth(right.fsPath)),
	};
}

async function unusedSiblingUri(sourceUri: vscode.Uri): Promise<vscode.Uri> {
	for (;;) {
		const candidate = vscode.Uri.file(path.join(
			path.dirname(sourceUri.fsPath),
			`.${path.basename(sourceUri.fsPath)}.sift-${randomUUID()}`,
		));
		try {
			await lstat(candidate.fsPath);
		} catch (error) {
			if (isMissingFileError(error)) {
				return candidate;
			}
			throw error;
		}
	}
}

async function removeEmptySourceDirectories(
	sourceUris: readonly vscode.Uri[],
	rootUri: vscode.Uri,
): Promise<string[]> {
	const directories = new Map<string, vscode.Uri>();
	for (const sourceUri of sourceUris) {
		let current = vscode.Uri.file(path.dirname(sourceUri.fsPath));
		while (current.fsPath !== rootUri.fsPath) {
			directories.set(current.fsPath, current);
			current = vscode.Uri.file(path.dirname(current.fsPath));
		}
	}
	const warnings: string[] = [];
	for (const directory of [...directories.values()].sort(
		(left, right) => pathDepth(right.fsPath) - pathDepth(left.fsPath),
	)) {
		try {
			if ((await vscode.workspace.fs.readDirectory(directory)).length === 0) {
				await vscode.workspace.fs.delete(directory, { recursive: false, useTrash: false });
			}
		} catch (error) {
			warnings.push(`Could not remove empty folder ${directory.fsPath}: ${errorMessage(error)}`);
		}
	}
	return warnings;
}

async function removeEmptyDirectories(directories: readonly vscode.Uri[]): Promise<void> {
	for (const directory of [...directories].sort(
		(left, right) => pathDepth(right.fsPath) - pathDepth(left.fsPath),
	)) {
		try {
			if ((await vscode.workspace.fs.readDirectory(directory)).length === 0) {
				await vscode.workspace.fs.delete(directory, { recursive: false, useTrash: false });
			}
		} catch {
			// Keep the original save error.
		}
	}
}

function pathComparisonKey(value: string): string {
	return process.platform === 'win32' || process.platform === 'darwin'
		? value.toLocaleLowerCase('en-US')
		: value;
}

function pathDepth(value: string): number {
	return value.split(path.sep).length;
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function invalidPath(value: string, reason: string): ProjectionSaveFailure {
	return { ok: false, kind: 'invalid-working-copy', message: `Invalid path "${value}": ${reason}` };
}

function sourceConflict(message: string): ProjectionSaveFailure {
	return { ok: false, kind: 'source-conflict', message };
}
