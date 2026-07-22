# Sift

Sift creates focused, editable views of matching lines in an editor or across a project. Each result stays mapped to its source, so changes can be saved back without leaving the sifted view.

- Sift the active editor or the entire project from the Command Palette.
- Refine results from an inline query input with match-case, whole-word, and regular-expression options.
- Include up to five surrounding context lines while highlighting only the actual matches.
- Scope project queries with leading path constraints such as `*.ts`, `src/`, and `!test/`.
- Edit existing result lines and save the changes back to their source files.
- Open the mapped source location with **Cmd+Enter** or the editor status item.
- Keep sifted views open across window reloads and source-file updates.

## Local setup

After installing dependencies, run `pnpm run enable-proposed-api` once and restart VS Code. The script adds Sift to VS Code's existing `enable-proposed-api` runtime argument without replacing other settings.
