export interface ProjectWorkspaceSelection<Document, WorkspaceFolder> {
  workspaceFolder?: WorkspaceFolder
  sourceDocument?: Document
}

export function selectProjectWorkspace<Document, WorkspaceFolder>(
  activeDocument: Document | undefined,
  getWorkspaceFolder: (document: Document) => WorkspaceFolder | undefined,
  workspaceFolders: readonly WorkspaceFolder[] | undefined,
  isLocal: (folder: WorkspaceFolder) => boolean,
): ProjectWorkspaceSelection<Document, WorkspaceFolder> {
  const activeWorkspaceFolder = activeDocument
    ? getWorkspaceFolder(activeDocument)
    : undefined
  if (activeWorkspaceFolder && isLocal(activeWorkspaceFolder)) {
    return {
      workspaceFolder: activeWorkspaceFolder,
      sourceDocument: activeDocument,
    }
  }
  return { workspaceFolder: workspaceFolders?.find(isLocal) }
}
