import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

suite('Untitled selection', () => {
	test('Sift Project uses selected text from an untitled editor', async function () {
		this.timeout(10_000);
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-untitled-project-'));
		const rootUri = vscode.Uri.file(rootPath);
		const query = 'uniqueUntitledSelection';
		await writeFile(join(rootPath, 'match.ts'), `const ${query} = true;\n`);
		await replaceWorkspaceFolders({ uri: rootUri });

		try {
			const document = await vscode.workspace.openTextDocument({
				content: query,
				language: 'typescript',
			});
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(0, 0, 0, query.length);

			const command = vscode.commands.executeCommand('sift.siftProject');
			await new Promise(resolve => setTimeout(resolve, 100));
			await vscode.commands.executeCommand(
				'workbench.action.acceptSelectedQuickOpenItem',
			);
			await command;
			await waitFor(() => findSiftEditor() !== undefined);

			assert.match(findSiftEditor()?.document.getText() ?? '', new RegExp(query));
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await replaceWorkspaceFolders();
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	test('Sift Paths uses selected text from an untitled editor', async function () {
		this.timeout(10_000);
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-untitled-paths-'));
		const rootUri = vscode.Uri.file(rootPath);
		const query = 'unique-untitled-path.ts';
		await writeFile(join(rootPath, query), 'export {};\n');
		await writeFile(join(rootPath, 'distractor.ts'), 'export {};\n');
		await replaceWorkspaceFolders({ uri: rootUri });

		try {
			const document = await vscode.workspace.openTextDocument({ content: query });
			const editor = await vscode.window.showTextDocument(document);
			editor.selection = new vscode.Selection(0, 0, 0, query.length);

			await vscode.commands.executeCommand('sift.siftPaths');
			await waitFor(() => findSiftEditor() !== undefined);

			assert.equal(findSiftEditor()?.document.getText(), query);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await replaceWorkspaceFolders();
			await rm(rootPath, { recursive: true, force: true });
		}
	});

	// Intentional: changing the query moves the cursor to the first result,
	// and the source preview follows it, so the preview always reflects the
	// best match for the current query.
	test('Sift Project previews the first result after a query change', async function () {
		this.timeout(10_000);
		const rootPath = await mkdtemp(join(tmpdir(), 'sift-first-result-'));
		const rootUri = vscode.Uri.file(rootPath);
		await writeFile(join(rootPath, 'a.txt'), 'beta delta\n');
		await writeFile(join(rootPath, 'b.txt'), 'delta\n');
		await replaceWorkspaceFolders({ uri: rootUri });

		try {
			const source = await vscode.window.showTextDocument(
				vscode.Uri.joinPath(rootUri, 'a.txt'),
				{ viewColumn: vscode.ViewColumn.One },
			);
			source.selection = new vscode.Selection(0, 0, 0, 'beta'.length);
			await vscode.commands.executeCommand('sift.siftProject');
			await waitFor(() => /beta delta/.test(findSiftEditor()?.document.getText() ?? ''));

			const siftEditor = findSiftEditor();
			assert.ok(siftEditor);
			await vscode.window.showTextDocument(siftEditor.document, siftEditor.viewColumn);
			const line = siftEditor.document.getText().split('\n')
				.findIndex(text => text === 'beta delta');
			const start = 'beta '.length;
			siftEditor.selection = new vscode.Selection(line, start, line, start + 'delta'.length);
			await vscode.commands.executeCommand('sift.useSelectionAsQuery');

			const firstResult = (): string | undefined => findSiftEditor()?.document
				.getText()
				.split('\n')
				.find(text => text.trim() !== '');
			const previewText = (): string | undefined => vscode.window.visibleTextEditors
				.find(editor =>
					editor.document.uri.scheme === 'file' &&
					editor.viewColumn === vscode.ViewColumn.One,
				)
				?.document.lineAt(0).text;
			await waitFor(() =>
				/^delta$/m.test(findSiftEditor()?.document.getText() ?? '') &&
				previewText() === firstResult(),
			);
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await replaceWorkspaceFolders();
			await rm(rootPath, { recursive: true, force: true });
		}
	});
});

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

function findSiftEditor(): vscode.TextEditor | undefined {
	return vscode.window.visibleTextEditors.find(
		editor => editor.document.uri.scheme === 'sift-editor',
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
