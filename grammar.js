/**
 * @file Kedi grammar for tree-sitter
 * @author Doğukan Yiğit Polat <yigit@neurograph.net>
 * @author Mert Sırakaya <mert@kedi-lang.org>
 * @license Apache-2.0
 *
 * Kedi is a typed DSL for LLM orchestration.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "kedi",

  // `template_block_stmt` continuation lines and `[name] = …` assignments
  // share a `[` prefix; disambiguation needs the `=` after the target.
  conflicts: ($) => [[$.template_block_stmt]],

  // IMPORTANT: this list's order must match `enum TokenType` in src/scanner.c.
  //
  // Single-backtick and triple-backtick are NOT externals: tree-sitter's
  // internal lexer handles them as literal tokens (`` ` `` and `` ``` ``)
  // and its longest-match rule selects the triple form wherever three
  // consecutive backticks appear. Doing the discrimination here instead
  // of in the scanner avoids the well-known "advances during a failed
  // external scan are not rewound" problem.
  //
  // `_fenced_newline` is like `_newline` but does NOT update the indent
  // stack; it is emitted between an opening "```" and the fenced body
  // so the body's leading indent is not mistaken for a real block
  // indent that would later trigger a spurious DEDENT.
  externals: ($) => [
    $._newline,
    $._indent,
    $._dedent,
    $._text,
    $._text_in_call,
    $._fenced_body,
    $._fenced_newline,
    $._system_angle_segment,
  ],

  // Extras run between tokens. We include:
  //
  //   - `block_comment` (`###`-delimited multi-line). Body matches any
  //     char-sequence that does not contain three consecutive `#`s: each
  //     character is either non-`#`, `#` followed by non-`#`, or `##`
  //     followed by non-`#` — the standard "everything except the
  //     closing fence" trick.
  //   - `line_comment` (single `#` to EOL).
  //   - `[ \t]` for horizontal whitespace.
  //   - `\n` so tree-sitter can fill the "gap" left when the external
  //     scanner advances past blank lines during NEWLINE indent-peek.
  //     The external NEWLINE token still wins when valid_symbols asks
  //     for it (externals run before extras), so newline significance
  //     for statement termination is preserved; this only matters when
  //     the scanner has already committed advances past one or more
  //     `\n`s during exploratory peek and tree-sitter needs to skip
  //     those bytes between the emitted NEWLINE token and the next
  //     real token.
  extras: ($) => [$.block_comment, $.line_comment, /[ \t]/, /\n/],

  word: ($) => $.identifier,

  // Because ``test_block`` and ``eval_block`` share an identical
  // ``@<id>:<id>:`` prefix (the kw is matched as a generic
  // ``$.identifier``, not a keyword — see the rule comments), tree-sitter
  // needs to keep both parse stacks alive until the inner directive
  // (``> case:`` vs ``> data:`` / ``> metric:``) decides which one wins.
  // Supertypes group related alternatives so the resulting node types are
  // easier to consume from the Python CST→AST walker.
  supertypes: ($) => [$._stmt, $._segment, $._top_item, $._type_expr_term],

  rules: {
    // ============================================================
    // Top level
    // ============================================================
    source_file: ($) => repeat(choice($._top_item, $._newline)),

    _top_item: ($) =>
      choice(
        $.procedure_def,
        $.type_def,
        $.package_directive,
        $.module_import,
        $.module_export,
        $.validation_block,
        $.agent_directive,
        $.adapter_directive,
        $.model_directive,
        $.effort_directive,
        $.approval_directive,
        $.history_directive,
        $.system_directive,
        $.mcp_directive,
        $.settings_directive,
        $.artifacts_directive,
        $.profile_directive,
        $.use_directive,
        $.assign_stmt,
        $.assign_block_stmt,
        $.raw_invoke_stmt,
        $.return_stmt,
        $.return_block_stmt,
        $.python_block,
        $.backtick_line_stmt,
        $.template_block_stmt,
        $.template_line,
      ),

    package_directive: ($) =>
      seq(
        ">",
        "package",
        ":",
        field("name", $.identifier),
        ":",
        $._newline,
        field("body", $.package_body),
      ),

    package_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.package_field, $.package_python_dependencies, $._newline)),
        $._dedent,
      ),

    package_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        optional(/[ \t]+/),
        field("value", alias($._package_plain_value, $.package_plain_value)),
        $._newline,
      ),

    package_python_dependencies: ($) =>
      seq(
        "python_dependencies",
        ":",
        $._newline,
        field("body", $.package_dependency_body),
      ),

    package_dependency_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.package_dependency, $._newline)),
        $._dedent,
      ),

    package_dependency: ($) =>
      seq(
        field("value", alias($._package_dependency_value, $.package_dependency_value)),
        $._newline,
      ),

    _package_plain_value: ($) => token(/[^\n#]+/),

    _package_dependency_value: ($) => token(/[^\n#]+/),

    module_import: ($) =>
      choice(
        seq(
          ">",
          "import",
          ":",
          field("module", $.module_path),
          $._newline,
        ),
        seq(
          ">",
          "import",
          ":",
          field("module", $.module_path),
          ":",
          $._newline,
          field("body", $.module_import_body),
        ),
      ),

    module_path: ($) => seq($.identifier, repeat(seq("/", $.identifier))),

    module_import_body: ($) =>
      seq($._indent, repeat1(choice($.module_import_name, $._newline)), $._dedent),

    module_import_name: ($) => seq(field("name", $.identifier), $._newline),

    module_export: ($) =>
      choice(
        seq(
          ">",
          "export",
          ":",
          "*",
          $._newline,
        ),
        seq(
          ">",
          "export",
          ":",
          $._newline,
          field("body", $.module_export_body),
        ),
      ),

    module_export_body: ($) =>
      seq($._indent, repeat1(choice($.module_export_name, $._newline)), $._dedent),

    module_export_name: ($) => seq(field("name", $.identifier), $._newline),

    // ============================================================
    // Procedures
    // ============================================================
    procedure_def: ($) =>
      seq(
        "@",
        field("name", $.identifier),
        "(",
        optional(field("params", $.param_list)),
        ")",
        optional(seq("->", field("return_type", $.type_expr))),
        ":",
        $._newline,
        field("body", $.block),
      ),

    param_list: ($) => sep1($.param, ","),

    param: ($) =>
      seq(
        field("name", $.identifier),
        optional(seq(":", field("type", $.type_expr))),
        optional(seq("=", field("default", $.inline_python_expr))),
      ),

    block: ($) =>
      seq($._indent, repeat1(choice($._stmt, $._newline)), $._dedent),

    _stmt: ($) =>
      choice(
        $.procedure_def,
        $.type_def_stmt,
        $.auto_directive,
        $.optimize_directive,
        $.agent_directive,
        $.adapter_directive,
        $.model_directive,
        $.effort_directive,
        $.approval_directive,
        $.history_directive,
        $.system_directive,
        $.mcp_directive,
        $.settings_directive,
        $.artifacts_directive,
        $.use_directive,
        $.assign_stmt,
        $.assign_block_stmt,
        $.raw_invoke_stmt,
        $.return_stmt,
        $.return_block_stmt,
        $.python_block,
        $.backtick_line_stmt,
        $.template_block_stmt,
        $.template_line,
      ),

    // ============================================================
    // Type definitions
    // ============================================================
    type_def: ($) =>
      seq(
        "~",
        field("name", $.identifier),
        "(",
        optional(field("fields", $.type_field_list)),
        ")",
        $._newline,
      ),

    type_def_stmt: ($) => $.type_def,

    type_field_list: ($) => sep1($.type_field, ","),

    type_field: ($) =>
      seq(
        field("name", $.identifier),
        optional(seq(":", field("type", $.type_expr))),
        optional(seq("=", field("default", $.inline_python_expr))),
      ),

    // ============================================================
    // Type expressions
    //
    // Grammar order: type_python (backtick escape hatch) > type_union >
    // type_apply / type_ref. Left-associative `|` for unions.
    // ============================================================
    type_expr: ($) => choice($.type_python, $._type_expr_term),

    _type_expr_term: ($) => choice($.type_union, $.type_apply, $.type_ref),

    type_arg: ($) => choice($.type_python, $.type_string, $._type_expr_term),

    type_union: ($) =>
      prec.left(
        1,
        seq(field("left", $._type_expr_term), "|", field("right", $._type_expr_term)),
      ),

    type_apply: ($) =>
      seq(
        field("name", $.identifier),
        "[",
        field("args", sep1($.type_arg, ",")),
        "]",
      ),

    type_ref: ($) => field("name", $.identifier),

    type_python: ($) => seq("`", field("code", $.python_inline_body), "`"),

    type_string: (_$) => token(choice(/"([^"\\\n]|\\.)*"/, /'([^'\\\n]|\\.)*'/)),

    // ============================================================
    // Assignment & return
    // ============================================================
    assign_stmt: ($) =>
      seq(
        $.assign_target,
        "=",
        field("rhs", choice($.inline_python_expr, $.template_expr)),
        $._newline,
      ),

    raw_invoke_stmt: ($) =>
      seq(
        field("target", $.assign_target),
        "<<",
        field("prompt", $.template_prompt_expr),
        $._newline,
      ),

    assign_target: ($) =>
      seq(
        "[",
        field("name", $.identifier),
        optional(seq(":", field("type", $.type_expr))),
        "]",
      ),

    return_stmt: ($) =>
      seq(
        "=",
        field("value", choice($.inline_python_expr, $.template_expr)),
        $._newline,
      ),

    backtick_line_stmt: ($) => seq($.inline_python_expr, $._newline),

    // ============================================================
    // Fenced Python blocks
    //
    // A fenced block opens and closes with a line whose stripped content
    // is exactly "```". The body content (between the two fences) is
    // captured as a single `python_code` token by the external scanner
    // (`_fenced_body`), including embedded specials (`<`, `>`, `[`, `]`,
    // `=`, `~`, `@`, single backticks, etc.) and newlines.
    //
    // The opening "```" is followed by a `_newline` token which lets the
    // scanner enter fenced-body mode. The body absorbs everything up to
    // (but not including) the closing "```" line, which the grammar
    // matches as another literal "```" token. The trailing `_newline`
    // after the close fence triggers indent-stack tracking on the next
    // statement line.
    //
    // Common-indent dedenting of body content is handled by the CST→AST
    // walker, NOT by the scanner — the raw bytes are preserved
    // here so editors can inject a Python parser into `python_code`.
    // ============================================================
    python_block: ($) =>
      seq("```", $._fenced_newline, field("code", $.python_code), "```", $._newline),

    assign_block_stmt: ($) =>
      seq(
        $.assign_target,
        "=",
        "```",
        $._fenced_newline,
        field("code", $.python_code),
        "```",
        $._newline,
      ),

    return_block_stmt: ($) =>
      seq(
        "=",
        "```",
        $._fenced_newline,
        field("code", $.python_code),
        "```",
        $._newline,
      ),

    python_code: ($) => $._fenced_body,

    // ============================================================
    // Template lines and segments
    // ============================================================
    // `>>` opens a template block. Continuation rows at the same indent
    // (no leading `>>`) are part of that block until a non-template
    // statement or a new `>>` line. Bare template_line outside a block
    // is invalid at procedure/top level; only `> optimize:` / `> auto:`
    // bodies may use bare template rows.
    template_block_stmt: ($) =>
      seq(
        ">>",
        field("head", $.template_prompt_expr),
        $._newline,
        repeat(
          seq(
            repeat($.template_blank_line),
            field("continuation", $.template_prompt_expr),
            $._newline,
          ),
        ),
      ),

    // A physical blank row within a `>>` block remains part of the prompt.
    // Keeping it named lets the AST layer preserve `A\n\nB` exactly while
    // still distinguishing it from statement indentation and comments.
    template_blank_line: ($) => $._newline,

    template_line: ($) => seq($.template_expr, $._newline),

    // In an assignment or return a sole `python` expression remains a
    // native value. Bare expressions therefore enter a regular template
    // expression only alongside another segment. `>>` and `<<` have an
    // unambiguous prompt introducer and use template_prompt_expr instead.
    template_expr: ($) =>
      choice(
        repeat1(
          choice(
            $.input_segment,
            $.call_segment,
            $.python_expr_segment,
            $.output_segment,
            $.text_segment,
          ),
        ),
        seq(
          repeat1(
            choice(
              $.input_segment,
              $.call_segment,
              $.python_expr_segment,
              $.output_segment,
              $.text_segment,
            ),
          ),
          $.inline_python_expr,
          repeat($._segment),
        ),
        seq($.inline_python_expr, repeat1($._segment)),
      ),

    template_prompt_expr: ($) => repeat1($._segment),

    _segment: ($) =>
      choice(
        $.input_segment,
        $.call_segment,
        $.python_expr_segment,
        $.inline_python_expr,
        $.output_segment,
        $.text_segment,
      ),

    text_segment: ($) => $._text,

    input_segment: ($) => seq("<", field("name", $.identifier), ">"),

    call_segment: ($) =>
      seq(
        "<",
        field("name", $.identifier),
        "(",
        optional(field("args", $.call_arg_list)),
        ")",
        ">",
      ),

    call_arg_list: ($) => sep1($.call_arg, ","),

    // Call arguments are either a single pure `python_expr` (passed as a
    // native Python value) or a "mini template" (rendered to a string at
    // call time). The mini-template form lets users embed `<inputs>` and
    // `[outputs]` and arbitrary text inside an argument — this matches
    // the legacy parser, which calls `parse_segments` on each comma-
    // separated argument and supports the full segment vocabulary.
    call_arg: ($) => choice($.inline_python_expr, $.template_arg),

    template_arg: ($) =>
      repeat1(
        choice(
          $.input_segment,
          $.output_segment,
          $.call_segment,
          $.python_expr_segment,
          $.text_in_call_segment,
        ),
      ),

    text_in_call_segment: ($) => $._text_in_call,

    output_segment: ($) =>
      seq(
        "[",
        field("name", $.identifier),
        optional(seq(":", field("type", $.type_expr))),
        "]",
      ),

    python_expr_segment: ($) => seq("<", $.inline_python_expr, ">"),

    // ============================================================
    // Directives inside procedure bodies
    //
    //   > auto:
    //     <indented free-text spec for an AI-generated procedure>
    //
    //   > optimize: <name>:
    //     <indented template lines for prompt optimisation>
    //
    // The `auto` body is a sequence of plain text lines (the prompt
    // text). The `optimize` body is a sequence of template_lines
    // (full Kedi template segments) — each line ends up as a span the
    // GEPA optimizer can rewrite.
    // ============================================================
    auto_directive: ($) =>
      seq(
        ">",
        "auto",
        ":",
        $._newline,
        field("body", $.auto_body),
      ),

    auto_body: ($) =>
      seq($._indent, repeat1(choice($.template_line, $._newline)), $._dedent),

    optimize_directive: ($) =>
      seq(
        ">",
        "optimize",
        ":",
        field("name", $.identifier),
        ":",
        $._newline,
        field("body", $.optimize_body),
      ),

    optimize_body: ($) =>
      seq(
        $._indent,
        choice(
          $.template_block_stmt,
          repeat1(choice($.template_line, $._newline)),
        ),
        $._dedent,
      ),

    // ============================================================
    // Agent profile directives
    //
    //   > model: haiku
    //   > model: `models['light']`
    //   > effort: low
    //   > system: You are concise.
    //   > system:
    //     You are concise.
    //     Prefer answers for <audience>.
    //   > profile: profile_name:
    //     > model: opus
    //     > system: You are concise.
    //   > use: profile_name
    // ============================================================
    model_directive: ($) =>
      seq(
        ">",
        "model",
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._model_plain_value, $.model_plain_value))),
        $._newline,
      ),

    _model_plain_value: ($) => token(/[^\n`]+/),

    agent_directive: ($) =>
      choice(
        seq(
          ">",
          "agent",
          ":",
          optional(/[ \t]+/),
          field("value", choice($.inline_python_expr, alias($._adapter_plain_value, $.adapter_plain_value))),
          $._newline,
        ),
        seq(
          ">",
          "agent",
          ":",
          $._newline,
          field("body", $.agent_body),
        ),
      ),

    agent_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.agent_field, $._newline)),
        $._dedent,
      ),

    agent_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._agent_command_plain_value, $.agent_command_plain_value))),
        $._newline,
      ),

    adapter_directive: ($) =>
      seq(
        ">",
        "adapter",
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._adapter_plain_value, $.adapter_plain_value))),
        $._newline,
      ),

    _adapter_plain_value: ($) => token(/[^\n`]+/),

    _agent_command_plain_value: ($) => token(/[^\n`#]+/),

    effort_directive: ($) =>
      seq(
        ">",
        "effort",
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._effort_plain_value, $.effort_plain_value))),
        $._newline,
      ),

    _effort_plain_value: ($) => token(/[^\n`]+/),

    approval_directive: ($) =>
      seq(
        ">",
        "approval",
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._approval_plain_value, $.approval_plain_value))),
        $._newline,
      ),

    _approval_plain_value: ($) => token(/[^\n`]+/),

    history_directive: ($) =>
      choice(
        seq(
          ">",
          "history",
          ":",
          optional(/[ \t]+/),
          field("value", alias($._history_plain_value, $.history_plain_value)),
          $._newline,
        ),
        seq(">", "history", ":", $._newline, field("body", $.history_body)),
      ),

    _history_plain_value: ($) => token(/[^\n`#]+/),

    history_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.history_field, $._newline)),
        $._dedent,
      ),

    history_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._settings_plain_value, $.settings_plain_value))),
        $._newline,
      ),

    system_directive: ($) =>
      choice(
        seq(
          ">",
          "system",
          ":",
          optional(/[ \t]+/),
          field("head", $.system_expr),
          $._newline,
        ),
        seq(">", "system", ":", $._newline, field("body", $.system_body)),
      ),

    system_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.system_line, $._newline)),
        $._dedent,
      ),

    system_line: ($) => seq(field("line", $.system_expr), $._newline),

    system_expr: ($) => repeat1($._system_segment),

    _system_segment: ($) => choice($.system_angle_segment, $.text_segment),

    system_angle_segment: ($) => $._system_angle_segment,

    mcp_directive: ($) =>
      seq(">", "mcp", ":", $._newline, field("body", $.mcp_body)),

    mcp_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.mcp_field, $._newline)),
        $._dedent,
      ),

    mcp_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._mcp_plain_value, $.mcp_plain_value))),
        $._newline,
      ),

    _mcp_plain_value: ($) => token(/[^\n`#]+/),

    settings_directive: ($) =>
      seq(">", "settings", ":", $._newline, field("body", $.settings_body)),

    settings_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.settings_field, $._newline)),
        $._dedent,
      ),

    settings_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._settings_plain_value, $.settings_plain_value))),
        $._newline,
      ),

    _settings_plain_value: ($) => token(/[^\n`#]+/),

    artifacts_directive: ($) =>
      seq(">", "artifacts", ":", $._newline, field("body", $.artifacts_body)),

    artifacts_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.artifacts_field, $._newline)),
        $._dedent,
      ),

    artifacts_field: ($) =>
      seq(
        field("name", $.identifier),
        ":",
        optional(/[ \t]+/),
        field("value", choice($.inline_python_expr, alias($._artifacts_plain_value, $.artifacts_plain_value))),
        $._newline,
      ),

    _artifacts_plain_value: ($) => token(/[^\n`#]+/),

    profile_directive: ($) =>
      seq(
        ">",
        "profile",
        ":",
        field("name", $.identifier),
        ":",
        $._newline,
        field("body", $.profile_body),
      ),

    profile_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.agent_directive, $.adapter_directive, $.model_directive, $.effort_directive, $.approval_directive, $.history_directive, $.system_directive, $.mcp_directive, $.settings_directive, $.artifacts_directive, $.output_directive, $.subagent_directive, $.max_agents_directive, $.workflow_directive, $.use_directive, $._newline)),
        $._dedent,
      ),

    output_directive: ($) =>
      seq(">", "output", ":", field("type", $.type_expr), $._newline),

    subagent_directive: ($) =>
      seq(">", "subagent", ":", field("name", $.identifier), $._newline),

    max_agents_directive: ($) =>
      seq(">", "max_agents", ":", field("value", $.positive_integer), $._newline),

    workflow_directive: ($) =>
      seq(">", "workflow", ":", field("value", $.identifier), $._newline),

    positive_integer: (_) => /[1-9][0-9]*/,

    use_directive: ($) =>
      choice(
        seq(">", "use", ":", field("name", $.identifier), $._newline),
        seq(">", "use", ":", "`", field("name", $.identifier), "`", $._newline),
        seq(">", "use", ":", $._newline, field("body", $.use_directive_body)),
      ),

    use_directive_body: ($) =>
      seq(
        $._indent,
        repeat1(choice($.use_tool_name, $.use_tool_backtick, $._newline)),
        $._dedent,
      ),

    use_tool_name: ($) => seq(field("name", $.identifier), $._newline),

    use_tool_backtick: ($) =>
      seq("`", field("name", $.identifier), "`", $._newline),

    // ============================================================
    // Validation blocks
    //
    //   @test: <procedure_name>:
    //     > case: <name>:
    //       <case body — backtick line or fenced Python block>
    //
    //   @eval: <procedure_name>:
    //     > data: <name>:
    //       = ``` ... ```
    //     > test_data: <name>:
    //       = ``` ... ```
    //     > metric: <name>(<dataset_name>):
    //       = ``` ... ```
    // ============================================================
    // Validation blocks open with `@<kw>:` where <kw> is the literal
    // identifier ``test`` or ``eval``. We deliberately match these via
    // the generic ``$.identifier`` rule (not via string literals) so
    // they do NOT collide with tree-sitter's keyword extraction —
    // otherwise a user procedure named ``test`` (``@test(...)``) gets
    // steered into the validation arm and fails to parse.
    //
    // The body alternatives ``test_case`` / ``eval_data`` /
    // ``eval_test_data`` / ``eval_metric`` are deliberately ALL
    // accepted by the unified ``validation_body`` rule; the CST→AST
    // walker discriminates ``test`` vs ``eval`` from the kw text and
    // rejects mismatched body content with a structured diagnostic
    // (e.g. "Unknown directive in @eval body" when ``> case:`` shows
    // up under ``@eval:``).
    validation_block: ($) =>
      seq(
        "@",
        field("kw", alias($.identifier, $.validation_keyword)),
        ":",
        field("procedure", $.identifier),
        ":",
        $._newline,
        field("body", $.validation_body),
      ),

    validation_body: ($) =>
      seq(
        $._indent,
        repeat1(
          choice($.test_case, $.eval_data, $.eval_test_data, $.eval_metric, $._newline),
        ),
        $._dedent,
      ),

    test_case: ($) =>
      seq(
        ">",
        "case",
        ":",
        field("name", $.identifier),
        ":",
        $._newline,
        field("code", $.test_case_body),
      ),

    test_case_body: ($) =>
      seq(
        $._indent,
        choice($.backtick_line_stmt, $.python_block),
        $._dedent,
      ),

    eval_data: ($) =>
      seq(
        ">",
        "data",
        ":",
        field("name", $.identifier),
        ":",
        $._newline,
        field("body", $.eval_entry_body),
      ),

    eval_test_data: ($) =>
      seq(
        ">",
        "test_data",
        ":",
        field("name", $.identifier),
        ":",
        $._newline,
        field("body", $.eval_entry_body),
      ),

    eval_metric: ($) =>
      seq(
        ">",
        "metric",
        ":",
        field("name", $.identifier),
        optional(seq("(", field("dataset", $.identifier), ")")),
        ":",
        $._newline,
        field("body", $.eval_entry_body),
      ),

    eval_entry_body: ($) =>
      seq(
        $._indent,
        choice($.return_stmt, $.return_block_stmt),
        $._dedent,
      ),

    // ============================================================
    // Lexical
    // ============================================================
    inline_python_expr: ($) => seq("`", field("code", $.python_inline_body), "`"),

    // Body of a backtick-delimited expression. Stops at the first
    // unescaped backtick. Backslash escapes (e.g. `\\\``) are consumed as
    // pairs. Must be non-empty to disambiguate from the empty `` `` token.
    python_inline_body: ($) => token.immediate(/([^`\\]|\\.)+/),

    identifier: ($) => /[A-Za-z_][A-Za-z0-9_]*/,

    line_comment: ($) => token(seq("#", /[^\n]*/)),

    block_comment: ($) =>
      token(seq("###", repeat(choice(/[^#]/, /#[^#]/, /##[^#]/)), "###")),
  },
});

function sep1(rule, sep) {
  return seq(rule, repeat(seq(sep, rule)));
}
