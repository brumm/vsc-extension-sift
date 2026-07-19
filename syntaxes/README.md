# Grammar-only TypeScript support

The private Sift TypeScript language IDs reuse VS Code's built-in `source.ts`
and `source.tsx` TextMate grammars without activating its TypeScript language
service. The wrappers intentionally provide no copied language configuration or
grammar metadata: projected editors favor low maintenance over full TypeScript
editing behavior.
