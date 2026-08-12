import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { listDiffBaseRefs, listRecentCommits } from './git-diff'
import { GitProcessRunner } from './git-process'
import { FffProjectSearch } from './project-search'
import { selectProjectWorkspace } from './project-workspace'
import {
  FilterQuery,
  formatSourceLineNumber,
  makeFilterMatchFinder,
  ProjectionDocument,
  SourceLocation,
  SourcePosition,
} from './projection-document'
import { ProjectionFileSystem } from './projection-file-system'
import { ProjectionFilterInsets } from './projection-filter-insets'
import { projectionLanguageId } from './projection-language'
import { ProjectionSaveCoordinator } from './projection-save'
import {
  ProjectionSession,
  ProjectionSessions,
} from './projection-sessions'
import { VscodeProjectionBuilder } from './vscode-projection-builder'

const scheme = 'sift-editor'
const storedSessionsKey = 'sift.sessions'
const storedDiffBasesKey = 'sift.diffBases'

interface FilterSessionRuntime {
  virtualUri: vscode.Uri
  closed?: boolean
  sourceViewColumn?: vscode.ViewColumn
  sourcePreviewUri?: string
  sourcePreviewViewColumn?: vscode.ViewColumn
  preserveSourcePreview?: boolean
  sourceRevealTimer?: NodeJS.Timeout
  sourceRevealGeneration?: number
  resetEditorPosition?: boolean
  refreshTimer?: NodeJS.Timeout
  renderTimer?: NodeJS.Timeout
  suppressSourceRefreshUntil?: number
  holdPathResults?: boolean
}

