import * as vscode from 'vscode';
import { installProjectionFeature } from './vscode-projection-feature';

export function activate(context: vscode.ExtensionContext): void {
	installProjectionFeature(context);
}

export function deactivate(): void {}
