import { randomUUID } from 'node:crypto'
import caseSensitiveIcon from 'sift-codicon:case-sensitive'
import regexIcon from 'sift-codicon:regex'
import searchIcon from 'sift-codicon:search'
import wholeWordIcon from 'sift-codicon:whole-word'
import * as vscode from 'vscode'
import { FilterQuery } from './projection-document'
import insetTemplate from './projection-filter-inset.html'
import { ProjectionSession } from './projection-sessions'

const beforeFirstDocumentLine = -1
const filterOptionButtonsHtml = [
  {
    option: 'matchCase',
    title: 'Match Case',
    codicon: 'case-sensitive',
    icon: caseSensitiveIcon,
  },
  {
    option: 'wholeWord',
    title: 'Match Whole Word',
    codicon: 'whole-word',
    icon: wholeWordIcon,
  },
  {
    option: 'useRegex',
    title: 'Use Regular Expression',
    codicon: 'regex',
    icon: regexIcon,
  },
]
  .map(
    ({ option, title, codicon, icon }) =>
      `<button type="button" data-option="${option}" title="${title}" aria-label="${title}" aria-pressed="false"><span class="codicon codicon-${codicon}" aria-hidden="true">${icon}</span></button>`,
  )
  .join('')

interface FilterInsetEntry {
  sessionId: string
  inset: vscode.WebviewEditorInset
}

export interface ProjectionFilterInsetCallbacks {
  onFilterChanged(session: ProjectionSession, filter: FilterQuery): void
  onOpenSource(): void
  onSearchProject(session: ProjectionSession, filter: FilterQuery): void
  onUnavailable(message: string): void
}

export class ProjectionFilterInsets implements vscode.Disposable {
  private readonly entries = new Map<vscode.TextEditor, FilterInsetEntry>()

  constructor(private readonly callbacks: ProjectionFilterInsetCallbacks) {}

  ensure(
    editor: vscode.TextEditor,
    session: ProjectionSession,
    focusInput: boolean,
  ): boolean {
    const existing = this.entries.get(editor)
    if (existing?.sessionId === session.id) {
      this.sync(session)
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
      const inset = vscode.window.createWebviewTextEditorInset(
        editor,
        beforeFirstDocumentLine,
        1.5,
        { enableScripts: true },
      )
      this.entries.set(editor, { sessionId: session.id, inset })
      inset.webview.html = filterInsetHtml(session, focusInput)

      const messageSubscription = inset.webview.onDidReceiveMessage(
        (message: unknown) =>
          this.receiveMessage(message, editor, session, inset, focusInput),
      )
      const disposeSubscription = inset.onDidDispose(() => {
        if (this.entries.get(editor)?.inset === inset) {
          this.entries.delete(editor)
        }
        messageSubscription.dispose()
        disposeSubscription.dispose()
      })
      return true
    } catch (error) {
      this.callbacks.onUnavailable(
        `Editor inset unavailable; falling back to Quick Input: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  sync(session: ProjectionSession): void {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === session.id) {
        void entry.inset.webview.postMessage({
          type: 'setState',
          value: session.filter.text,
          matchCase: session.filter.matchCase,
          wholeWord: session.filter.wholeWord,
          useRegex: session.filter.useRegex,
        })
      }
    }
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      entry.inset.dispose()
    }
    this.entries.clear()
  }

  private receiveMessage(
    message: unknown,
    editor: vscode.TextEditor,
    session: ProjectionSession,
    inset: vscode.WebviewEditorInset,
    focusInput: boolean,
  ): void {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return
    }
    if (
      message.type === 'query' &&
      'value' in message &&
      typeof message.value === 'string'
    ) {
      if (session.filter.text !== message.value) {
        this.callbacks.onFilterChanged(session, {
          ...session.filter,
          text: message.value,
        })
      }
      return
    }
    if (message.type === 'options') {
      const filter = readFilterQuery(message, session.filter.text)
      if (filter) {
        this.callbacks.onFilterChanged(session, filter)
      }
      return
    }
    if (message.type === 'ready') {
      this.sync(session)
      if (focusInput) {
        void inset.webview.postMessage({ type: 'focus' })
      }
      return
    }
    if (message.type === 'focusEditor') {
      void vscode.commands
        .executeCommand('workbench.action.focusActiveEditorGroup')
        .then(() => {
          const documentStart = new vscode.Position(0, 0)
          editor.selection = new vscode.Selection(documentStart, documentStart)
          editor.revealRange(new vscode.Range(documentStart, documentStart))
        })
      return
    }
    if (message.type === 'openSource') {
      this.callbacks.onOpenSource()
      return
    }
    if (message.type === 'searchProject' && 'value' in message) {
      const filter = typeof message.value === 'string'
        ? readFilterQuery(message, message.value)
        : undefined
      if (filter) {
        this.callbacks.onSearchProject(session, filter)
      }
    }
  }
}

function readFilterQuery(message: object, text: string): FilterQuery | undefined {
  if (
    'matchCase' in message &&
    typeof message.matchCase === 'boolean' &&
    'wholeWord' in message &&
    typeof message.wholeWord === 'boolean' &&
    'useRegex' in message &&
    typeof message.useRegex === 'boolean'
  ) {
    return {
      text,
      matchCase: message.matchCase,
      wholeWord: message.wholeWord,
      useRegex: message.useRegex,
    }
  }
  return undefined
}

function filterInsetHtml(
  session: ProjectionSession,
  focusInput: boolean,
): string {
  const nonce = randomUUID().replaceAll('-', '')
  const initialState = JSON.stringify({
    query: session.filter.text,
    focusInput,
    matchCase: session.filter.matchCase,
    wholeWord: session.filter.wholeWord,
    useRegex: session.filter.useRegex,
  }).replaceAll('<', '\\u003c')
  const placeholder =
    session.target.kind === 'project' ? 'Search project' : 'Filter lines'
  const projectSearchButton = session.target.kind === 'file'
    ? `<button type="button" data-action="search-project" title="Search in Project" aria-label="Search in Project"><span class="codicon codicon-search" aria-hidden="true">${searchIcon}</span></button>`
    : ''

  return insetTemplate
    .replaceAll('__SIFT_NONCE__', nonce)
    .replaceAll('__SIFT_PLACEHOLDER__', placeholder)
    .replace('__SIFT_OPTION_BUTTONS__', filterOptionButtonsHtml)
    .replace('__SIFT_PROJECT_SEARCH_BUTTON__', projectSearchButton)
    .replace('__SIFT_INITIAL_STATE__', initialState)
}