interface RefreshOptions {
  force?: boolean
  preserveEditorState?: boolean
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
      if (
        session.target.kind !== 'file' &&
        session.target.rootUri === rootUri
      ) {
        if (
          session.target.kind === 'paths' &&
          runtimeFor(session).holdPathResults
        ) {
          continue
        }
        scheduleRefresh(session)
      }
    }
  })
  sessions = new ProjectionSessions({
    load: () => context.workspaceState.get<unknown[]>(storedSessionsKey, []),
    save: async (descriptors) => {
      await context.workspaceState.update(storedSessionsKey, descriptors)
    },
  }, new VscodeProjectionBuilder(projectSearch, new GitProcessRunner()))
  const gitRunner = new GitProcessRunner()
  const rememberedDiffBases = context.workspaceState.get<Record<string, string>>(
    storedDiffBasesKey,
    {},
  )
  const sessionRuntimes = new Map<string, FilterSessionRuntime>()
  const provider = new ProjectionFileSystem()
  const saveCoordinator = new ProjectionSaveCoordinator()
  const output = vscode.window.createOutputChannel('Sift')
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    20,
  )
  status.command = 'sift.openSource'
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

  const addedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  const deletedLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  const hunkSeparatorDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorGroup.border'),
    borderStyle: 'solid',
    borderWidth: '1px 0 0 0',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  const matchHighlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(
      'editor.findMatchHighlightBackground',
    ),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  const sourceLineHighlightDecoration =
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    })

  const clearSourceLineHighlight = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(sourceLineHighlightDecoration, [])
    }
  }

  const highlightSourceLine = (
    editor: vscode.TextEditor,
    line: number,
  ): void => {
    clearSourceLineHighlight()
    editor.setDecorations(sourceLineHighlightDecoration, [
      new vscode.Range(line, 0, line, 0),
    ])
  }

  const pendingAnchors = new Map<string, EditorAnchor[]>()
  const projectedSelectionLines = new WeakMap<vscode.TextEditor, number>()
  const wordWrapDisabledDocuments = new Set<string>()

  const disableWordWrap = async (editor: vscode.TextEditor): Promise<void> => {
    if (editor.document.uri.scheme !== scheme) {
      return
    }
    const uri = editor.document.uri.toString()
    if (wordWrapDisabledDocuments.has(uri)) {
      return
    }
    if (vscode.window.activeTextEditor !== editor) {
      return
    }
    wordWrapDisabledDocuments.add(uri)
    const configuredWordWrap = vscode.workspace
      .getConfiguration('editor', editor.document.uri)
      .get<string>('wordWrap', 'off')
    if (configuredWordWrap === 'off') {
      return
    }
    try {
      await vscode.commands.executeCommand('editor.action.toggleWordWrap')
    } catch (error) {
      wordWrapDisabledDocuments.delete(uri)
      output.appendLine(`Could not disable word wrap: ${String(error)}`)
    }
  }

  const filterInsets = new ProjectionFilterInsets({
    onFilterChanged: (session, filter) => {
      runtimeFor(session).holdPathResults = false
      void sessions.execute(session.id, { kind: 'update-filter', filter })
      scheduleRefresh(session, {
        force: true,
        preserveEditorState: false,
      })
    },
    onClose: (session) => {
      void cancelSession(session)
    },
    onOpenSource: () => {
      void vscode.commands.executeCommand('sift.openSource')
    },
    onSearchProject: (session, filter) => {
      void searchProjectFromFile(session, filter)
    },
    onUnavailable: (message) => output.appendLine(message),
  })

  const runtimeFor = (session: ProjectionSession): FilterSessionRuntime => {
    const existing = sessionRuntimes.get(session.id)
    if (existing) {
      return existing
    }
    const title = session.target.kind === 'file'
      ? 'Sift Editor'
      : session.target.kind === 'paths'
        ? 'Sift Paths'
        : session.target.kind === 'diff'
          ? 'Sift Diff'
          : 'Sift Project'
    const runtime = {
      virtualUri: makeVirtualUri(session.id, title),
    }
    sessionRuntimes.set(session.id, runtime)
    return runtime
  }

  const closePreviewTab = async (
    sourceUri: string,
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> => {
    const previewTab = vscode.window.tabGroups.all
      .filter(
        (group) =>
          viewColumn === undefined || group.viewColumn === viewColumn,
      )
      .flatMap((group) => group.tabs)
      .find(
        (tab) =>
          tab.isPreview &&
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === sourceUri,
      )
    if (previewTab) {
      await vscode.window.tabGroups.close(previewTab, true)
    }
  }

  const invalidateSourceReveal = (runtime: FilterSessionRuntime): void => {
    runtime.closed = true
    runtime.sourceRevealGeneration = (runtime.sourceRevealGeneration ?? 0) + 1
    if (runtime.sourceRevealTimer) {
      clearTimeout(runtime.sourceRevealTimer)
      runtime.sourceRevealTimer = undefined
    }
  }

  const cancelSession = async (session: ProjectionSession): Promise<void> => {
    const runtime = runtimeFor(session)
    invalidateSourceReveal(runtime)
    if (runtime.sourcePreviewUri && !runtime.preserveSourcePreview) {
      await closePreviewTab(
        runtime.sourcePreviewUri,
        runtime.sourcePreviewViewColumn,
      )
    }
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  }

  const closeSession = (uri: vscode.Uri): void => {
    const id = sessionId(uri)
    const runtime = sessionRuntimes.get(id)
    if (runtime) {
      invalidateSourceReveal(runtime)
      if (runtime.sourcePreviewUri && !runtime.preserveSourcePreview) {
        const sourcePreviewUri = runtime.sourcePreviewUri
        const sourcePreviewViewColumn = runtime.sourcePreviewViewColumn
        setTimeout(
          () => void closePreviewTab(
            sourcePreviewUri,
            sourcePreviewViewColumn,
          ),
          0,
        )
      }
    }
    if (runtime?.refreshTimer) {
      clearTimeout(runtime.refreshTimer)
    }
    if (runtime?.renderTimer) {
      clearTimeout(runtime.renderTimer)
    }
    if (runtime?.sourceRevealTimer) {
      clearTimeout(runtime.sourceRevealTimer)
    }
    provider.forget(uri)
    sessionRuntimes.delete(id)
    pendingAnchors.delete(id)
    wordWrapDisabledDocuments.delete(uri.toString())
    void sessions.close(id)
  }

  const clearEditorDecorations = (editor: vscode.TextEditor): void => {
    editor.setDecorations(lineNumberDecoration, [])
    editor.setDecorations(fileHeaderDecoration, [])
    editor.setDecorations(matchHighlightDecoration, [])
    editor.setDecorations(addedLineDecoration, [])
    editor.setDecorations(deletedLineDecoration, [])
    editor.setDecorations(hunkSeparatorDecoration, [])
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
          contextLines: session.filter.contextLines,
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
    const isPathSession = session.target.kind === 'paths'
    editor.options = {
      ...editor.options,
      lineNumbers: isPathSession
        ? vscode.TextEditorLineNumbersStyle.On
        : vscode.TextEditorLineNumbersStyle.Off,
    }
    const findMatches = makeFilterMatchFinder(session.filter)
    editor.setDecorations(
      lineNumberDecoration,
      session.projection.rows.flatMap((row, projectedLine) =>
        row.kind === 'mapped' && !isPathSession
          ? [
              {
                range: new vscode.Range(projectedLine, 0, projectedLine, 0),
                renderOptions: {
                  before: {
                    contentText: formatSourceLineNumber(
                      row.source.line,
                      session.projection.sourceLineCount,
                    ),
                    color: row.change === 'added'
                      ? new vscode.ThemeColor('gitDecoration.addedResourceForeground')
                      : undefined,
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
          before: {
            contentText: row.label,
            color: row.changeStatus
              ? new vscode.ThemeColor(diffStatusColor(row.changeStatus))
              : undefined,
          },
        },
        hoverMessage: row.sourceUri
          ? vscode.Uri.parse(row.sourceUri).fsPath
          : undefined,
      }]
          : [],
      ),
    )
    editor.setDecorations(
      addedLineDecoration,
      session.projection.rows.flatMap((row, line) =>
        row.kind === 'mapped' && row.change === 'added'
          ? [new vscode.Range(line, 0, line, 0)]
          : [],
      ),
    )
    editor.setDecorations(
      deletedLineDecoration,
      session.projection.rows.flatMap((row, line) =>
        row.kind === 'annotation' && row.role === 'deletion'
          ? [{
              range: new vscode.Range(
                line,
                0,
                line,
                editor.document.lineAt(line).text.length,
              ),
              renderOptions: {
                before: {
                  contentText: formatSourceLineNumber(
                    row.sourceLine ?? 0,
                    session.projection.sourceLineCount,
                  ),
                  color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                  margin: '0 1.5em 0 0',
                },
              },
            }]
          : [],
      ),
    )
    editor.setDecorations(
      hunkSeparatorDecoration,
      session.projection.rows.flatMap((row, line) =>
        row.hunkStart
          ? [new vscode.Range(line, 0, line, 0)]
          : [],
      ),
    )
    editor.setDecorations(
      matchHighlightDecoration,
      session.projection.rows.flatMap((row, projectedLine) => {
        if (row.kind !== 'mapped' || isPathSession) {
          return []
        }
        const line = editor.document.lineAt(projectedLine).text
        const matches = session.target.kind === 'project' || session.target.kind === 'diff'
          ? line === row.baseline ? row.matches ?? [] : []
          : findMatches(line)
        return matches.map(
          (match) => new vscode.Range(
            projectedLine,
            match.start,
            projectedLine,
            match.end,
          ),
        )
      }),
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
      ? session.target.kind === 'paths'
        ? `$(filter) ${session.filter.text} — ${path.relative(vscode.Uri.parse(session.target.rootUri).fsPath, vscode.Uri.parse(source.uri).fsPath)}`
        : `$(filter) ${session.filter.text} — ${path.basename(vscode.Uri.parse(source.uri).path)}:${source.line + 1}:${source.character + 1}`
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
    if (runtimeFor(session).resetEditorPosition) {
      for (const editor of vscode.window.visibleTextEditors) {
        if (
          editor.document.uri.toString() ===
          runtimeFor(session).virtualUri.toString()
        ) {
          editor.selection = new vscode.Selection(0, 0, 0, 0)
          editor.revealRange(
            new vscode.Range(0, 0, 0, 0),
            vscode.TextEditorRevealType.AtTop,
          )
        }
      }
      runtimeFor(session).resetEditorPosition = false
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

  const refresh = async (
    session: ProjectionSession,
    preserveEditorState = true,
  ): Promise<void> => {
    const openProjection = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === runtimeFor(session).virtualUri.toString(),
    )
    const dirty = Boolean(openProjection?.isDirty)
    if (!dirty && preserveEditorState) {
      pendingAnchors.set(session.id, captureAnchors(session))
    } else if (!preserveEditorState) {
      pendingAnchors.delete(session.id)
    }
    const outcome = await sessions.execute(session.id, {
      kind: 'refresh',
      dirty,
    })
    if (outcome.kind === 'blocked-dirty') {
      void vscode.window.showInformationMessage(
        'Save the sifted document before changing its query.',
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
    options: RefreshOptions = {},
  ): void => {
    const {
      force = false,
      preserveEditorState = true,
    } = options
    const runtime = runtimeFor(session)
    if (!preserveEditorState) {
      runtime.resetEditorPosition = true
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document.uri.toString() === runtime.virtualUri.toString()) {
          editor.selection = new vscode.Selection(0, 0, 0, 0)
          editor.revealRange(
            new vscode.Range(0, 0, 0, 0),
            vscode.TextEditorRevealType.AtTop,
          )
        }
      }
    }
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
    runtimeFor(session).refreshTimer = setTimeout(
      () => {
        runtimeFor(session).refreshTimer = undefined
        void refresh(session, preserveEditorState)
      },
      30,
    )
  }

  const showFilterInput = (session: ProjectionSession): void => {
    const input = vscode.window.createInputBox()
    input.title = session.target.kind === 'project'
      ? 'Sift Project'
      : session.target.kind === 'paths'
        ? 'Sift Paths'
        : session.target.kind === 'diff'
          ? 'Sift Diff'
          : 'Sift Editor'
    input.prompt = session.target.kind === 'project'
      ? 'Case-insensitive unless Match Case is enabled; fff path and Git constraints are supported'
      : session.target.kind === 'paths'
        ? 'FFF fuzzy path search; inline glob, exclusion, and Git constraints are supported'
        : session.target.kind === 'diff'
          ? 'Leading FFF path constraints, then optional changed-line content'
          : 'Literal, case-insensitive substring'
    input.value = session.filter.text
    input.ignoreFocusOut = true
    input.onDidChangeValue((value) => {
      runtimeFor(session).holdPathResults = false
      void sessions.execute(session.id, {
        kind: 'update-filter',
        filter: { ...session.filter, text: value },
      })
      filterInsets.sync(session)
      scheduleRefresh(session, {
        force: true,
        preserveEditorState: false,
      })
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
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
    showOptions: Pick<
      vscode.TextDocumentShowOptions,
      'preview' | 'preserveFocus'
    > = {},
  ): Promise<boolean> => {
    const document = await vscode.workspace.openTextDocument(runtimeFor(session).virtualUri)
    const displayLanguageId = projectionLanguageId(session.languageId)
    const languageDocument =
      document.languageId === displayLanguageId
        ? document
        : await vscode.languages.setTextDocumentLanguage(
            document,
            displayLanguageId,
          )
    const editor = await vscode.window.showTextDocument(languageDocument, {
      viewColumn,
      preview: showOptions.preview ?? false,
      preserveFocus: showOptions.preserveFocus,
    })
    await disableWordWrap(editor)
    decorateEditor(editor)
    const hasInset = filterInsets.ensure(editor, session, focusFilterInput)
    updateStatus()
    return hasInset
  }

  const openProjectSearch = async (
    workspaceFolder: vscode.WorkspaceFolder,
    filter: FilterQuery,
    languageId: string,
    focusFilterInput: boolean,
    sourceViewColumn?: vscode.ViewColumn,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): Promise<void> => {
    const session = sessions.open({
      id: randomUUID(),
      target: {
        kind: 'project',
        rootUri: workspaceFolder.uri.toString(),
      },
      filter,
      languageId,
    })
    runtimeFor(session).sourceViewColumn =
      sourceViewColumn ??
      vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.scheme !== scheme,
      )?.viewColumn ??
      vscode.window.activeTextEditor?.viewColumn ??
      vscode.ViewColumn.One
    await refresh(session)
    const hasInset = await showSession(session, focusFilterInput, viewColumn)
    if (focusFilterInput && !hasInset) {
      showFilterInput(session)
    }
  }

  const openPathSearch = async (
    workspaceFolder: vscode.WorkspaceFolder,
    query: string,
    focusFilterInput: boolean,
    sourceViewColumn?: vscode.ViewColumn,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): Promise<void> => {
    const session = sessions.open({
      id: randomUUID(),
      target: {
        kind: 'paths',
        rootUri: workspaceFolder.uri.toString(),
      },
      filter: {
        text: query,
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        contextLines: 0,
      },
      languageId: 'plaintext',
    })
    runtimeFor(session).sourceViewColumn =
      sourceViewColumn ??
      vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.scheme !== scheme,
      )?.viewColumn ??
      vscode.window.activeTextEditor?.viewColumn ??
      vscode.ViewColumn.One
    await refresh(session)
    const hasInset = await showSession(session, focusFilterInput, viewColumn)
    if (focusFilterInput && !hasInset) {
      showFilterInput(session)
    }
  }

  const openDiff = async (
    workspaceFolder: vscode.WorkspaceFolder,
    baseRef?: string,
    initialQuery = '',
    sourceViewColumn?: vscode.ViewColumn,
    commitRef?: string,
  ): Promise<void> => {
    const session = sessions.open({
      id: randomUUID(),
      target: {
        kind: 'diff',
        rootUri: workspaceFolder.uri.toString(),
        baseRef,
        commitRef,
      },
      filter: {
        text: initialQuery,
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        contextLines: 0,
      },
      languageId: 'plaintext',
    })
    runtimeFor(session).sourceViewColumn =
      sourceViewColumn ??
      vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.scheme !== scheme,
      )?.viewColumn ??
      vscode.ViewColumn.One
    await refresh(session)
    const hasInset = await showSession(session, true)
    if (!hasInset) {
      showFilterInput(session)
    }
  }

  const searchProjectFromFile = async (
    session: ProjectionSession,
    filter: FilterQuery,
  ): Promise<void> => {
    if (session.target.kind !== 'file') {
      return
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.parse(session.target.sourceUri),
    )
    if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage(
        'Open the sifted file in a local workspace folder before sifting the project.',
      )
      return
    }
    const projectionEditor = vscode.window.visibleTextEditors.find(
      (editor) =>
        editor.document.uri.toString() ===
        runtimeFor(session).virtualUri.toString(),
    )
    await openProjectSearch(
      workspaceFolder,
      filter,
      session.languageId,
      true,
      runtimeFor(session).sourceViewColumn,
      projectionEditor?.viewColumn ?? vscode.ViewColumn.Beside,
    )
  }

  const revealSourceForSelection = async (
    editor: vscode.TextEditor,
  ): Promise<void> => {
    if (
      editor.document.uri.scheme !== scheme ||
      vscode.window.activeTextEditor !== editor
    ) {
      return
    }
    const session = sessions.get(sessionId(editor.document.uri))
    if (!session) {
      return
    }
    const source = sourceAt(
      session,
      editor.selection.active.line,
      editor.selection.active.character,
    )
    if (!source) {
      clearSourceLineHighlight()
      return
    }
    const runtime = runtimeFor(session)
    const generation = (runtime.sourceRevealGeneration ?? 0) + 1
    runtime.sourceRevealGeneration = generation
    const sourceUri = vscode.Uri.parse(source.uri)
    const visibleSourceEditor = vscode.window.visibleTextEditors.find(
      (candidate) =>
        candidate.document.uri.toString() === sourceUri.toString() &&
        (
          runtime.sourceViewColumn === undefined ||
          candidate.viewColumn === runtime.sourceViewColumn
        ),
    )

    if (session.target.kind === 'file') {
      if (!visibleSourceEditor) {
        return
      }
      const line = Math.min(source.line, visibleSourceEditor.document.lineCount - 1)
      visibleSourceEditor.revealRange(
        new vscode.Range(line, 0, line, 0),
        vscode.TextEditorRevealType.InCenter,
      )
      highlightSourceLine(visibleSourceEditor, line)
      return
    }

    const document = await vscode.workspace.openTextDocument(sourceUri)
    if (runtime.sourceRevealGeneration !== generation) {
      return
    }
    const line = Math.min(source.line, document.lineCount - 1)
    const character = Math.min(
      source.character,
      document.lineAt(line).text.length,
    )
    const selection = new vscode.Selection(line, character, line, character)
    const sourceEditor = await vscode.window.showTextDocument(document, {
      viewColumn: runtime.sourceViewColumn,
      preserveFocus: true,
      preview: true,
      selection,
    })
    if (runtime.sourceRevealGeneration !== generation) {
      if (runtime.closed && !runtime.preserveSourcePreview) {
        void closePreviewTab(sourceUri.toString(), sourceEditor.viewColumn)
      }
      return
    }
    runtime.sourcePreviewUri = sourceUri.toString()
    runtime.sourcePreviewViewColumn = sourceEditor.viewColumn
    sourceEditor.revealRange(selection, vscode.TextEditorRevealType.InCenter)
    highlightSourceLine(sourceEditor, line)
  }

  const scheduleSourceReveal = (editor: vscode.TextEditor): void => {
    if (editor.document.uri.scheme !== scheme) {
      return
    }
    const session = sessions.get(sessionId(editor.document.uri))
    if (!session) {
      return
    }
    const runtime = runtimeFor(session)
    if (runtime.sourceRevealTimer) {
      clearTimeout(runtime.sourceRevealTimer)
    }
    runtime.sourceRevealTimer = setTimeout(
      () => void revealSourceForSelection(editor),
      20,
    )
  }

  const skipProjectAnnotations = (
    event: vscode.TextEditorSelectionChangeEvent,
  ): boolean => {
    const editor = event.textEditor
    if (editor.document.uri.scheme !== scheme) {
      return false
    }
    const session = sessions.get(sessionId(editor.document.uri))
    const line = editor.selection.active.line
    if (!session || session.projection.rows[line]?.kind !== 'annotation') {
      projectedSelectionLines.set(editor, line)
      return false
    }
    const row = session.projection.rows[line]
    if (row.role !== 'spacer' && row.role !== 'header') {
      projectedSelectionLines.set(editor, line)
      return false
    }
    const previousLine = projectedSelectionLines.get(editor) ?? line - 1
    const direction = event.kind === vscode.TextEditorSelectionChangeKind.Mouse
      ? 1
      : line >= previousLine ? 1 : -1
    const findResultLine = (step: number): number | undefined => {
      for (
        let candidate = line + step;
        candidate >= 0 && candidate < session.projection.rows.length;
        candidate += step
      ) {
        if (session.projection.rows[candidate]?.kind === 'mapped') {
          return candidate
        }
      }
      return undefined
    }
    const targetLine =
      findResultLine(direction) ??
      (row.role === 'header' ? findResultLine(1) : undefined)
    if (targetLine === undefined) {
      return false
    }
    const targetCharacter = Math.min(
      editor.selection.active.character,
      editor.document.lineAt(targetLine).text.length,
    )
    editor.selection = new vscode.Selection(
      targetLine,
      targetCharacter,
      targetLine,
      targetCharacter,
    )
    return true
  }

  const focusQueryInput = (): void => {
    const session = activeSession(sessions)
    const editor = vscode.window.activeTextEditor
    if (!session || !editor) {
      return
    }
    if (!filterInsets.ensure(editor, session, true)) {
      showFilterInput(session)
    }
  }

  const useSelectionAsQuery = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor
    const session = activeSession(sessions)
    if (!editor || !session) {
      return
    }
    const text = editor.document.getText(editor.selection)
    if (text.length > 0 && text !== session.filter.text) {
      runtimeFor(session).holdPathResults = false
      await sessions.execute(session.id, {
        kind: 'update-filter',
        filter: { ...session.filter, text },
      })
      filterInsets.sync(session)
      scheduleRefresh(session, {
        force: true,
        preserveEditorState: false,
      })
    }
    focusQueryInput()
  }

  provider.setWriteHandler(async (uri, content) => {
    const session = sessions.get(sessionId(uri))
    if (!session) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }

    const beforeApply = (): void => {
      runtimeFor(session).suppressSourceRefreshUntil = Date.now() + 1_000
    }
    let saveProjection = session.projection
    let savedPathContent: string | undefined
    if (session.target.kind === 'paths') {
      const rootUri = vscode.Uri.parse(session.target.rootUri)
      savedPathContent = new TextDecoder().decode(provider.readFile(uri))
      saveProjection = ProjectionDocument.forPathContent(
        savedPathContent,
        (relativePath) => vscode.Uri.joinPath(
          rootUri,
          ...relativePath.split('/'),
        ).toString(),
      )
      output.appendLine('\n=== path save requested ===')
      output.appendLine(`Session: ${session.id}`)
      output.appendLine(`Saved paths:\n${savedPathContent}`)
      output.appendLine(`Working paths:\n${content}`)
    }
    const outcome = session.target.kind === 'paths'
      ? await saveCoordinator.savePaths(
          saveProjection,
          content,
          vscode.Uri.parse(session.target.rootUri),
          beforeApply,
        )
      : await saveCoordinator.save(
          session.projection,
          content,
          beforeApply,
        )
    if (!outcome.ok) {
      if (session.target.kind === 'paths') {
        output.appendLine(`Path save failed: ${outcome.kind}: ${outcome.message}`)
      }
      void vscode.window.showErrorMessage(outcome.message)
      throw outcome.kind === 'invalid-working-copy'
        ? vscode.FileSystemError.NoPermissions(outcome.message)
        : vscode.FileSystemError.Unavailable(outcome.message)
    }
    if (session.target.kind === 'paths') {
      output.appendLine(`Path save completed: ${outcome.editCount} rename${outcome.editCount === 1 ? '' : 's'}`)
      for (const rename of outcome.uriRenames ?? []) {
        output.appendLine(`${vscode.Uri.parse(rename.before).fsPath} -> ${vscode.Uri.parse(rename.after).fsPath}`)
      }
    }
    if (session.target.kind === 'paths' && outcome.editCount > 0) {
      const runtime = runtimeFor(session)
      runtime.holdPathResults = true
      if (runtime.refreshTimer) {
        clearTimeout(runtime.refreshTimer)
        runtime.refreshTimer = undefined
      }
    }
    const saved = await sessions.execute(session.id, {
      kind: 'save-completed',
      workingCopy: content,
      uriRenames: outcome.uriRenames,
      projection: session.target.kind === 'paths' ? saveProjection : undefined,
    })
    if (session.target.kind === 'paths') {
      output.appendLine(`Path session committed: ${saved.kind}`)
    }
    const refreshAfterSave =
      saved.kind === 'saved' && saved.refreshRequired
    if (outcome.editCount > 0) {
      void vscode.window.setStatusBarMessage(
        session.target.kind === 'paths'
          ? `Sift: renamed ${outcome.editCount} path${outcome.editCount === 1 ? '' : 's'}`
          : `Sift: saved ${outcome.editCount} projected line${outcome.editCount === 1 ? '' : 's'} to ${outcome.fileCount} file${outcome.fileCount === 1 ? '' : 's'}`,
        3_000,
      )
    }
    for (const warning of outcome.warnings ?? []) {
      output.appendLine(warning)
      void vscode.window.showWarningMessage(warning)
    }
    if (
      session.target.kind !== 'paths' &&
      (refreshAfterSave || (session.target.kind === 'diff' && outcome.editCount > 0))
    ) {
      setTimeout(() => scheduleRefresh(session, { force: true }), 0)
    }
  })

  const refreshDiffSessions = (rootUri: string): void => {
    for (const session of sessions.values()) {
      if (
        session.target.kind === 'diff' &&
        session.target.rootUri === rootUri
      ) {
        scheduleRefresh(session)
      }
    }
  }
  const refreshDiffSessionsForUri = (uri: vscode.Uri): void => {
    const folder = vscode.workspace.getWorkspaceFolder(uri)
    if (folder) {
      refreshDiffSessions(folder.uri.toString())
    }
  }
  const gitWatchers = (vscode.workspace.workspaceFolders ?? []).flatMap(folder => {
    if (folder.uri.scheme !== 'file') {
      return []
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.git/{HEAD,index,packed-refs,refs/**}'),
    )
    watcher.onDidCreate(() => refreshDiffSessions(folder.uri.toString()))
    watcher.onDidChange(() => refreshDiffSessions(folder.uri.toString()))
    watcher.onDidDelete(() => refreshDiffSessions(folder.uri.toString()))
    return [watcher]
  })
  const workspaceFileWatchers = (vscode.workspace.workspaceFolders ?? []).flatMap(folder => {
    if (folder.uri.scheme !== 'file') {
      return []
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*'),
    )
    watcher.onDidCreate(() => refreshDiffSessions(folder.uri.toString()))
    watcher.onDidChange(() => refreshDiffSessions(folder.uri.toString()))
    watcher.onDidDelete(() => refreshDiffSessions(folder.uri.toString()))
    return [watcher]
  })

  context.subscriptions.push(
    provider,
    output,
    status,
    lineNumberDecoration,
    fileHeaderDecoration,
    matchHighlightDecoration,
    addedLineDecoration,
    deletedLineDecoration,
    hunkSeparatorDecoration,
    sourceLineHighlightDecoration,
    filterInsets,
    projectSearch,
    ...gitWatchers,
    ...workspaceFileWatchers,
    vscode.workspace.registerFileSystemProvider(scheme, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
    vscode.commands.registerCommand(
      'sift.siftEditor',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        if (!sourceEditor || sourceEditor.document.uri.scheme === scheme) {
          void vscode.window.showWarningMessage(
            'Open an editor before sifting it.',
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
            contextLines: 0,
          },
          languageId: sourceEditor.document.languageId,
        })
        runtimeFor(session).sourceViewColumn = sourceEditor.viewColumn
        await refresh(session)
        const hasInset = await showSession(session, true)
        if (!hasInset) {
          showFilterInput(session)
        }
      },
    ),
    vscode.commands.registerCommand(
      'sift.siftProject',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        const sourceSession = sourceEditor?.document.uri.scheme === scheme
          ? sessions.get(sessionId(sourceEditor.document.uri))
          : undefined
        const activeDocument =
          sourceEditor?.document.uri.scheme === scheme
            ? undefined
            : sourceEditor?.document
        const { workspaceFolder, sourceDocument } = selectProjectWorkspace(
          activeDocument,
          (document) => vscode.workspace.getWorkspaceFolder(document.uri),
          vscode.workspace.workspaceFolders,
          (folder) => folder.uri.scheme === 'file',
        )
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            'Open a local workspace folder before sifting the project.',
          )
          return
        }

        const initialQuery =
          sourceEditor && sourceDocument
            ? sourceDocument.getText(sourceEditor.selections[0])
            : ''
        await openProjectSearch(
          workspaceFolder,
          {
            text: initialQuery,
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            contextLines: 0,
          },
          sourceDocument?.languageId ?? 'plaintext',
          true,
          sourceDocument
            ? sourceEditor?.viewColumn
            : sourceSession
              ? runtimeFor(sourceSession).sourceViewColumn
              : undefined,
        )
      },
    ),
    vscode.commands.registerCommand(
      'sift.siftPaths',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        const sourceSession = sourceEditor?.document.uri.scheme === scheme
          ? sessions.get(sessionId(sourceEditor.document.uri))
          : undefined
        const activeDocument = sourceEditor?.document.uri.scheme === scheme
          ? undefined
          : sourceEditor?.document
        const { workspaceFolder, sourceDocument } = selectProjectWorkspace(
          activeDocument,
          (document) => vscode.workspace.getWorkspaceFolder(document.uri),
          vscode.workspace.workspaceFolders,
          (folder) => folder.uri.scheme === 'file',
        )
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            'Open a local workspace folder before sifting paths.',
          )
          return
        }

        const initialQuery = sourceEditor && sourceDocument
          ? sourceDocument.getText(sourceEditor.selections[0])
          : ''
        await openPathSearch(
          workspaceFolder,
          initialQuery,
          true,
          sourceDocument
            ? sourceEditor?.viewColumn
            : sourceSession
              ? runtimeFor(sourceSession).sourceViewColumn
              : undefined,
        )
      },
    ),
    vscode.commands.registerCommand(
      'sift.siftDiff',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        const activeDocument = sourceEditor?.document.uri.scheme === scheme
          ? undefined
          : sourceEditor?.document
        const { workspaceFolder, sourceDocument } = selectProjectWorkspace(
          activeDocument,
          (document) => vscode.workspace.getWorkspaceFolder(document.uri),
          vscode.workspace.workspaceFolders,
          (folder) => folder.uri.scheme === 'file',
        )
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            'Open a local workspace folder before opening a Sift diff.',
          )
          return
        }
        const initialQuery = sourceEditor && sourceDocument
          ? sourceDocument.getText(sourceEditor.selections[0])
          : ''
        await openDiff(
          workspaceFolder,
          'HEAD',
          initialQuery,
          sourceEditor?.viewColumn,
        )
      },
    ),
    vscode.commands.registerCommand(
      'sift.siftDiffAgainstBaseBranch',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        const activeDocument = sourceEditor?.document.uri.scheme === scheme
          ? undefined
          : sourceEditor?.document
        const { workspaceFolder, sourceDocument } = selectProjectWorkspace(
          activeDocument,
          (document) => vscode.workspace.getWorkspaceFolder(document.uri),
          vscode.workspace.workspaceFolders,
          (folder) => folder.uri.scheme === 'file',
        )
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            'Open a local workspace folder before opening a Sift diff.',
          )
          return
        }
        let baseBranch: string | undefined
        try {
          baseBranch = (await listDiffBaseRefs(
            gitRunner,
            workspaceFolder.uri.fsPath,
          )).baseBranch
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Could not inspect Git refs: ${error instanceof Error ? error.message : String(error)}`,
          )
          return
        }
        if (!baseBranch) {
          void vscode.window.showWarningMessage(
            'Git reflog does not identify a base branch for the current branch.',
          )
          return
        }
        const initialQuery = sourceEditor && sourceDocument
          ? sourceDocument.getText(sourceEditor.selections[0])
          : ''
        await openDiff(
          workspaceFolder,
          baseBranch,
          initialQuery,
          sourceEditor?.viewColumn,
        )
      },
    ),
    vscode.commands.registerCommand(
      'sift.siftDiffAgainst',
      async () => {
        const sourceEditor = vscode.window.activeTextEditor
        const activeDocument = sourceEditor?.document.uri.scheme === scheme
          ? undefined
          : sourceEditor?.document
        const { workspaceFolder, sourceDocument } = selectProjectWorkspace(
          activeDocument,
          (document) => vscode.workspace.getWorkspaceFolder(document.uri),
          vscode.workspace.workspaceFolders,
          (folder) => folder.uri.scheme === 'file',
        )
        if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
          void vscode.window.showWarningMessage(
            'Open a local workspace folder before opening a Sift diff.',
          )
          return
        }
        let refs: Awaited<ReturnType<typeof listDiffBaseRefs>>
        try {
          refs = await listDiffBaseRefs(gitRunner, workspaceFolder.uri.fsPath)
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Could not list Git refs: ${error instanceof Error ? error.message : String(error)}`,
          )
          return
        }
        const rootKey = workspaceFolder.uri.toString()
        const remembered = rememberedDiffBases[rootKey]
        type DiffBaseItem = vscode.QuickPickItem & { ref?: string }
        const item = (
          ref: string,
          description: string | undefined,
          icon: 'cloud' | 'git-branch' | 'git-commit' | 'tag',
        ): DiffBaseItem => ({
          label: `$(${icon}) ${ref}`,
          description: [description, ref === remembered ? 'Last used' : undefined]
            .filter(Boolean)
            .join(' · ') || undefined,
          ref,
        })
        const items: DiffBaseItem[] = [item('HEAD', 'Current commit', 'git-commit')]
        if (refs.baseBranch) {
          items.push(item(
            refs.baseBranch,
            'Base branch',
            refs.remoteBranches.includes(refs.baseBranch) ? 'cloud' : 'git-branch',
          ))
        }
        if (refs.upstreamBranch) {
          items.push(item(refs.upstreamBranch, 'Upstream branch', 'cloud'))
        }
        const addGroup = (
          label: string,
          group: readonly string[],
          icon: 'cloud' | 'git-branch' | 'tag',
        ): void => {
          if (group.length === 0) {
            return
          }
          items.push({ label, kind: vscode.QuickPickItemKind.Separator })
          items.push(...group.map(ref => item(ref, undefined, icon)))
        }
        addGroup('Local branches', refs.localBranches, 'git-branch')
        addGroup('Remote branches', refs.remoteBranches, 'cloud')
        addGroup('Tags', refs.tags, 'tag')
        const selected = await vscode.window.showQuickPick(
          items,
          {
            title: 'Sift: Diff Against…',
            placeHolder: 'Choose a local branch, remote branch, or tag',
          },
        )
        if (!selected?.ref) {
          return
        }
        rememberedDiffBases[rootKey] = selected.ref
        await context.workspaceState.update(storedDiffBasesKey, rememberedDiffBases)
        const initialQuery = sourceEditor && sourceDocument
          ? sourceDocument.getText(sourceEditor.selections[0])
          : ''
      await openDiff(
        workspaceFolder,
        selected.ref,
        initialQuery,
        sourceEditor?.viewColumn,
      )
    }),
    vscode.commands.registerCommand('sift.siftCommit', async () => {
      const sourceEditor = vscode.window.activeTextEditor
      const activeDocument =
        sourceEditor?.document.uri.scheme === scheme
          ? undefined
          : sourceEditor?.document
      const { workspaceFolder, sourceDocument } = selectProjectWorkspace(
        activeDocument,
        (document) => vscode.workspace.getWorkspaceFolder(document.uri),
        vscode.workspace.workspaceFolders,
        (folder) => folder.uri.scheme === 'file',
      )
      if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage(
          'Open a local workspace folder before opening a Sift commit.',
        )
        return
      }
      let commits: Awaited<ReturnType<typeof listRecentCommits>>
      try {
        commits = await listRecentCommits(
          gitRunner,
          workspaceFolder.uri.fsPath,
        )
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not list Git commits: ${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      if (commits.length === 0) {
        void vscode.window.showWarningMessage(
          'The current branch has no commits to sift.',
        )
        return
      }
      type CommitItem = vscode.QuickPickItem & { ref: string }
      const items: CommitItem[] = commits.map((commit) => ({
        label: `$(git-commit) ${commit.shortSha} ${commit.message}`,
        description: commit.relativeDate,
        detail: commit.author,
        ref: commit.ref,
      }))
      const initialQuery =
        sourceEditor && sourceDocument
          ? sourceDocument.getText(sourceEditor.selections[0])
          : ''
      const previewSession = sessions.open({
        id: randomUUID(),
        target: {
          kind: 'diff',
          rootUri: workspaceFolder.uri.toString(),
          commitRef: items[0].ref,
        },
        filter: {
          text: initialQuery,
          matchCase: false,
          wholeWord: false,
          useRegex: false,
          contextLines: 0,
        },
        languageId: 'plaintext',
      }, { transient: true })
      runtimeFor(previewSession).sourceViewColumn =
        sourceEditor?.viewColumn ??
        vscode.window.visibleTextEditors.find(
          (editor) => editor.document.uri.scheme !== scheme,
        )?.viewColumn ??
        vscode.ViewColumn.One

      const picker = vscode.window.createQuickPick<CommitItem>()
      picker.title = 'Sift: Commit…'
      picker.placeholder = 'Choose a recent commit on the current branch'
      picker.matchOnDescription = true
      picker.matchOnDetail = true
      picker.items = items

      let acceptedItem: CommitItem | undefined
      let previewVisible = false
      let previewGeneration = 0
      let previewTimer: NodeJS.Timeout | undefined
      const previewCommit = async (commit: CommitItem): Promise<boolean> => {
        const generation = ++previewGeneration
        picker.busy = true
        try {
          await sessions.execute(previewSession.id, {
            kind: 'update-target',
            target: {
              kind: 'diff',
              rootUri: workspaceFolder.uri.toString(),
              commitRef: commit.ref,
            },
          })
          await refresh(previewSession, false)
          if (
            generation !== previewGeneration ||
            !sessions.get(previewSession.id)
          ) {
            return false
          }
          if (!previewVisible) {
            await showSession(
              previewSession,
              false,
              vscode.ViewColumn.Beside,
              { preview: true, preserveFocus: true },
            )
            if (
              generation !== previewGeneration ||
              !sessions.get(previewSession.id)
            ) {
              return false
            }
            previewVisible = true
          }
          return true
        } catch (error) {
          if (generation === previewGeneration) {
            void vscode.window.showErrorMessage(
              `Could not preview Git commit: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          return false
        } finally {
          if (generation === previewGeneration) {
            picker.busy = false
          }
        }
      }
      const schedulePreview = (commit: CommitItem): void => {
        if (previewTimer) {
          clearTimeout(previewTimer)
        }
        previewTimer = setTimeout(() => {
          previewTimer = undefined
          void previewCommit(commit)
        }, 100)
      }
      const discardPreview = async (): Promise<void> => {
        previewGeneration += 1
        if (previewTimer) {
          clearTimeout(previewTimer)
          previewTimer = undefined
        }
        const previewUri = runtimeFor(previewSession).virtualUri
        const previewTab = vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .find(
            (tab) =>
              tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === previewUri.toString(),
          )
        if (previewTab) {
          await vscode.window.tabGroups.close(previewTab, true)
        }
        closeSession(previewUri)
      }
      const selected = await new Promise<CommitItem | undefined>((resolve) => {
        picker.onDidChangeActive(([commit]) => {
          if (commit) {
            schedulePreview(commit)
          }
        })
        picker.onDidAccept(() => {
          acceptedItem = picker.selectedItems[0] ?? picker.activeItems[0]
          picker.hide()
        })
        picker.onDidHide(() => resolve(acceptedItem))
        picker.show()
        picker.activeItems = [items[0]]
        if (previewTimer) {
          clearTimeout(previewTimer)
          previewTimer = undefined
        }
        void previewCommit(items[0])
      })
      if (previewTimer) {
        clearTimeout(previewTimer)
      }
      if (!selected) {
        await discardPreview()
        picker.dispose()
        return
      }
      if (!(await previewCommit(selected))) {
        await discardPreview()
        picker.dispose()
        return
      }
      picker.dispose()
      if (!(await sessions.promote(previewSession.id))) {
        await discardPreview()
        return
      }
      const hasInset = await showSession(
        previewSession,
        true,
        vscode.ViewColumn.Beside,
        { preview: false },
      )
      if (!hasInset) {
        showFilterInput(previewSession)
      }
    }),
    vscode.commands.registerCommand('sift.focusQueryInput', focusQueryInput),
    vscode.commands.registerCommand(
      'sift.useSelectionAsQuery',
      useSelectionAsQuery,
    ),
    vscode.commands.registerCommand('sift.close', async () => {
      const session = activeSession(sessions)
      if (session) {
        await cancelSession(session)
      }
    }),
    vscode.commands.registerCommand(
      'sift.cursorUpOrFocusQuery',
      async () => {
        const editor = vscode.window.activeTextEditor
        const session = activeSession(sessions)
        if (!editor || !session) {
          await vscode.commands.executeCommand('cursorUp')
          return
        }
        const line = editor.selection.active.line
        const hasResultAbove = session.projection.rows
          .slice(0, line)
          .some((row) => row.kind === 'mapped')
        if (
          editor.selections.length === 1 &&
          editor.selection.isEmpty &&
          !hasResultAbove
        ) {
          focusQueryInput()
          return
        }
        await vscode.commands.executeCommand('cursorUp')
      },
    ),
    vscode.commands.registerCommand(
      'sift.cursorDownOrFocusQuery',
      async () => {
        const editor = vscode.window.activeTextEditor
        const session = activeSession(sessions)
        if (!editor || !session) {
          await vscode.commands.executeCommand('cursorDown')
          return
        }
        if (
          editor.selections.length === 1 &&
          editor.selection.isEmpty &&
          editor.selection.active.line === editor.document.lineCount - 1
        ) {
          const documentStart = new vscode.Position(0, 0)
          editor.revealRange(
            new vscode.Range(documentStart, documentStart),
            vscode.TextEditorRevealType.AtTop,
          )
          setTimeout(focusQueryInput, 0)
          return
        }
        await vscode.commands.executeCommand('cursorDown')
      },
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('files.exclude')) {
        return
      }
      for (const session of sessions.values()) {
        if (session.target.kind !== 'file') {
          scheduleRefresh(session)
        }
      }
    }),
    vscode.commands.registerCommand('sift.save', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.uri.scheme !== scheme) {
        return
      }
      output.appendLine('\n=== sift save command ===')
      output.appendLine(`Document: ${editor.document.uri.toString()}`)
      output.appendLine(`Dirty: ${editor.document.isDirty}`)
      const saved = await editor.document.save()
      output.appendLine(`Save accepted: ${saved}`)
      if (!saved) {
        void vscode.window.showErrorMessage(
          'VS Code rejected the Sift Paths save. See the Sift output for details.',
        )
      }
    }),
    vscode.commands.registerCommand('sift.openSource', async () => {
      const editor = vscode.window.activeTextEditor
      const session = activeSession(sessions)
      if (!editor || !session) {
        return
      }
      const sources = session.projection.sourcesAt(
        editor.selections.map((selection) => selection.active),
      )
      if (sources.length === 0) {
        return
      }
      const primarySourceUri = vscode.Uri.parse(sources[0].uri)
      const runtime = runtimeFor(session)
      runtime.preserveSourcePreview = true
      const visibleSourceEditor = vscode.window.visibleTextEditors.find(
        (candidate) =>
          candidate.document.uri.toString() === primarySourceUri.toString() &&
          (
            runtime.sourceViewColumn === undefined ||
            candidate.viewColumn === runtime.sourceViewColumn
          ),
      )
      const sourceViewColumn =
        visibleSourceEditor?.viewColumn ?? runtime.sourceViewColumn
      if (
        vscode.window.activeTextEditor?.document.uri.toString() ===
        editor.document.uri.toString()
      ) {
        await vscode.commands.executeCommand(
          'workbench.action.closeActiveEditor',
        )
      }
      for (const source of sources) {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(source.uri),
        )
        const line = Math.min(source.line, document.lineCount - 1)
        const character = Math.min(
          source.character,
          document.lineAt(line).text.length,
        )
        const selection = new vscode.Selection(line, character, line, character)
        const showOptions: vscode.TextDocumentShowOptions = {
          viewColumn: sourceViewColumn,
          selection,
        }
        if (session.target.kind !== 'file' || sources.length > 1) {
          showOptions.preview = false
        }
        const sourceEditor = await vscode.window.showTextDocument(
          document,
          showOptions,
        )
        sourceEditor.revealRange(
          sourceEditor.selection,
          vscode.TextEditorRevealType.InCenter,
        )
      }
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
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') {
        refreshDiffSessionsForUri(document.uri)
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const uri of event.files) {
        refreshDiffSessionsForUri(uri)
      }
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        refreshDiffSessionsForUri(file.oldUri)
        refreshDiffSessionsForUri(file.newUri)
        for (const session of sessions.values()) {
          if (
            session.target.kind === 'file' &&
            session.target.sourceUri === file.oldUri.toString()
          ) {
            void sessions.execute(session.id, {
              kind: 'rename-source',
              sourceUri: file.newUri.toString(),
            })
            scheduleRefresh(session, { force: true })
          }
        }
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        refreshDiffSessionsForUri(uri)
        for (const session of sessions.values()) {
          if (
            session.target.kind === 'file' &&
            session.target.sourceUri === uri.toString()
          ) {
            scheduleRefresh(session, { force: true })
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
        void disableWordWrap(editor)
        decorateEditor(editor)
        scheduleSourceReveal(editor)
      }
      if (editor?.document.uri.scheme !== scheme) {
        clearSourceLineHighlight()
      }
      updateStatus()
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (skipProjectAnnotations(event)) {
        return
      }
      updateStatus()
      scheduleSourceReveal(event.textEditor)
    }),
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
  if (vscode.window.activeTextEditor) {
    void disableWordWrap(vscode.window.activeTextEditor)
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

function makeVirtualUri(id: string, title: string): vscode.Uri {
  return vscode.Uri.from({
    scheme,
    path: `/${title}`,
    query: `session=${encodeURIComponent(id)}`,
  })
}

function diffStatusColor(
  status: 'added' | 'modified' | 'deleted' | 'renamed',
): string {
  switch (status) {
    case 'added':
      return 'gitDecoration.addedResourceForeground'
    case 'deleted':
      return 'gitDecoration.deletedResourceForeground'
    case 'renamed':
      return 'gitDecoration.renamedResourceForeground'
    case 'modified':
      return 'gitDecoration.modifiedResourceForeground'
  }
}
