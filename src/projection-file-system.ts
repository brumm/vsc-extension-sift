import * as vscode from 'vscode';

export class ProjectionFileSystem implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;
	private readonly files = new Map<
		string,
		{ bytes: Uint8Array; ctime: number; mtime: number }
	>();
	private writeHandler?: (uri: vscode.Uri, content: string) => Promise<void>;

	setWriteHandler(
		handler: (uri: vscode.Uri, content: string) => Promise<void>,
	): void {
		this.writeHandler = handler;
	}

	seed(uri: vscode.Uri, content: string, notify = true): void {
		const key = uri.toString();
		const previous = this.files.get(key);
		const now = Date.now();
		this.files.set(key, {
			bytes: new TextEncoder().encode(content),
			ctime: previous?.ctime ?? now,
			mtime: now,
		});
		if (notify && previous) {
			this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		}
	}

	forget(uri: vscode.Uri): void {
		this.files.delete(uri.toString());
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	stat(uri: vscode.Uri): vscode.FileStat {
		const file = this.files.get(uri.toString());
		if (!file) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return {
			type: vscode.FileType.File,
			ctime: file.ctime,
			mtime: file.mtime,
			size: file.bytes.byteLength,
		};
	}

	readDirectory(): [string, vscode.FileType][] {
		throw vscode.FileSystemError.NoPermissions('Projection directories are unavailable.');
	}

	createDirectory(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(
			`Cannot create projection directory ${uri.toString()}`,
		);
	}

	readFile(uri: vscode.Uri): Uint8Array {
		const file = this.files.get(uri.toString());
		if (!file) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return file.bytes;
	}

	async writeFile(
		uri: vscode.Uri,
		bytes: Uint8Array,
		options: { create: boolean; overwrite: boolean },
	): Promise<void> {
		const key = uri.toString();
		if (!this.files.has(key) && !options.create) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (this.files.has(key) && !options.overwrite) {
			throw vscode.FileSystemError.FileExists(uri);
		}
		if (!this.writeHandler) {
			throw vscode.FileSystemError.Unavailable('Projection save handler unavailable');
		}

		const content = new TextDecoder().decode(bytes);
		await this.writeHandler(uri, content);
		const previous = this.files.get(key);
		const now = Date.now();
		this.files.set(key, {
			bytes,
			ctime: previous?.ctime ?? now,
			mtime: now,
		});
		this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	delete(uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(`Cannot delete ${uri.toString()}`);
	}

	rename(oldUri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(`Cannot rename ${oldUri.toString()}`);
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
