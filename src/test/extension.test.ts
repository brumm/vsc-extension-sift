import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ProjectionDocument } from '../projection-document';
import { ProjectionSaveCoordinator } from '../projection-save';

const extensionId = 'brumm.sift';

suite('Extension Test Suite', () => {
	test('extension activates', async () => {
		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension, `${extensionId} should be installed in the test host`);
		await extension.activate();
		assert.equal(extension.isActive, true);
	});

	test('extension activates when VS Code restores a Sift editor', () => {
		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension);
		assert.ok(
			(extension.packageJSON.activationEvents as string[]).includes(
				'onFileSystem:sift-editor',
			),
		);
	});

	test('Escape routes through the SIFT close command', () => {
		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension);
		const keybindings = extension.packageJSON.contributes?.keybindings as
			| { command?: string; key?: string; when?: string }[]
			| undefined;
		assert.ok(keybindings?.some(keybinding =>
			keybinding.command === 'sift.close' &&
			keybinding.key === 'escape' &&
			keybinding.when?.includes('resourceScheme == sift-editor'),
		));
	});

	test('arrow keys route through SIFT query focus commands', () => {
		const extension = vscode.extensions.getExtension(extensionId);
		assert.ok(extension);
		const keybindings = extension.packageJSON.contributes?.keybindings as
			| { command?: string; key?: string; when?: string }[]
			| undefined;
		assert.ok(keybindings?.some(keybinding =>
			keybinding.command === 'sift.cursorUpOrFocusQuery' &&
			keybinding.key === 'up' &&
			keybinding.when?.includes('resourceScheme == sift-editor'),
		));
		assert.ok(keybindings?.some(keybinding =>
			keybinding.command === 'sift.cursorDownOrFocusQuery' &&
			keybinding.key === 'down' &&
			keybinding.when?.includes('resourceScheme == sift-editor'),
		));
	});

	test('path save moves a file and removes its empty source folder', async () => {
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-path-save-'));
		try {
			await mkdir(join(rootPath, 'old'));
			await writeFile(join(rootPath, 'old/example.ts'), 'example');
			const sourceUri = vscode.Uri.file(join(rootPath, 'old/example.ts'));
			let projection = ProjectionDocument.forPaths([{
				uri: sourceUri.toString(),
				relativePath: 'old/example.ts',
			}]);

			const outcome = await new ProjectionSaveCoordinator().savePaths(
				projection,
				'new/example.ts',
				vscode.Uri.file(rootPath),
			);

			assert.equal(outcome.ok, true);
			assert.deepEqual(outcome.ok ? outcome.uriRenames : undefined, [{
				before: sourceUri.toString(),
				after: vscode.Uri.file(join(rootPath, 'new/example.ts')).toString(),
			}]);
			await access(join(rootPath, 'new/example.ts'));
			await assert.rejects(access(join(rootPath, 'old')));

			assert.ok(outcome.ok);
			projection = projection.acceptWorkingCopy(
				'new/example.ts',
				outcome.uriRenames,
			);
			const reversed = await new ProjectionSaveCoordinator().savePaths(
				projection,
				'old/example.ts',
				vscode.Uri.file(rootPath),
			);
			assert.equal(reversed.ok, true);
			await access(join(rootPath, 'old/example.ts'));
			await assert.rejects(access(join(rootPath, 'new')));
		} finally {
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('path save supports case-only renames', async () => {
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-path-case-'));
		try {
			await writeFile(join(rootPath, 'Example.ts'), 'example');
			const sourceUri = vscode.Uri.file(join(rootPath, 'Example.ts'));
			const projection = ProjectionDocument.forPaths([{
				uri: sourceUri.toString(),
				relativePath: 'Example.ts',
			}]);

			const outcome = await new ProjectionSaveCoordinator().savePaths(
				projection,
				'example.ts',
				vscode.Uri.file(rootPath),
			);

			assert.equal(outcome.ok, true);
			await access(join(rootPath, 'example.ts'));
		} finally {
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('sift.close removes a source preview opened from a path result', async function () {
		this.timeout(10_000);
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-close-preview-'));
		const rootUri = vscode.Uri.file(rootPath);
		await replaceWorkspaceFolders({ uri: rootUri });
		const sourceUri = vscode.Uri.joinPath(rootUri, 'list.tsx');
		const queryUri = vscode.Uri.joinPath(rootUri, 'query.txt');
		try {
			await vscode.workspace.fs.writeFile(
				sourceUri,
				new TextEncoder().encode('export const list = [];'),
			);
			await vscode.workspace.fs.writeFile(
				queryUri,
				new TextEncoder().encode('list.tsx'),
			);
			const queryDocument = await vscode.workspace.openTextDocument(queryUri);
			const queryEditor = await vscode.window.showTextDocument(queryDocument, {
				preview: false,
			});
			queryEditor.selection = new vscode.Selection(0, 0, 0, 'list.tsx'.length);

			await vscode.commands.executeCommand('sift.siftPaths');
			const pathEditor = vscode.window.visibleTextEditors.find(
				(editor) => editor.document.uri.scheme === 'sift-editor',
			);
			assert.ok(pathEditor);
			await vscode.window.showTextDocument(pathEditor.document, pathEditor.viewColumn);
			pathEditor.selection = new vscode.Selection(0, 0, 0, 0);

			await waitFor(() => findTextTab(sourceUri)?.isPreview === true);
			await vscode.commands.executeCommand('sift.close');
			await waitFor(() => findTextTab(sourceUri) === undefined);

			assert.equal(
				vscode.window.visibleTextEditors.some(
					(editor) => editor.document.uri.scheme === 'sift-editor',
				),
				false,
			);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await replaceWorkspaceFolders();
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('path save moves multiple files between the same folders', async () => {
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-path-batch-'));
		const names = ['actions.tsx', 'item.tsx', 'list.tsx', 'utils.ts'];
		try {
			await mkdir(join(rootPath, 'commits'));
			await Promise.all(names.map(name =>
				writeFile(join(rootPath, 'commits', name), name),
			));
			const projection = ProjectionDocument.forPaths(names.map(name => ({
				uri: vscode.Uri.file(join(rootPath, 'commits', name)).toString(),
				relativePath: `commits/${name}`,
			})));

			const outcome = await new ProjectionSaveCoordinator().savePaths(
				projection,
				names.map(name => `commits-foo/${name}`).join('\n'),
				vscode.Uri.file(rootPath),
			);

			assert.equal(outcome.ok, true);
			for (const name of names) {
				await access(join(rootPath, 'commits-foo', name));
			}
			await assert.rejects(access(join(rootPath, 'commits')));
		} finally {
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('path save rolls back files moved before a failure', async () => {
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-path-rollback-'));
		try {
			await mkdir(join(rootPath, 'old'));
			await writeFile(join(rootPath, 'old/one.ts'), 'one');
			await writeFile(join(rootPath, 'old/two.ts'), 'two');
			const projection = ProjectionDocument.forPaths(['one.ts', 'two.ts'].map(name => ({
				uri: vscode.Uri.file(join(rootPath, 'old', name)).toString(),
				relativePath: `old/${name}`,
			})));

			const outcome = await new ProjectionSaveCoordinator().savePaths(
				projection,
				'new/one.ts\nnew/two.ts',
				vscode.Uri.file(rootPath),
				() => unlinkSync(join(rootPath, 'old/two.ts')),
			);

			assert.equal(outcome.ok, false);
			assert.deepEqual(await readdir(join(rootPath, 'old')), ['one.ts']);
			await assert.rejects(access(join(rootPath, 'new')));
		} finally {
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('siftPaths can rename a file and then rename it back', async () => {
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-path-roundtrip-'));
		const rootUri = vscode.Uri.file(rootPath);
		await replaceWorkspaceFolders({ uri: rootUri });
		const suffix = randomUUID();
		const originalName = `sift-roundtrip-${suffix}.txt`;
		const renamedName = `renamed-${suffix}.txt`;
		const originalUri = vscode.Uri.joinPath(rootUri, originalName);
		const renamedUri = vscode.Uri.joinPath(rootUri, renamedName);
		try {
			await vscode.workspace.fs.writeFile(
				originalUri,
				new TextEncoder().encode(originalName),
			);
			const sourceDocument = await vscode.workspace.openTextDocument(originalUri);
			const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
			sourceEditor.selection = new vscode.Selection(
				0,
				0,
				0,
				originalName.length,
			);

			await vscode.commands.executeCommand('sift.siftPaths');
			const pathEditor = vscode.window.visibleTextEditors.find(
				(editor) => editor.document.uri.scheme === 'sift-editor',
			);
			assert.equal(pathEditor?.document.uri.scheme, 'sift-editor');
			assert.ok(pathEditor);
			assert.equal(pathEditor.document.getText(), originalName);

			assert.equal(await pathEditor.edit(builder => {
				builder.replace(fullDocumentRange(pathEditor.document), renamedName);
			}), true);
			assert.equal(await pathEditor.document.save(), true);
			await vscode.workspace.fs.stat(renamedUri);

			await vscode.window.showTextDocument(pathEditor.document, pathEditor.viewColumn);
			await vscode.commands.executeCommand('undo');
			assert.equal(pathEditor.document.getText(), originalName);
			assert.equal(await pathEditor.document.save(), true);
			await vscode.workspace.fs.stat(originalUri);
			await assert.rejects(async () => vscode.workspace.fs.stat(renamedUri));
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			for (const uri of [originalUri, renamedUri]) {
				try {
					await vscode.workspace.fs.delete(uri);
				} catch {
					// The file has the other name or was already removed.
				}
			}
			await replaceWorkspaceFolders();
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('siftPaths can move a matched parent folder and move it back', async () => {
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-path-parent-roundtrip-'));
		const rootUri = vscode.Uri.file(rootPath);
		await replaceWorkspaceFolders({ uri: rootUri });
		const originalParent = 'gitlab/src/components/commits';
		const renamedParent = 'gitlab/src/components/commits-foo';
		try {
			await mkdir(join(rootPath, originalParent), { recursive: true });
			for (const name of ['actions.tsx', 'item.tsx', 'list.tsx', 'utils.ts']) {
				await writeFile(join(rootPath, originalParent, name), name);
			}
			const queryUri = vscode.Uri.joinPath(rootUri, 'query.txt');
			const query = '**/commits/****';
			await vscode.workspace.fs.writeFile(
				queryUri,
				new TextEncoder().encode(query),
			);
			const sourceDocument = await vscode.workspace.openTextDocument(queryUri);
			const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
			sourceEditor.selection = new vscode.Selection(0, 0, 0, query.length);

			await vscode.commands.executeCommand('sift.siftPaths');
			const pathEditor = vscode.window.visibleTextEditors.find(
				(editor) => editor.document.uri.scheme === 'sift-editor',
			);
			assert.ok(pathEditor);
			assert.equal(pathEditor.document.lineCount, 4);

			await vscode.window.showTextDocument(pathEditor.document, pathEditor.viewColumn);
			assert.equal(await pathEditor.edit(builder => {
				builder.replace(
					fullDocumentRange(pathEditor.document),
					pathEditor.document.getText().replaceAll(originalParent, renamedParent),
				);
			}), true);
			await waitForSourcePreview();
			await vscode.commands.executeCommand('sift.save');
			assert.equal(pathEditor.document.isDirty, false);
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootUri, renamedParent, 'utils.ts'));

			await vscode.window.showTextDocument(pathEditor.document, pathEditor.viewColumn);
			assert.equal(await pathEditor.edit(builder => {
				builder.replace(
					fullDocumentRange(pathEditor.document),
					pathEditor.document.getText().replaceAll(renamedParent, originalParent),
				);
			}), true);
			await waitForSourcePreview();
			await vscode.commands.executeCommand('sift.save');
			assert.equal(pathEditor.document.isDirty, false);
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootUri, originalParent, 'utils.ts'));
			await assert.rejects(async () =>
				vscode.workspace.fs.stat(vscode.Uri.joinPath(rootUri, renamedParent)),
			);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await replaceWorkspaceFolders();
			await rm(rootPath, { recursive: true, force: true });
		}
	});
});

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
	const lastLine = document.lineAt(document.lineCount - 1);
	return new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length);
}

async function replaceWorkspaceFolders(
	...folders: { uri: vscode.Uri }[]
): Promise<void> {
	const changed = new Promise<void>(resolve => {
		const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			subscription.dispose();
			resolve();
		});
	});
	assert.equal(vscode.workspace.updateWorkspaceFolders(
		0,
		vscode.workspace.workspaceFolders?.length ?? 0,
		...folders,
	), true);
	await changed;
}

async function waitForSourcePreview(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 100));
}

function findTextTab(uri: vscode.Uri): vscode.Tab | undefined {
	return vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.find(tab =>
			tab.input instanceof vscode.TabInputText &&
			tab.input.uri.toString() === uri.toString(),
		);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			assert.fail('Timed out waiting for editor state');
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}
