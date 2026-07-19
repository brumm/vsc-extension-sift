# Grammar-only TypeScript support

The private Sift TypeScript language IDs reuse VS Code's built-in `source.ts`
and `source.tsx` TextMate grammars without activating its TypeScript language
service. `typescript-language-configuration.json` and the grammar metadata in
`package.json` mirror VS Code's `typescript-basics` extension (MIT licensed) and
should be kept in sync when that built-in configuration changes.
