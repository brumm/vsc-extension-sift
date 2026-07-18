# Line Filter — throwaway VS Code prototype

This prototype asks whether a writable in-memory `FileSystemProvider` can make single-file filters and project-wide `fff` results behave like native editable VS Code documents. The current question is whether native dirty state, undo/redo, and save can safely translate edits from non-contiguous projected rows back into one or more source files. It is also testing refresh anchoring, file-boundary and source-line annotations, source navigation, syntax coloring without omitted context, and session/tab behavior across restart. It is not production code.

## Run

```sh
pnpm run prototype
```

In the Extension Development Host window:

1. Open any local source file.
2. Optionally select some text, then run **Filter Lines: Filter This File** from the Command Palette. The first selection becomes the initial filter. The virtual editor inherits the source editor's vertical scroll position; with no selection, it shows the complete source and immediately opens the live filter input.
3. In the filtered editor, run **Filter Lines: Change Filter** and type to narrow the file live.
4. Press **Cmd+Enter** or click the status-bar location to close the filtered tab and open the selected source line in its place.
5. Edit an existing result row and press **Cmd+S**. The projected tab uses native dirty state, then applies and saves the corresponding source-line edit.
6. Run **Filter Lines: Show Prototype State** to inspect the session and complete row mapping.

For the multi-file experiment, run **Filter Lines: Search Project with fff**. The selected text becomes the initial query; without a selection, the virtual editor opens immediately with the live search input. Results are grouped beneath decorated workspace-relative file headers. Edit result rows from one or more files and press **Cmd+S** to apply them as one workspace edit and save every affected source document. Press **Cmd+Enter** on a result or its file header to close the search editor and open the mapped source location.

## Experiments

- Put the filtered view in two split groups. Give each a different cursor/scroll position, then change the query or edit the source without saving.
- Add multiple selections before changing the query.
- Try wrapping, zoom, several fonts/themes, copying lines, and a screen reader. Source numbers are decorations, not document text.
- Filter inside multiline comments, strings, template literals, and embedded languages to judge TextMate coloring.
- Leave a filtered tab open, close the Development Host, rerun `pnpm run prototype`, and observe whether the tab and session recover. Activation currently uses `onStartupFinished`; this is deliberately part of the experiment.
- Rename or delete the source and inspect the result and **Show Prototype State** output.
- Search a term shared by several file types and judge whether the initiating editor's language grammar is an acceptable best-effort presentation.
- Save a matching source file while project results are open and observe the `fff` watcher refresh the projection.
- Edit two result rows from different files, save the projection, and verify both source files changed.
- Try inserting a newline, deleting a projected row, or editing a blank file-boundary row; save must be rejected without changing any source file.
- Change a source line after it was projected, then edit the corresponding result and save; the stale-source conflict must be rejected.

## Expected limitations

- Only the text of existing mapped result rows is editable. Inserting/deleting rows and editing annotation rows is rejected on save.
- A dirty projection must be saved before changing its filter. If the query changes while dirty, the pending refresh runs after save.
- Saving a projection also saves each affected source document, including any unrelated unsaved changes already present in those documents.
- Source files are conflict-checked line by line before the workspace edit, but this throwaway prototype does not roll back if an individual source-document save fails afterward.
- Single-file filtering uses literal, case-insensitive matching. Project search uses `fff` plain mode with smart case and supports its path constraints.
- Source numbers cannot occupy VS Code's native gutter and may not be announced by screen readers.
- Syntax highlighting is best effort; omitted lexical context can produce incorrect coloring.
- A virtual document has one language ID, so mixed-language project results use the language of the editor from which search was invoked.
- Project search reflects files indexed on disk; unsaved editor changes are not part of the `fff` index.
- The project-search prototype displays at most the first 1,000 matches and does not yet expose pagination.
- Empty queries show the whole source file, so live filtering starts with useful context.

## Verdict notes

After trying the experiments, record what felt acceptable or broken here before deleting or replacing the prototype:

- Refresh anchoring:
- Line-number presentation/accessibility:
- Syntax fidelity:
- Restart restoration:
- Overall decision:
