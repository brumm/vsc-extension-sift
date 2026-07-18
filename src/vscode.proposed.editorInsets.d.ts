/* PROTOTYPE — VS Code 1.129.1 proposed editorInsets API. */
declare module 'vscode' {
  export interface WebviewEditorInset {
    readonly editor: TextEditor
    readonly line: number
    readonly height: number
    readonly webview: Webview
    readonly onDidDispose: Event<void>
    dispose(): void
  }

  export namespace window {
    export function createWebviewTextEditorInset(
      editor: TextEditor,
      line: number,
      height: number,
      options?: WebviewOptions,
    ): WebviewEditorInset
  }
}
