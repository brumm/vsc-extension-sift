import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { FilterQuery } from './projection-document';
import { ProjectionSession } from './projection-sessions';

interface FilterInsetEntry {
	sessionId: string;
	inset: vscode.WebviewEditorInset;
}

export interface ProjectionFilterInsetCallbacks {
	onFilterChanged(session: ProjectionSession, filter: FilterQuery): void;
	onOpenSource(): void;
	onUnavailable(message: string): void;
}

export class ProjectionFilterInsets implements vscode.Disposable {
	private readonly entries = new Map<vscode.TextEditor, FilterInsetEntry>();

	constructor(private readonly callbacks: ProjectionFilterInsetCallbacks) {}

	ensure(
		editor: vscode.TextEditor,
		session: ProjectionSession,
		focusInput: boolean,
	): boolean {
		const existing = this.entries.get(editor);
		if (existing?.sessionId === session.id) {
			this.sync(session);
			if (focusInput) {
				void existing.inset.webview.postMessage({ type: 'focus' });
			}
			return true;
		}
		existing?.inset.dispose();

		if (typeof vscode.window.createWebviewTextEditorInset !== 'function') {
			return false;
		}

		try {
			const firstVisibleLine = editor.visibleRanges[0]?.start.line ?? 0;
			const inset = vscode.window.createWebviewTextEditorInset(
				editor,
				firstVisibleLine - 1,
				2,
				{ enableScripts: true },
			);
			this.entries.set(editor, { sessionId: session.id, inset });
			inset.webview.html = filterInsetHtml(inset.webview, session, focusInput);

			const messageSubscription = inset.webview.onDidReceiveMessage(
				(message: unknown) => this.receiveMessage(
					message,
					session,
					inset,
					focusInput,
				),
			);
			const disposeSubscription = inset.onDidDispose(() => {
				if (this.entries.get(editor)?.inset === inset) {
					this.entries.delete(editor);
				}
				messageSubscription.dispose();
				disposeSubscription.dispose();
			});
			return true;
		} catch (error) {
			this.callbacks.onUnavailable(
				`Editor inset unavailable; falling back to Quick Input: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
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
				});
			}
		}
	}

	dispose(): void {
		for (const entry of [...this.entries.values()]) {
			entry.inset.dispose();
		}
		this.entries.clear();
	}

	private receiveMessage(
		message: unknown,
		session: ProjectionSession,
		inset: vscode.WebviewEditorInset,
		focusInput: boolean,
	): void {
		if (!message || typeof message !== 'object' || !('type' in message)) {
			return;
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
				});
			}
			return;
		}
		if (
			message.type === 'options' &&
			'matchCase' in message &&
			typeof message.matchCase === 'boolean' &&
			'wholeWord' in message &&
			typeof message.wholeWord === 'boolean' &&
			'useRegex' in message &&
			typeof message.useRegex === 'boolean'
		) {
			this.callbacks.onFilterChanged(session, {
				...session.filter,
				matchCase: message.matchCase,
				wholeWord: message.wholeWord,
				useRegex: message.useRegex,
			});
			return;
		}
		if (message.type === 'ready') {
			this.sync(session);
			if (focusInput) {
				void inset.webview.postMessage({ type: 'focus' });
			}
			return;
		}
		if (message.type === 'focusEditor') {
			void vscode.commands.executeCommand(
				'workbench.action.focusActiveEditorGroup',
			);
			return;
		}
		if (message.type === 'openSource') {
			this.callbacks.onOpenSource();
		}
	}
}

function filterInsetHtml(
	webview: vscode.Webview,
	session: ProjectionSession,
	focusInput: boolean,
): string {
	const nonce = randomUUID().replaceAll('-', '');
	const initialState = JSON.stringify({
		query: session.filter.text,
		focusInput,
		matchCase: session.filter.matchCase,
		wholeWord: session.filter.wholeWord,
		useRegex: session.filter.useRegex,
	}).replaceAll('<', '\\u003c');
	const placeholder = session.target.kind === 'project'
		? 'Search project with fff'
		: 'Filter lines in this file';

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    html, body { height: 100%; }
    body { margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font: 13px var(--vscode-font-family); }
    .filter-row { box-sizing: border-box; display: flex; align-items: center; gap: 8px; height: 100%; padding: 4px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
    label { flex: none; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
    .input-shell { box-sizing: border-box; width: min(720px, 100%); height: 26px; display: flex; align-items: center; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; background: var(--vscode-input-background); }
    .input-shell:focus-within { border-color: var(--vscode-focusBorder); }
    input { box-sizing: border-box; min-width: 0; height: 24px; flex: 1; padding: 3px 8px; border: 0; outline: none; background: transparent; color: var(--vscode-input-foreground); font: inherit; }
    input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .options { height: 100%; display: flex; align-items: center; gap: 1px; padding-right: 2px; }
    button { box-sizing: border-box; width: 23px; height: 21px; padding: 0; border: 1px solid transparent; border-radius: 2px; outline: none; background: transparent; color: var(--vscode-input-foreground); font: 11px var(--vscode-font-family); cursor: pointer; }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:focus-visible { border-color: var(--vscode-focusBorder); }
    button.active { border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder)); background: var(--vscode-inputOption-activeBackground); color: var(--vscode-inputOption-activeForeground); }
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
    const options = { matchCase: initialState.matchCase, wholeWord: initialState.wholeWord, useRegex: initialState.useRegex }
    input.value = initialState.query
    const renderOptions = () => {
      for (const button of optionButtons) {
        const active = options[button.dataset.option]
        button.classList.toggle('active', active)
        button.setAttribute('aria-pressed', String(active))
      }
    }
    const emitOptions = () => vscode.postMessage({ type: 'options', ...options })
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
    input.addEventListener('input', () => vscode.postMessage({ type: 'query', value: input.value }))
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
    if (initialState.focusInput) input.focus()
  </script>
</body>
</html>`;
}
