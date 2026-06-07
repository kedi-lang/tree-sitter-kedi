# tree-sitter-kedi

Tree-sitter grammar for the [Kedi](https://github.com/kedi-lang/kedi) DSL.

This package replaces Kedi's previous hand-written parser with a tree-sitter
generated parser, enabling:

- Editor syntax highlighting (`queries/highlights.scm`)
- Scope-aware LSP features (`queries/locals.scm`)
- Embedded Python highlighting inside fenced and backtick regions
  (`queries/injections.scm`)
- Incremental parsing for editor performance
- Rich error spans with line/column information

## Development

Generating the parser from `grammar.js`:

```sh
npm install              # installs tree-sitter-cli locally
npm run generate         # writes src/parser.c
npm test                 # runs corpus tests in test/corpus/
```

The generated `src/parser.c`, `src/grammar.json`, and `src/node-types.json`
are committed so downstream editor extensions can consume a pinned revision
without requiring code generation.

## Python consumption

Built as a Python wheel via `setuptools`:

```sh
uv sync --dev
uv run python -c "import tree_sitter_kedi; from tree_sitter import Language, Parser; \
           Parser(Language(tree_sitter_kedi.language()))"
```

## Layout

- `grammar.js` — grammar rules
- `src/scanner.c` — external scanner (indent stack, fenced blocks, line continuation)
- `src/parser.c` — generated; vendored so consumers don't need the CLI
- `queries/` — highlight / locals / injection queries for editors
- `bindings/python/` — Python C extension exposing `language()`
- `test/corpus/` — tree-sitter test framework cases
