import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('extension activates', async () => {
		const extension = vscode.extensions.getExtension('local.editor-filter');
		assert.ok(extension, 'local.editor-filter should be installed in the test host');
		await extension.activate();
		assert.equal(extension.isActive, true);
	});
});
