import { randomUUID } from 'node:crypto'
import caseSensitiveIcon from 'sift-codicon:case-sensitive'
import regexIcon from 'sift-codicon:regex'
import searchIcon from 'sift-codicon:search'
import wholeWordIcon from 'sift-codicon:whole-word'
import * as vscode from 'vscode'
import {
  FilterQuery,
  maximumContextLines,
} from './projection-document'
import insetTemplate from './projection-filter-inset.html'
import { ProjectionSession } from './projection-sessions'

const beforeFirstDocumentLine = -1

interface FilterInsetEntry {
  sessionId: string
  inset: vscode.WebviewEditorInset
  focusInput: boolean
}

export interface ProjectionFilterInsetCallbacks {
  onFilterChanged(session: ProjectionSession, filter: FilterQuery): void
  onClose(session: ProjectionSession): void
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
      existing.focusInput ||= focusInput
      this.sync(session)
      if (focusInput) {
        void existing.inset.webview.postMessage({
          type: 'focus',
          selectAll: session.filter.text.length > 0,
        })
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
      const entry = { sessionId: session.id, inset, focusInput }
      this.entries.set(editor, entry)
      const messageSubscription = inset.webview.onDidReceiveMessage(
        (message: unknown) =>
          this.receiveMessage(message, editor, session, inset, entry),
      )
      inset.webview.html = filterInsetHtml(session, focusInput)

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
          contextLines: session.filter.contextLines,
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
    entry: FilterInsetEntry,
  ): void {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return
    }
    switch (message.type) {
      case 'query': {
        if ('value' in message && typeof message.value === 'string') {
          if (session.filter.text !== message.value) {
            this.callbacks.onFilterChanged(session, {
              ...session.filter,
              text: message.value,
            })
          }
        }
        return
      }
      case 'options': {
        const filter = readFilterQuery(message, session.filter.text)
        if (filter) {
          this.callbacks.onFilterChanged(session, filter)
        }
        return
      }
      case 'ready': {
        this.sync(session)
        if (entry.focusInput) {
          void inset.webview.postMessage({
            type: 'focus',
            selectAll: session.filter.text.length > 0,
          })
        }
        return
      }
      case 'focusEditor': {
        const documentStart = new vscode.Position(0, 0)
        editor.selection = new vscode.Selection(documentStart, documentStart)
        editor.revealRange(new vscode.Range(documentStart, documentStart))
        vscode.commands.executeCommand(
          'workbench.action.focusActiveEditorGroup',
        )
        return
      }
      case 'openSource':
        this.callbacks.onOpenSource()
        return
      case 'closeEditor':
        this.callbacks.onClose(session)
        return
      case 'searchProject': {
        const filter =
          'value' in message && typeof message.value === 'string'
            ? readFilterQuery(message, message.value)
            : undefined
        if (filter) {
          this.callbacks.onSearchProject(session, filter)
        }
        return
      }
    }
  }
}

function readFilterQuery(
  message: object,
  text: string,
): FilterQuery | undefined {
  if (
    'matchCase' in message &&
    typeof message.matchCase === 'boolean' &&
    'wholeWord' in message &&
    typeof message.wholeWord === 'boolean' &&
    'useRegex' in message &&
    typeof message.useRegex === 'boolean' &&
    'contextLines' in message &&
    typeof message.contextLines === 'number' &&
    Number.isInteger(message.contextLines) &&
    message.contextLines >= 0 &&
    message.contextLines <= maximumContextLines
  ) {
    return {
      text,
      matchCase: message.matchCase,
      wholeWord: message.wholeWord,
      useRegex: message.useRegex,
      contextLines: message.contextLines,
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
    contextLines: session.filter.contextLines,
    maximumContextLines,
  }).replaceAll('<', '\\u003c')
  const placeholder =
    session.target.kind === 'project'
      ? 'Sift Project'
      : session.target.kind === 'paths'
        ? 'Sift Paths'
        : 'Sift Editor'
  const projectSearchButton =
    session.target.kind === 'file'
      ? `<button type="button" data-action="search-project" title="Sift Project" aria-label="Sift Project"><span class="codicon codicon-search" aria-hidden="true">${searchIcon}</span></button>`
      : ''

  return insetTemplate
    .replaceAll('__SIFT_NONCE__', nonce)
    .replaceAll('__SIFT_BODY_CLASS__', session.target.kind === 'paths' ? 'query-only' : '')
    .replaceAll('__SIFT_PLACEHOLDER__', placeholder)
    .replace('__SIFT_CASE_SENSITIVE_ICON__', caseSensitiveIcon)
    .replace('__SIFT_WHOLE_WORD_ICON__', wholeWordIcon)
    .replace('__SIFT_REGEX_ICON__', regexIcon)
    .replace('__SIFT_PROJECT_SEARCH_BUTTON__', projectSearchButton)
    .replace('__SIFT_INITIAL_STATE__', initialState)
}
