const grammarOnlyLanguageIds: Readonly<Record<string, string>> = {
	typescript: 'sift-typescript',
	typescriptreact: 'sift-typescriptreact',
};

export function projectionLanguageId(sourceLanguageId: string): string {
	return grammarOnlyLanguageIds[sourceLanguageId] ?? sourceLanguageId;
}
