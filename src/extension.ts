// PROTOTYPE — can an editor inset make a filtered virtual document feel native?
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { FileFinder } from '@ff-labs/fff-node' with {
  'resolution-mode': 'import',
}
import * as vscode from 'vscode'
import {
  formatSourceLineNumber,
  planProjectionSave,
  projectLines,
  projectSearchMatches,
  SourceLocation,
  SourcePosition,
  toProjectedPosition,
} from './projection'

const scheme = 'linefilter'
const storedSessionsKey = 'linefilter.prototype.sessions'

interface StoredSession {
  id: string
  kind?: 'file' | 'project'
  sourceUri?: string
  rootUri?: string
  query: string
  languageId: string
  matchCase?: boolean
  wholeWord?: boolean
  useRegex?: boolean
}

interface FilterSession extends StoredSession {
  kind: 'file' | 'project'
  virtualUri: vscode.Uri
  content: string
  sourceLines: number[]
  sourceRows: Array<{ uri: string; line: number } | undefined>
  headers: Array<{ line: number; label: string; uri: string }>
  sourceLineCount: number
  generation: number
  refreshTimer?: NodeJS.Timeout
  renderTimer?: NodeJS.Timeout
  refreshAfterSave?: boolean
  suppressSourceRefreshUntil?: number
  state: 'ready' | 'refreshing' | 'missing' | 'failed'
  message?: string
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

interface FinderEntry {
  finder: FileFinder
  unsubscribe?: () => void
}

interface FilterInset {
  sessionId: string
  inset: vscode.WebviewEditorInset
}

class FilterFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.emitter.event
  private readonly files = new Map<
    string,
    { bytes: Uint8Array; ctime: number; mtime: number }
  >()
  private writeHandler?: (uri: vscode.Uri, content: string) => Promise<void>

  setWriteHandler(
    handler: (uri: vscode.Uri, content: string) => Promise<void>,
  ): void {
    this.writeHandler = handler
  }

  seed(uri: vscode.Uri, content: string, notify = true): void {
    const key = uri.toString()
    const previous = this.files.get(key)
    const now = Date.now()
    this.files.set(key, {
      bytes: new TextEncoder().encode(content),
      ctime: previous?.ctime ?? now,
      mtime: now,
    })
    if (notify && previous) {
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
    }
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {})
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.files.get(uri.toString())
    if (!file) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    return {
      type: vscode.FileType.File,
      ctime: file.ctime,
      mtime: file.mtime,
      size: file.bytes.byteLength,
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return []
  }

  createDirectory(): void {}

  readFile(uri: vscode.Uri): Uint8Array {
    const file = this.files.get(uri.toString())
    if (!file) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    return file.bytes
  }

