# Sift

Sift creates focused, editable views of matching lines in an editor or across a project. Each result stays mapped to its source, so changes can be saved back without leaving the sifted view.

- Sift the active editor or the entire project from the Command Palette.
- Sift workspace paths, edit matching names, and save to move or rename files.
- Review and edit working-tree changes against the current commit with **Sift: Diff**.
- Choose a local branch, remote branch, or tag with **Sift: Diff Against…**.
- Refine results from an inline query input with match-case, whole-word, and regular-expression options.
- Include up to five surrounding context lines while highlighting only the actual matches.
- Scope project queries with leading path constraints such as `*.ts`, `src/`, and `!test/`.
- Edit existing result lines and save the changes back to their source files.
- Open the mapped source location with **Cmd+Enter** or the editor status item.
- Keep sifted views open across window reloads and source-file updates.

Diff views include staged and unstaged tracked changes, untracked files as additions, renames, and read-only deleted-line annotations. Leading FFF path constraints filter changed files. Remaining query text filters current-side changed lines. The default base is the current `HEAD` commit.

## Local setup

After installing dependencies, run `pnpm run install-local` once and restart VS Code. The script links this checkout into VS Code's extension directory and adds Sift to the existing `enable-proposed-api` runtime argument without replacing other settings. On macOS, current VS Code releases read this file from `~/.vscode/argv.json`.
