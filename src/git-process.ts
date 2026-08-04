import { execFile } from 'node:child_process';

export interface GitRunOptions {
	acceptedExitCodes?: readonly number[];
}

export interface GitRunner {
	run(
		rootPath: string,
		args: readonly string[],
		options?: GitRunOptions,
	): Promise<string>;
}

export class GitProcessRunner implements GitRunner {
	run(
		rootPath: string,
		args: readonly string[],
		options: GitRunOptions = {},
	): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(
				'git',
				args,
				{
					cwd: rootPath,
					encoding: 'utf8',
					maxBuffer: 50 * 1024 * 1024,
					env: { ...process.env, LC_ALL: 'C' },
				},
				(error, stdout, stderr) => {
					if (!error) {
						resolve(stdout);
						return;
					}
					const exitCode = typeof error.code === 'number' ? error.code : undefined;
					if (exitCode !== undefined && options.acceptedExitCodes?.includes(exitCode)) {
						resolve(stdout);
						return;
					}
					reject(new Error(stderr.trim() || error.message));
				},
			);
		});
	}
}
