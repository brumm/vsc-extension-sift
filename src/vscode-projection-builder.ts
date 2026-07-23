import * as vscode from 'vscode';
import { FffProjectSearch } from './project-search';
import { ProjectionDocument } from './projection-document';
import {
	ProjectionBuild,
	ProjectionBuilder,
	ProjectionTarget,
} from './projection-sessions';
import { FilterQuery } from './projection-document';

export class VscodeProjectionBuilder implements ProjectionBuilder {
	constructor(private readonly projectSearch: FffProjectSearch) {}

	async build(
		target: ProjectionTarget,
		filter: FilterQuery,
	): Promise<ProjectionBuild> {
		if (target.kind === 'file') {
			const source = await vscode.workspace.openTextDocument(
				vscode.Uri.parse(target.sourceUri),
			);
			return {
				projection: ProjectionDocument.forFile({
					sourceUri: target.sourceUri,
					sourceText: source.getText(),
					filter,
				}),
				languageId: source.languageId,
			};
		}

		const root = vscode.Uri.parse(target.rootUri);
		const excludeGlobs = enabledFilesExcludeGlobs(root);
		if (target.kind === 'paths') {
			const matches = await this.projectSearch.searchPaths({
				rootUri: target.rootUri,
				rootPath: root.fsPath,
				query: filter.text,
				excludeGlobs,
				resolveUri: relativePath =>
					vscode.Uri.joinPath(root, relativePath).toString(),
			});
			return {
				projection: ProjectionDocument.forPaths(matches),
				languageId: 'plaintext',
			};
		}
		if (!filter.text) {
			return {
				projection: ProjectionDocument.message('', {
					label: `Project search — ${root.fsPath}`,
					sourceUri: target.rootUri,
				}),
			};
		}

		const result = await this.projectSearch.search({
			rootUri: target.rootUri,
			rootPath: root.fsPath,
			filter,
			excludeGlobs,
			resolveUri: relativePath =>
				vscode.Uri.joinPath(root, relativePath).toString(),
		});
		return {
			projection: ProjectionDocument.forProject(result.matches),
			message: result.hasMore
				? `Showing the first ${result.matches.length} matches`
				: undefined,
		};
	}
}

function enabledFilesExcludeGlobs(root: vscode.Uri): string[] {
	const excludes = vscode.workspace
		.getConfiguration('files', root)
		.get<Record<string, boolean | { when?: string }>>('exclude', {});
	return Object.entries(excludes)
		.filter((entry): entry is [string, true] => entry[1] === true)
		.map(([pattern]) => pattern);
}
