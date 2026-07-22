import * as vscode from 'vscode';
import { ProjectionDocument } from './projection-document';

export type ProjectionSaveFailure = {
	ok: false;
	kind: 'invalid-working-copy' | 'source-conflict' | 'apply-failed' | 'save-failed';
	message: string;
};

export type ProjectionSaveSuccess = {
	ok: true;
	editCount: number;
	fileCount: number;
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
}
