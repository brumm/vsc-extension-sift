// PROTOTYPE — can an editor inset make a filtered virtual document feel native?
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { FffProjectSearch } from './project-search'
import {
  formatSourceLineNumber,
  SourceLocation,
  SourcePosition,
} from './projection-document'
import { ProjectionFileSystem } from './projection-file-system'
import { ProjectionFilterInsets } from './projection-filter-insets'
import { ProjectionSaveCoordinator } from './projection-save'
import {
  ProjectionSession,
  ProjectionSessions,
} from './projection-sessions'
import { VscodeProjectionBuilder } from './vscode-projection-builder'

const scheme = 'linefilter'
const storedSessionsKey = 'linefilter.prototype.sessions'

interface FilterSessionRuntime {
  virtualUri: vscode.Uri
  refreshTimer?: NodeJS.Timeout
  renderTimer?: NodeJS.Timeout
  suppressSourceRefreshUntil?: number
}

interface SelectionAnchor {
  anchor: SourceLocation
  active: SourceLocation
}

interface EditorAnchor {
  editor: vscode.TextEditor
  selections: SelectionAnchor[]
  visibleStart?: SourceLocation
}

export function installProjectionFeature(context: vscode.ExtensionContext): void {
  let sessions: ProjectionSessions
  const projectSearch = new FffProjectSearch((rootUri) => {
    for (const session of sessions.values()) {
      if (session.target.kind === 'project' && session.target.rootUri === rootUri) {
        scheduleRefresh(session)
      }
    }
  })
  sessions = new ProjectionSessions({
    load: () => context.workspaceState.get<unknown[]>(storedSessionsKey, []),
    save: async (descriptors) => {
      await context.workspaceState.update(storedSessionsKey, descriptors)
    },
  }, new VscodeProjectionBuilder(projectSearch))
  const sessionRuntimes = new Map<string, FilterSessionRuntime>()
  const provider = new ProjectionFileSystem()
  const saveCoordinator = new ProjectionSaveCoordinator()
  const output = vscode.window.createOutputChannel('Line Filter Prototype')
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    20,
  )
  status.command = 'editor-filter.openSource'
  status.tooltip = 'Open the mapped source location'

  const lineNumberDecoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      margin: '0 1.5em 0 0',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  const fileHeaderDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    before: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      margin: '0 1.5em 0 0',
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  const pendingAnchors = new Map<string, EditorAnchor[]>()
  const filterInsets = new ProjectionFilterInsets({
    onFilterChanged: (session, filter) => {
      void sessions.execute(session.id, { kind: 'update-filter', filter })
      scheduleRefresh(session, true)
    },
    onOpenSource: () => {
      void vscode.commands.executeCommand('editor-filter.openSource')
    },
    onUnavailable: (message) => output.appendLine(message),
  })

  const runtimeFor = (session: ProjectionSession): FilterSessionRuntime => {
    const existing = sessionRuntimes.get(session.id)
    if (existing) {
      return existing
    }
    const targetUri = session.target.kind === 'file'
      ? session.target.sourceUri
      : vscode.Uri.joinPath(
          vscode.Uri.parse(session.target.rootUri),
          'Project Search',
        ).toString()
    const runtime = {
      virtualUri: makeVirtualUri(session.id, targetUri),
    }
    sessionRuntimes.set(session.id, runtime)
    return runtime
  }

  const closeSession = (uri: vscode.Uri): void => {
    const id = sessionId(uri)
    const runtime = sessionRuntimes.get(id)
    if (runtime?.refreshTimer) {
      clearTimeout(runtime.refreshTimer)
    }
    if (runtime?.renderTimer) {
      clearTimeout(runtime.renderTimer)
    }
    provider.forget(uri)
    sessionRuntimes.delete(id)
    pendingAnchors.delete(id)
    void sessions.close(id)
  }

  const clearEditorDecorations = (editor: vscode.TextEditor): void => {
    editor.setDecorations(lineNumberDecoration, [])
    editor.setDecorations(fileHeaderDecoration, [])
  }

  const clearSessionDecorations = (session: ProjectionSession): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      if (
        editor.document.uri.toString() === runtimeFor(session).virtualUri.toString()
      ) {
        clearEditorDecorations(editor)
      }
    }
  }

  const sourceAt = (
    session: ProjectionSession,
    projectedLine: number,
    character: number,
  ): SourceLocation | undefined => {
    return session.projection.sourceAt(projectedLine, character)
  }

  const projectedAt = (
    session: ProjectionSession,
    source: SourceLocation,
  ): SourcePosition | undefined => {
    return session.projection.projectedAt(source)
  }

  for (const session of sessions.values()) {
    provider.seed(
      runtimeFor(session).virtualUri,
      session.projection.content,
      false,
    )
  }

  const logState = (reason: string): void => {
    output.appendLine(`\n=== ${reason} ===`)
    output.appendLine(
      `Editor inset API: ${typeof vscode.window.createWebviewTextEditorInset === 'function' ? 'available' : 'unavailable (using Quick Input fallback)'}`,
    )
    output.appendLine(
      JSON.stringify(
        [...sessions.values()].map((session) => ({
          id: session.id,
          target: session.target,
          virtualUri: runtimeFor(session).virtualUri.toString(),
          query: session.filter.text,
          matchCase: session.filter.matchCase,
          wholeWord: session.filter.wholeWord,
          useRegex: session.filter.useRegex,
          state: session.state,
          matchCount: session.projection.rows.filter(
            (row) => row.kind === 'mapped',
          ).length,
          sourceLocations: session.projection.rows.flatMap((row) =>
            row.kind === 'mapped'
              ? [`${row.source.uri}:${row.source.line + 1}`]
              : [],
          ),
          message: session.message,
        })),
        null,
        2,
      ),
    )
  }

  const decorateEditor = (editor: vscode.TextEditor): void => {
    if (editor.document.uri.scheme !== scheme) {
      return
    }
    const session = sessions.get(sessionId(editor.document.uri))
    if (!session) {
      return
    }
    if (editor.document.lineCount !== session.projection.rows.length) {
      clearEditorDecorations(editor)
      return
    }
    editor.options = {
      ...editor.options,
      lineNumbers: vscode.TextEditorLineNumbersStyle.Off,
    }
    editor.setDecorations(
      lineNumberDecoration,
      session.projection.rows.flatMap((row, projectedLine) =>
        row.kind === 'mapped'
          ? [
              {
                range: new vscode.Range(projectedLine, 0, projectedLine, 0),
                renderOptions: {
                  before: {
                    contentText: formatSourceLineNumber(
                      row.source.line,
                      session.projection.sourceLineCount,
                    ),
                  },
                },
                hoverMessage: `${vscode.Uri.parse(row.source.uri).fsPath}:${row.source.line + 1}`,
              },
            ]
          : [],
      ),
    )
    editor.setDecorations(
      fileHeaderDecoration,
      session.projection.rows.flatMap((row, line) =>
        row.kind === 'annotation' && row.role === 'header' && row.label
          ? [{
        range: new vscode.Range(line, 0, line, 0),
        renderOptions: {
          before: { contentText: row.label },
        },
        hoverMessage: row.sourceUri
          ? vscode.Uri.parse(row.sourceUri).fsPath
          : undefined,
      }]
          : [],
      ),
    )
  }

  const updateStatus = (): void => {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.uri.scheme !== scheme) {
      status.hide()
      return
    }
    const session = sessions.get(sessionId(editor.document.uri))
    const source =
      session &&
      sourceAt(
        session,
        editor.selection.active.line,
        editor.selection.active.character,
      )
    status.text = source
      ? `$(filter) ${session.filter.text} — ${path.basename(vscode.Uri.parse(source.uri).path)}:${source.line + 1}:${source.character + 1}`
      : `$(filter) ${session?.filter.text ?? 'unknown'} — no matches`
    status.show()
  }

  const captureAnchors = (session: ProjectionSession): EditorAnchor[] => {
    return vscode.window.visibleTextEditors
      .filter(
        (editor) =>
          editor.document.uri.toString() === runtimeFor(session).virtualUri.toString(),
      )
      .map((editor) => ({
        editor,
        selections: editor.selections.flatMap((selection) => {
          const anchor = sourceAt(
            session,
            selection.anchor.line,
            selection.anchor.character,
          )
          const active = sourceAt(
            session,
            selection.active.line,
            selection.active.character,
          )
          return anchor && active ? [{ anchor, active }] : []
        }),
        visibleStart: editor.visibleRanges[0]
          ? sourceAt(
              session,
              editor.visibleRanges[0].start.line,
              0,
            )
          : undefined,
      }))
  }

  const restoreAnchors = (session: ProjectionSession): void => {
    const anchors = pendingAnchors.get(session.id) ?? []
    if (
      anchors.some(
        (anchor) =>
          anchor.editor.document.getText() !== session.projection.content,
      )
    ) {
      clearSessionDecorations(session)
      return
    }
    for (const anchor of anchors) {
      const selections = anchor.selections.flatMap((selection) => {
        const start = projectedAt(session, selection.anchor)
        const end = projectedAt(session, selection.active)
        if (!start || !end || anchor.editor.document.lineCount === 0) {
          return []
        }
        const startLine = anchor.editor.document.lineAt(
          Math.min(start.line, anchor.editor.document.lineCount - 1),
        )
        const endLine = anchor.editor.document.lineAt(
          Math.min(end.line, anchor.editor.document.lineCount - 1),
        )
        return [
          new vscode.Selection(
            start.line,
            Math.min(start.character, startLine.text.length),
            end.line,
            Math.min(end.character, endLine.text.length),
          ),
        ]
      })
      if (selections.length > 0) {
        anchor.editor.selections = selections
      }
      const visible =
        anchor.visibleStart &&
        projectedAt(session, anchor.visibleStart)
      if (visible && anchor.editor.document.lineCount > 0) {
        anchor.editor.revealRange(
          new vscode.Range(visible.line, 0, visible.line, 0),
          vscode.TextEditorRevealType.AtTop,
        )
      }
    }
    pendingAnchors.delete(session.id)
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === runtimeFor(session).virtualUri.toString()) {
        decorateEditor(editor)
      }
    }
    updateStatus()
  }

  const renderProjectionWhenCurrent = (
    session: ProjectionSession,
    generation: number,
    attempt = 0,
  ): void => {
    if (!session.isCurrent(generation)) {
      return
    }
    const editors = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === runtimeFor(session).virtualUri.toString(),
    )
    if (editors.length === 0) {
      return
    }
    if (
      editors.some(
        (editor) => editor.document.getText() !== session.projection.content,
      )
    ) {
      if (attempt < 50) {
        runtimeFor(session).renderTimer = setTimeout(
          () => renderProjectionWhenCurrent(session, generation, attempt + 1),
          10,
        )
      }
      return
    }
    restoreAnchors(session)
  }

  const scheduleProjectionRender = (
    session: ProjectionSession,
    generation: number,
  ): void => {
    if (runtimeFor(session).renderTimer) {
      clearTimeout(runtimeFor(session).renderTimer)
    }
    runtimeFor(session).renderTimer = setTimeout(
      () => renderProjectionWhenCurrent(session, generation),
      0,
    )
  }

  const refresh = async (session: ProjectionSession): Promise<void> => {
    const openProjection = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === runtimeFor(session).virtualUri.toString(),
    )
    const dirty = Boolean(openProjection?.isDirty)
    if (!dirty) {
      pendingAnchors.set(session.id, captureAnchors(session))
    }
    const outcome = await sessions.execute(session.id, {
      kind: 'refresh',
      dirty,
    })
    if (outcome.kind === 'blocked-dirty') {
      void vscode.window.showInformationMessage(
        'Save the edited filtered document before changing its filter.',
      )
      return
    }
    if (
      outcome.kind !== 'refreshed' &&
      outcome.kind !== 'refresh-failed'
    ) {
      return
    }
    clearSessionDecorations(session)
    provider.seed(runtimeFor(session).virtualUri, outcome.snapshot.projection.content)
    scheduleProjectionRender(session, outcome.revision)
    logState(outcome.kind === 'refreshed' ? 'refresh committed' : 'refresh failed')
  }

  const scheduleRefresh = (
    session: ProjectionSession,
    force = false,
  ): void => {
    const runtime = runtimeFor(session)
    if (
      !force &&
      runtime.suppressSourceRefreshUntil &&
      Date.now() < runtime.suppressSourceRefreshUntil
    ) {
      return
    }
    if (runtimeFor(session).refreshTimer) {
      clearTimeout(runtimeFor(session).refreshTimer)
    }
    runtimeFor(session).refreshTimer = setTimeout(() => void refresh(session), 30)
  }

  const showFilterInput = (session: ProjectionSession): void => {
    const input = vscode.window.createInputBox()
    input.title =
      session.target.kind === 'project'
        ? 'Search project with fff (updates live)'
        : 'Filter lines (updates live)'
    input.prompt =
      session.target.kind === 'project'
        ? 'Case-insensitive unless Match Case is enabled; fff path constraints are supported'
        : 'Literal, case-insensitive substring'
    input.value = session.filter.text
    input.ignoreFocusOut = true
    input.onDidChangeValue((value) => {
      void sessions.execute(session.id, {
        kind: 'update-filter',
        filter: { ...session.filter, text: value },
      })
      filterInsets.sync(session)
      scheduleRefresh(session, true)
    })
    input.onDidAccept(() => input.hide())
    input.onDidHide(() => {
      input.dispose()
    })
    input.show()
  }

  const showSession = async (
    session: ProjectionSession,
    focusFilterInput = false,
  ): Promise<boolean> => {
    const document = await vscode.workspace.openTextDocument(runtimeFor(session).virtualUri)
    const languageDocument =
      document.languageId === session.languageId
        ? document
        : await vscode.languages.setTextDocumentLanguage(
            document,
            session.languageId,
          )
    const editor = await vscode.window.showTextDocument(languageDocument, {
      preview: false,
    })
    decorateEditor(editor)
    const hasInset = filterInsets.ensure(editor, session, focusFilterInput)
    updateStatus()
    return hasInset
  }

  provider.setWriteHandler(async (uri, content) => {
    const session = sessions.get(sessionId(uri))
    if (!session) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }

    const outcome = await saveCoordinator.save(
      session.projection,
      content,
      () => {
        runtimeFor(session).suppressSourceRefreshUntil = Date.now() + 1_000
      },
    )
    if (!outcome.ok) {
      void vscode.window.showErrorMessage(outcome.message)
      throw outcome.kind === 'invalid-working-copy'
        ? vscode.FileSystemError.NoPermissions(outcome.message)
        : vscode.FileSystemError.Unavailable(outcome.message)
    }
    const saved = await sessions.execute(session.id, {
      kind: 'save-completed',
      workingCopy: content,
    })
    const refreshAfterSave =
      saved.kind === 'saved' && saved.refreshRequired
    if (outcome.editCount > 0) {
      void vscode.window.setStatusBarMessage(
        `Filter Lines: saved ${outcome.editCount} projected line${outcome.editCount === 1 ? '' : 's'} to ${outcome.fileCount} file${outcome.fileCount === 1 ? '' : 's'}`,
        3_000,
      )
    }
    if (refreshAfterSave || outcome.refreshRequired) {
      setTimeout(() => scheduleRefresh(session, true), 0)
    }
  })

  context.subscriptions.push(
    provider,
    output,
    status,
    lineNumberDecoration,
    fileHeaderDecoration,
    filterInsets,
    projectSearch,
    vscode.workspace.registerFileSystemProvider(scheme, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand(
      'editor-filter.filterThisFile',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        if (!sourceEditor || sourceEditor.document.uri.scheme === scheme) {
          void vscode.window.showWarningMessage(
            'Open a source file before creating a filtered view.',
          )
          return
        }
        const id = randomUUID()
        const sourceUri = sourceEditor.document.uri.toString()
        const initialQuery = sourceEditor.document.getText(
          sourceEditor.selections[0],
        )
        const session = sessions.open({
          id,
          target: { kind: 'file', sourceUri },
          filter: {
            text: initialQuery,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
          },
          languageId: sourceEditor.document.languageId,
        })
        await refresh(session)
        const hasInset = await showSession(session, !initialQuery)
        if (!initialQuery && !hasInset) {
          showFilterInput(session)
        }
      },
    ),
    vscode.commands.registerCommand(
      'editor-filter.searchProject',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        const sourceDocument =
          sourceEditor?.document.uri.scheme === scheme
            ? undefined
            : sourceEditor?.document
        const workspaceFolder = sourceDocument
          ? vscode.workspace.getWorkspaceFolder(sourceDocument.uri)
          : vscode.workspace.workspaceFolders?.[0]
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            'Open a local workspace folder before searching the project.',
          )
          return
        }

        const id = randomUUID()
        const initialQuery =
          sourceEditor && sourceDocument
            ? sourceDocument.getText(sourceEditor.selections[0])
            : ''
        const session = sessions.open({
          id,
          target: {
            kind: 'project',
            rootUri: workspaceFolder.uri.toString(),
          },
          filter: {
            text: initialQuery,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
          },
          languageId: sourceDocument?.languageId ?? 'plaintext',
        })
        await refresh(session)
        const hasInset = await showSession(session, !initialQuery)
        if (!initialQuery && !hasInset) {
          showFilterInput(session)
        }
      },
    ),
    vscode.commands.registerCommand('editor-filter.changeFilter', () => {
      const session = activeSession(sessions)
      const editor = vscode.window.activeTextEditor
      if (!session || !editor) {
        return
      }
      if (!filterInsets.ensure(editor, session, true)) {
        showFilterInput(session)
      }
    }),
    vscode.commands.registerCommand('editor-filter.openSource', async () => {
      const editor = vscode.window.activeTextEditor
      const session = activeSession(sessions)
      if (!editor || !session) {
        return
      }
      const source = sourceAt(
        session,
        editor.selection.active.line,
        editor.selection.active.character,
      )
      if (!source) {
        return
      }
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(source.uri),
      )
      const line = Math.min(source.line, document.lineCount - 1)
      const character = Math.min(
        source.character,
        document.lineAt(line).text.length,
      )
      const selection = new vscode.Selection(line, character, line, character)
      const viewColumn = editor.viewColumn
      if (
        vscode.window.activeTextEditor?.document.uri.toString() ===
        editor.document.uri.toString()
      ) {
        await vscode.commands.executeCommand(
          'workbench.action.closeActiveEditor',
        )
      }
      const sourceEditor = await vscode.window.showTextDocument(document, {
        viewColumn,
        preview: false,
        selection,
      })
      sourceEditor.revealRange(
        sourceEditor.selection,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      )
    }),
    vscode.commands.registerCommand('editor-filter.showState', () => {
      logState('manual state snapshot')
      output.show(true)
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === scheme) {
        const session = sessions.get(sessionId(event.document.uri))
        if (session) {
          if (event.document.isDirty) {
            void sessions.execute(session.id, { kind: 'working-copy-changed' })
            for (const editor of vscode.window.visibleTextEditors) {
              if (editor.document === event.document) {
                decorateEditor(editor)
              }
            }
            updateStatus()
          } else {
            restoreAnchors(session)
          }
        }
        return
      }
      for (const session of sessions.values()) {
        if (
          session.target.kind === 'file' &&
          session.target.sourceUri === event.document.uri.toString()
        ) {
          scheduleRefresh(session)
        }
      }
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        for (const session of sessions.values()) {
          if (
            session.target.kind === 'file' &&
            session.target.sourceUri === file.oldUri.toString()
          ) {
            void sessions.execute(session.id, {
              kind: 'rename-source',
              sourceUri: file.newUri.toString(),
            })
            scheduleRefresh(session, true)
          }
        }
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        for (const session of sessions.values()) {
          if (
            session.target.kind === 'file' &&
            session.target.sourceUri === uri.toString()
          ) {
            scheduleRefresh(session, true)
          }
        }
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      editors.forEach((editor) => {
        decorateEditor(editor)
        if (editor.document.uri.scheme === scheme) {
          const session = sessions.get(sessionId(editor.document.uri))
          if (session) {
            filterInsets.ensure(editor, session, false)
          }
        }
      })
      updateStatus()
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        decorateEditor(editor)
      }
      updateStatus()
    }),
    vscode.window.onDidChangeTextEditorSelection(updateStatus),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputText)) {
          continue
        }
        const uri = tab.input.uri
        if (uri.scheme !== scheme) {
          continue
        }
        const stillOpen = vscode.window.tabGroups.all.some((group) =>
          group.tabs.some(
            (candidate) =>
              candidate.input instanceof vscode.TabInputText &&
              candidate.input.uri.toString() === uri.toString(),
          ),
        )
        if (!stillOpen) {
          closeSession(uri)
        }
      }
    }),
  )

  for (const session of sessions.values()) {
    void refresh(session)
  }
  logState('extension activated')
}

function activeSession(
  sessions: Pick<ProjectionSessions, 'get'>,
): ProjectionSession | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri
  return uri?.scheme === scheme ? sessions.get(sessionId(uri)) : undefined
}

function sessionId(uri: vscode.Uri): string {
  return new URLSearchParams(uri.query).get('session') ?? ''
}

function makeVirtualUri(id: string, sourceUri: string): vscode.Uri {
  const basename = path.basename(vscode.Uri.parse(sourceUri).path) || 'filtered'
  return vscode.Uri.from({
    scheme,
    path: `/${basename}`,
    query: `session=${encodeURIComponent(id)}`,
  })
}