  async writeFile(
    uri: vscode.Uri,
    bytes: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const key = uri.toString()
    if (!this.files.has(key) && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    if (this.files.has(key) && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri)
    }
    const content = new TextDecoder().decode(bytes)
    if (!this.writeHandler) {
      throw vscode.FileSystemError.Unavailable('Projection save handler unavailable')
    }
    await this.writeHandler(uri, content)
    const previous = this.files.get(key)
    const now = Date.now()
    this.files.set(key, {
      bytes,
      ctime: previous?.ctime ?? now,
      mtime: now,
    })
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }])
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(`Cannot delete ${uri.toString()}`)
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(
      `Cannot rename ${oldUri.toString()}`,
    )
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const sessions = new Map<string, FilterSession>()
  const finders = new Map<string, FinderEntry>()
  const finderPromises = new Map<string, Promise<FileFinder>>()
  const provider = new FilterFileSystem()
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
  const filterInsets = new Map<vscode.TextEditor, FilterInset>()

  const clearEditorDecorations = (editor: vscode.TextEditor): void => {
    editor.setDecorations(lineNumberDecoration, [])
    editor.setDecorations(fileHeaderDecoration, [])
  }

  const clearSessionDecorations = (session: FilterSession): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === session.virtualUri.toString()) {
        clearEditorDecorations(editor)
      }
    }
  }

  const sourceAt = (
    session: FilterSession,
    projectedLine: number,
    character: number,
  ): SourceLocation | undefined => {
    const row = session.sourceRows[projectedLine]
    if (row) {
      return { ...row, character }
    }
    if (session.headers.some((header) => header.line === projectedLine)) {
      const next = session.sourceRows.slice(projectedLine + 1).find(Boolean)
      return next ? { ...next, character: 0 } : undefined
    }
    return undefined
  }

  const projectedAt = (
    session: FilterSession,
    source: SourceLocation,
  ): SourcePosition | undefined => {
    const candidates = session.sourceRows.flatMap((row, line) =>
      row?.uri === source.uri ? [{ row, line }] : [],
    )
    if (candidates.length === 0) {
      return undefined
    }
    const candidate =
      candidates.find(({ row }) => row.line >= source.line) ??
      candidates[candidates.length - 1]
    return { line: candidate.line, character: source.character }
  }

  for (const stored of context.workspaceState.get<StoredSession[]>(
    storedSessionsKey,
    [],
  )) {
    const kind = stored.kind ?? 'file'
    if (kind === 'file' && !stored.sourceUri) {
      continue
    }
    if (kind === 'project' && !stored.rootUri) {
      continue
    }
    const virtualUri = makeVirtualUri(
      stored.id,
      stored.sourceUri ?? stored.rootUri ?? 'search',
    )
    const session: FilterSession = {
      ...stored,
      kind,
      virtualUri,
      content: 'Restoring filtered view…',
      sourceLines: [],
      sourceRows: [],
      headers: [],
      sourceLineCount: 1,
      generation: 0,
      state: 'refreshing',
    }
    sessions.set(stored.id, session)
    provider.seed(virtualUri, session.content, false)
  }

  const persist = async (): Promise<void> => {
    const stored = [...sessions.values()].map(
      ({
        id,
        kind,
        sourceUri,
        rootUri,
        query,
        languageId,
        matchCase,
        wholeWord,
        useRegex,
      }) => ({
        id,
        kind,
        sourceUri,
        rootUri,
        query,
        languageId,
        matchCase,
        wholeWord,
        useRegex,
      }),
    )
    await context.workspaceState.update(storedSessionsKey, stored)
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
          sourceUri: session.sourceUri,
          rootUri: session.rootUri,
          kind: session.kind,
          virtualUri: session.virtualUri.toString(),
          query: session.query,
          matchCase: session.matchCase ?? false,
          wholeWord: session.wholeWord ?? false,
          useRegex: session.useRegex ?? false,
          state: session.state,
          generation: session.generation,
          matchCount: session.sourceRows.filter(Boolean).length,
          sourceLocations: session.sourceRows.flatMap((row) =>
            row ? [`${row.uri}:${row.line + 1}`] : [],
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
    if (editor.document.lineCount !== session.sourceRows.length) {
      clearEditorDecorations(editor)
      return
    }
    editor.options = {
      ...editor.options,
      lineNumbers: vscode.TextEditorLineNumbersStyle.Off,
    }
    editor.setDecorations(
      lineNumberDecoration,
      session.sourceRows.flatMap((row, projectedLine) =>
        row
          ? [
              {
                range: new vscode.Range(projectedLine, 0, projectedLine, 0),
                renderOptions: {
                  before: {
                    contentText: formatSourceLineNumber(
                      row.line,
                      session.sourceLineCount,
                    ),
                  },
                },
                hoverMessage: `${vscode.Uri.parse(row.uri).fsPath}:${row.line + 1}`,
              },
            ]
          : [],
      ),
    )
    editor.setDecorations(
      fileHeaderDecoration,
      session.headers.map((header) => ({
        range: new vscode.Range(header.line, 0, header.line, 0),
        renderOptions: {
          before: { contentText: header.label },
        },
        hoverMessage: vscode.Uri.parse(header.uri).fsPath,
      })),
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
      ? `$(filter) ${session.query} — ${path.basename(vscode.Uri.parse(source.uri).path)}:${source.line + 1}:${source.character + 1}`
      : `$(filter) ${session?.query ?? 'unknown'} — no matches`
    status.show()
  }

  const captureAnchors = (session: FilterSession): EditorAnchor[] => {
    return vscode.window.visibleTextEditors
      .filter(
        (editor) =>
          editor.document.uri.toString() === session.virtualUri.toString(),
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

  const restoreAnchors = (session: FilterSession): void => {
    const anchors = pendingAnchors.get(session.id) ?? []
    if (
      anchors.some(
        (anchor) => anchor.editor.document.getText() !== session.content,
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
      if (editor.document.uri.toString() === session.virtualUri.toString()) {
        decorateEditor(editor)
      }
    }
    updateStatus()
  }

  const renderProjectionWhenCurrent = (
    session: FilterSession,
    generation: number,
    attempt = 0,
  ): void => {
    if (generation !== session.generation) {
      return
    }
    const editors = vscode.window.visibleTextEditors.filter(
      (editor) => editor.document.uri.toString() === session.virtualUri.toString(),
    )
    if (editors.length === 0) {
      return
    }
    if (editors.some((editor) => editor.document.getText() !== session.content)) {
      if (attempt < 50) {
        session.renderTimer = setTimeout(
          () => renderProjectionWhenCurrent(session, generation, attempt + 1),
          10,
        )
      }
      return
    }
    restoreAnchors(session)
  }

  const scheduleProjectionRender = (
    session: FilterSession,
    generation: number,
  ): void => {
    if (session.renderTimer) {
      clearTimeout(session.renderTimer)
    }
    session.renderTimer = setTimeout(
      () => renderProjectionWhenCurrent(session, generation),
      0,
    )
  }

  const getFinder = async (rootUri: string): Promise<FileFinder> => {
    const existing = finders.get(rootUri)
    if (existing) {
      return existing.finder
    }
    const existingPromise = finderPromises.get(rootUri)
    if (existingPromise) {
      return existingPromise
    }

    const promise = (async () => {
      const root = vscode.Uri.parse(rootUri)
      const { FileFinder } = await import('@ff-labs/fff-node')
      const created = FileFinder.create({ basePath: root.fsPath })
      if (!created.ok) {
        throw new Error(created.error)
      }
      const finder = created.value
      const scanned = await finder.waitForIndexReady(10_000)
      if (!scanned.ok) {
        finder.destroy()
        throw new Error(scanned.error)
      }

      const watched = finder.watch(() => {
        for (const session of sessions.values()) {
          if (session.kind === 'project' && session.rootUri === rootUri) {
            scheduleRefresh(session)
          }
        }
      })
      const entry: FinderEntry = {
        finder,
        unsubscribe: watched.ok ? watched.value : undefined,
      }
      finders.set(rootUri, entry)
      return finder
    })()
    finderPromises.set(rootUri, promise)
    try {
      return await promise
    } catch (error) {
      finderPromises.delete(rootUri)
      throw error
    }
  }

  const refresh = async (session: FilterSession): Promise<void> => {
    const openProjection = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === session.virtualUri.toString(),
    )
    if (openProjection?.isDirty) {
      if (!session.refreshAfterSave) {
        void vscode.window.showInformationMessage(
          'Save the edited filtered document before changing its filter.',
        )
      }
      session.refreshAfterSave = true
      return
    }
    const generation = ++session.generation
    pendingAnchors.set(session.id, captureAnchors(session))
    session.state = 'refreshing'
    try {
      if (session.kind === 'file') {
        if (!session.sourceUri) {
          throw new Error('The source file is unavailable.')
        }
        const source = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(session.sourceUri),
        )
        if (generation !== session.generation) {
          return
        }
        const projection = projectLines(source.getText(), session.query, {
          matchCase: session.matchCase,
          wholeWord: session.wholeWord,
          useRegex: session.useRegex,
        })
        session.content = projection.content
        session.sourceLines = projection.sourceLines
        const sourceRows = projection.sourceLines.map((line) => ({
          uri: session.sourceUri!,
          line,
        }))
        session.sourceRows =
          sourceRows.length > 0 ? sourceRows : [undefined]
        session.headers = []
        session.sourceLineCount = source.lineCount
        session.languageId = source.languageId
      } else {
        if (!session.rootUri) {
          throw new Error('The workspace folder is unavailable.')
        }
        const root = vscode.Uri.parse(session.rootUri)
        if (!session.query) {
          session.content = ''
          session.sourceLines = []
          session.sourceRows = [undefined]
          session.headers = [
            {
              line: 0,
              label: `Project search — ${root.fsPath}`,
              uri: session.rootUri,
            },
          ]
          session.sourceLineCount = 1
        } else {
          const finder = await getFinder(session.rootUri)
          const grep = fffGrepQuery(session)
          const result = finder.grep(grep.query, {
            mode: grep.mode,
            smartCase: grep.smartCase,
            pageSize: 1_000,
            maxMatchesPerFile: 200,
            timeBudgetMs: 250,
          })
          if (!result.ok) {
            throw new Error(result.error)
          }
          if (generation !== session.generation) {
            return
          }
          const projection = projectSearchMatches(
            result.value.items.map((match) => ({
              uri: vscode.Uri.joinPath(root, match.relativePath).toString(),
              relativePath: match.relativePath,
              line: Math.max(0, match.lineNumber - 1),
              text: match.lineContent,
            })),
          )
          session.content = projection.content
          session.sourceLines = []
          session.sourceRows =
            projection.rows.length > 0 ? projection.rows : [undefined]
          session.headers = projection.headers
          session.sourceLineCount = Math.max(
            1,
            ...projection.rows.flatMap((row) => (row ? [row.line + 1] : [])),
          )
          session.message = result.value.nextCursor
            ? `Showing the first ${result.value.items.length} matches`
            : undefined
        }
      }
      session.state = 'ready'
      if (session.kind === 'file') {
        session.message = undefined
      }
      clearSessionDecorations(session)
      provider.seed(session.virtualUri, session.content)
      scheduleProjectionRender(session, generation)
      await persist()
      logState('refresh committed')
    } catch (error) {
      if (generation !== session.generation) {
        return
      }
      session.state = 'missing'
      session.message = error instanceof Error ? error.message : String(error)
      session.content =
        session.kind === 'project'
          ? `Project search failed:\n${session.rootUri}\n\n${session.message}`
          : `Source is unavailable:\n${session.sourceUri}\n\n${session.message}`
      session.sourceLines = []
      session.sourceRows = []
      session.headers = []
      session.sourceLineCount = 1
      session.sourceRows = session.content.split('\n').map(() => undefined)
      clearSessionDecorations(session)
      provider.seed(session.virtualUri, session.content)
      scheduleProjectionRender(session, generation)
      logState('refresh failed')
    }
  }

  const scheduleRefresh = (
    session: FilterSession,
    force = false,
  ): void => {
    if (
      !force &&
      session.suppressSourceRefreshUntil &&
      Date.now() < session.suppressSourceRefreshUntil
    ) {
      return
    }
    if (session.refreshTimer) {
      clearTimeout(session.refreshTimer)
    }
    session.refreshTimer = setTimeout(() => void refresh(session), 30)
  }

  const revealSourceLineAtTop = (
    editor: vscode.TextEditor,
    session: FilterSession,
    sourceLine: number,
  ): void => {
    const projected = toProjectedPosition(
      { line: sourceLine, character: 0 },
      session.sourceLines,
    )
    if (projected) {
      editor.revealRange(
        new vscode.Range(projected.line, 0, projected.line, 0),
        vscode.TextEditorRevealType.AtTop,
      )
    }
  }

  const showFilterInput = (
    session: FilterSession,
    restoreSourceLine?: number,
  ): void => {
    const input = vscode.window.createInputBox()
    input.title =
      session.kind === 'project'
        ? 'Search project with fff (updates live)'
        : 'Filter lines (updates live)'
    input.prompt =
      session.kind === 'project'
        ? 'Plain text with smart case; fff path constraints are supported'
        : 'Literal, case-insensitive substring'
    input.value = session.query
    input.ignoreFocusOut = true
    input.onDidChangeValue((value) => {
      session.query = value
      for (const entry of filterInsets.values()) {
        if (entry.sessionId === session.id) {
          void entry.inset.webview.postMessage({
            type: 'setState',
            value,
            matchCase: session.matchCase ?? false,
            wholeWord: session.wholeWord ?? false,
            useRegex: session.useRegex ?? false,
          })
        }
      }
      scheduleRefresh(session, true)
    })
    input.onDidAccept(() => input.hide())
    input.onDidHide(() => {
      input.dispose()
      if (restoreSourceLine !== undefined) {
        setTimeout(() => {
          const editor = vscode.window.visibleTextEditors.find(
            (candidate) =>
              candidate.document.uri.toString() === session.virtualUri.toString(),
          )
          if (editor) {
            revealSourceLineAtTop(editor, session, restoreSourceLine)
          }
        }, 0)
      }
    })
    input.show()
  }

  const ensureFilterInset = (
    editor: vscode.TextEditor,
    session: FilterSession,
    focusInput: boolean,
  ): boolean => {
    const existing = filterInsets.get(editor)
    if (existing?.sessionId === session.id) {
      void existing.inset.webview.postMessage({
        type: 'setState',
        value: session.query,
        matchCase: session.matchCase ?? false,
        wholeWord: session.wholeWord ?? false,
        useRegex: session.useRegex ?? false,
      })
      if (focusInput) {
        void existing.inset.webview.postMessage({ type: 'focus' })
      }
      return true
    }
    existing?.inset.dispose()

    if (typeof vscode.window.createWebviewTextEditorInset !== 'function') {
      return false
    }

    try {
      const firstVisibleLine = editor.visibleRanges[0]?.start.line ?? 0
      const inset = vscode.window.createWebviewTextEditorInset(
        editor,
        firstVisibleLine - 1,
        2,
        { enableScripts: true },
      )
      filterInsets.set(editor, { sessionId: session.id, inset })
      inset.webview.html = filterInsetHtml(inset.webview, session, focusInput)

      const messageSubscription = inset.webview.onDidReceiveMessage(
        (message: unknown) => {
          if (!message || typeof message !== 'object' || !('type' in message)) {
            return
          }
          if (
            message.type === 'query' &&
            'value' in message &&
            typeof message.value === 'string'
          ) {
            if (session.query !== message.value) {
              session.query = message.value
              scheduleRefresh(session, true)
            }
            return
          }
          if (message.type === 'options') {
            if (
              'matchCase' in message &&
              typeof message.matchCase === 'boolean' &&
              'wholeWord' in message &&
              typeof message.wholeWord === 'boolean' &&
              'useRegex' in message &&
              typeof message.useRegex === 'boolean'
            ) {
              session.matchCase = message.matchCase
              session.wholeWord = message.wholeWord
              session.useRegex = message.useRegex
              scheduleRefresh(session, true)
            }
            return
          }
          if (message.type === 'ready') {
            void inset.webview.postMessage({
              type: 'setState',
              value: session.query,
              matchCase: session.matchCase ?? false,
              wholeWord: session.wholeWord ?? false,
              useRegex: session.useRegex ?? false,
            })
            if (focusInput) {
              void inset.webview.postMessage({ type: 'focus' })
            }
            return
          }
          if (message.type === 'focusEditor') {
            void vscode.commands.executeCommand(
              'workbench.action.focusActiveEditorGroup',
            )
            return
          }
          if (message.type === 'openSource') {
            void vscode.commands.executeCommand('editor-filter.openSource')
          }
        },
      )
      const disposeSubscription = inset.onDidDispose(() => {
        if (filterInsets.get(editor)?.inset === inset) {
          filterInsets.delete(editor)
        }
        messageSubscription.dispose()
        disposeSubscription.dispose()
      })
      context.subscriptions.push(
        inset,
        messageSubscription,
        disposeSubscription,
      )
      return true
    } catch (error) {
      output.appendLine(
        `Editor inset unavailable; falling back to Quick Input: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  const showSession = async (
    session: FilterSession,
    sourceVisibleLine?: number,
    focusFilterInput = false,
  ): Promise<boolean> => {
    const document = await vscode.workspace.openTextDocument(session.virtualUri)
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
    if (sourceVisibleLine !== undefined) {
      revealSourceLineAtTop(editor, session, sourceVisibleLine)
    }
    const hasInset = ensureFilterInset(editor, session, focusFilterInput)
    updateStatus()
    return hasInset
  }

  provider.setWriteHandler(async (uri, content) => {
    const session = sessions.get(sessionId(uri))
    if (!session) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }

    const plan = planProjectionSave(
      session.content,
      content,
      session.sourceRows,
    )
    if (!plan.ok) {
      void vscode.window.showErrorMessage(plan.message)
      throw vscode.FileSystemError.NoPermissions(plan.message)
    }

    const sourceDocuments = new Map<string, vscode.TextDocument>()
    for (const edit of plan.edits) {
      let document = sourceDocuments.get(edit.uri)
      if (!document) {
        document = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(edit.uri),
        )
        sourceDocuments.set(edit.uri, document)
      }
      if (
        edit.line >= document.lineCount ||
        document.lineAt(edit.line).text !== edit.before
      ) {
        const message = `Source changed since this result was projected: ${vscode.Uri.parse(edit.uri).fsPath}:${edit.line + 1}`
        void vscode.window.showErrorMessage(message)
        throw vscode.FileSystemError.Unavailable(message)
      }
    }

    if (plan.edits.length > 0) {
      session.suppressSourceRefreshUntil = Date.now() + 1_000
      const workspaceEdit = new vscode.WorkspaceEdit()
      for (const edit of plan.edits) {
        const document = sourceDocuments.get(edit.uri)!
        workspaceEdit.replace(
          document.uri,
          document.lineAt(edit.line).range,
          edit.after,
        )
      }
      if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
        throw vscode.FileSystemError.Unavailable(
          'VS Code could not apply the projected source edits.',
        )
      }
      for (const document of sourceDocuments.values()) {
        if (!(await document.save())) {
          throw vscode.FileSystemError.Unavailable(
            `Could not save ${document.uri.fsPath}`,
          )
        }
      }
    }

    session.content = content
    const savedLines = content.split(/\r?\n/)
    if (
      savedLines.length === session.sourceRows.length + 1 &&
      savedLines.at(-1) === ''
    ) {
      session.sourceRows.push(undefined)
    }
    session.state = 'ready'
    session.message = undefined
    const refreshAfterSave = session.refreshAfterSave ?? false
    session.refreshAfterSave = false
    await persist()
    if (plan.edits.length > 0) {
      void vscode.window.setStatusBarMessage(
        `Filter Lines: saved ${plan.edits.length} projected line${plan.edits.length === 1 ? '' : 's'} to ${sourceDocuments.size} file${sourceDocuments.size === 1 ? '' : 's'}`,
        3_000,
      )
    }
    if (refreshAfterSave) {
      setTimeout(() => scheduleRefresh(session, true), 0)
    }
  })

  context.subscriptions.push(
    provider,
    output,
    status,
    lineNumberDecoration,
    fileHeaderDecoration,
    {
      dispose: () => {
        for (const entry of finders.values()) {
          entry.unsubscribe?.()
          entry.finder.destroy()
        }
      },
    },
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
        const sourceVisibleLine =
          sourceEditor.visibleRanges[0]?.start.line ??
          sourceEditor.selection.active.line
        const session: FilterSession = {
          id,
          kind: 'file',
          sourceUri,
          query: initialQuery,
          languageId: sourceEditor.document.languageId,
          matchCase: false,
          wholeWord: false,
          useRegex: false,
          virtualUri: makeVirtualUri(id, sourceUri),
          content: '',
          sourceLines: [],
          sourceRows: [],
          headers: [],
          sourceLineCount: sourceEditor.document.lineCount,
          generation: 0,
          state: 'refreshing',
        }
        sessions.set(id, session)
        await refresh(session)
        const hasInset = await showSession(
          session,
          sourceVisibleLine,
          !initialQuery,
        )
        if (!initialQuery && !hasInset) {
          showFilterInput(session, sourceVisibleLine)
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
        const session: FilterSession = {
          id,
          kind: 'project',
          rootUri: workspaceFolder.uri.toString(),
          query: initialQuery,
          languageId: sourceDocument?.languageId ?? 'plaintext',
          matchCase: false,
          wholeWord: false,
          useRegex: false,
          virtualUri: makeVirtualUri(
            id,
            vscode.Uri.joinPath(workspaceFolder.uri, 'Project Search').toString(),
          ),
          content: '',
          sourceLines: [],
          sourceRows: [],
          headers: [],
          sourceLineCount: 1,
          generation: 0,
          state: 'refreshing',
        }
        sessions.set(id, session)
        await refresh(session)
        const hasInset = await showSession(session, undefined, !initialQuery)
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
      if (!ensureFilterInset(editor, session, true)) {
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
        if (session.sourceUri === event.document.uri.toString()) {
          scheduleRefresh(session)
        }
      }
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        for (const session of sessions.values()) {
          if (session.sourceUri === file.oldUri.toString()) {
            session.sourceUri = file.newUri.toString()
            scheduleRefresh(session, true)
          }
        }
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        for (const session of sessions.values()) {
          if (session.sourceUri === uri.toString()) {
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
            ensureFilterInset(editor, session, false)
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
  )

  for (const session of sessions.values()) {
    void refresh(session)
  }
  logState('extension activated')
}

function filterInsetHtml(
  webview: vscode.Webview,
  session: FilterSession,
  focusInput: boolean,
): string {
  const nonce = randomUUID().replaceAll('-', '')
  const initialState = JSON.stringify({
    query: session.query,
    focusInput,
    matchCase: session.matchCase ?? false,
    wholeWord: session.wholeWord ?? false,
    useRegex: session.useRegex ?? false,
  }).replaceAll('<', '\\u003c')
  const placeholder =
    session.kind === 'project'
      ? 'Search project with fff'
      : 'Filter lines in this file'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    html, body { height: 100%; }
    body {
      margin: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font: 13px var(--vscode-font-family);
    }
    .filter-row {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 100%;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
    }
    label {
      flex: none;
      color: var(--vscode-editorLineNumber-foreground);
      user-select: none;
    }
    .input-shell {
      box-sizing: border-box;
      width: min(720px, 100%);
      height: 26px;
      display: flex;
      align-items: center;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      background: var(--vscode-input-background);
    }
    .input-shell:focus-within { border-color: var(--vscode-focusBorder); }
    input {
      box-sizing: border-box;
      min-width: 0;
      height: 24px;
      flex: 1;
      padding: 3px 8px;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .options {
      height: 100%;
      display: flex;
      align-items: center;
      gap: 1px;
      padding-right: 2px;
    }
    button {
      box-sizing: border-box;
      width: 23px;
      height: 21px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 2px;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font: 11px var(--vscode-font-family);
      cursor: pointer;
    }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:focus-visible { border-color: var(--vscode-focusBorder); }
    button.active {
      border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
      background: var(--vscode-inputOption-activeBackground);
      color: var(--vscode-inputOption-activeForeground);
    }
    .whole-word { text-decoration: underline; text-underline-offset: 2px; }
  </style>
</head>
<body>
  <div class="filter-row">
    <label for="query">Filter</label>
    <div class="input-shell">
      <input id="query" type="text" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="options" aria-label="Search options">
        <button type="button" data-option="matchCase" title="Match Case" aria-label="Match Case" aria-pressed="false">Aa</button>
        <button type="button" data-option="wholeWord" title="Match Whole Word" aria-label="Match Whole Word" aria-pressed="false"><span class="whole-word">ab</span></button>
        <button type="button" data-option="useRegex" title="Use Regular Expression" aria-label="Use Regular Expression" aria-pressed="false">.*</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const initialState = ${initialState}
    const input = document.getElementById('query')
    const optionButtons = [...document.querySelectorAll('[data-option]')]
    const options = {
      matchCase: initialState.matchCase,
      wholeWord: initialState.wholeWord,
      useRegex: initialState.useRegex,
    }
    input.value = initialState.query

    const renderOptions = () => {
      for (const button of optionButtons) {
        const active = options[button.dataset.option]
        button.classList.toggle('active', active)
        button.setAttribute('aria-pressed', String(active))
      }
    }
    const emitOptions = () => {
      vscode.postMessage({ type: 'options', ...options })
    }
    for (const button of optionButtons) {
      button.addEventListener('click', () => {
        const option = button.dataset.option
        options[option] = !options[option]
        renderOptions()
        emitOptions()
        input.focus()
      })
    }
    renderOptions()

    input.addEventListener('input', () => {
      vscode.postMessage({ type: 'query', value: input.value })
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' || (event.key === 'Enter' && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault()
        vscode.postMessage({ type: 'focusEditor' })
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        vscode.postMessage({ type: 'openSource' })
      }
    })
    window.addEventListener('message', event => {
      const message = event.data
      if (message.type === 'setState') {
        if (input.value !== message.value) {
          input.value = message.value
          input.setSelectionRange(input.value.length, input.value.length)
        }
        options.matchCase = message.matchCase
        options.wholeWord = message.wholeWord
        options.useRegex = message.useRegex
        renderOptions()
      } else if (message.type === 'focus') {
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
      }
    })
    vscode.postMessage({ type: 'ready' })
    if (initialState.focusInput) {
      input.focus()
    }
  </script>
</body>
</html>`
}

function fffGrepQuery(session: FilterSession): {
  query: string
  mode: 'plain' | 'regex'
  smartCase: boolean
} {
  const matchCase = session.matchCase ?? false
  const wholeWord = session.wholeWord ?? false
  const useRegex = session.useRegex ?? false

  if (!wholeWord && !useRegex) {
    return {
      query: matchCase ? session.query : session.query.toLocaleLowerCase(),
      mode: 'plain',
      smartCase: !matchCase,
    }
  }

  let pattern = useRegex ? session.query : escapeRegExp(session.query)
  if (wholeWord) {
    pattern = `\\b(?:${pattern})\\b`
  }
  if (!matchCase) {
    pattern = `(?i:${pattern})`
  }
  return { query: pattern, mode: 'regex', smartCase: false }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function activeSession(
  sessions: Map<string, FilterSession>,
): FilterSession | undefined {
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

export function deactivate(): void {}
