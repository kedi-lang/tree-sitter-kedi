// Kedi external scanner.
//
// Tokens emitted by this scanner (declared in `externals` of grammar.js):
//
//   - NEWLINE / INDENT / DEDENT: Python-style indent stack with tab-width = 4.
//     Blank/comment-only lines are transparently consumed during the NEWLINE
//     lookahead for indent calculation.
//   - TEXT / TEXT_IN_CALL / CONDITION_TEXT: runs of template-text characters
//     terminated by an unescaped special. CONDITION_TEXT additionally stops
//     before a terminal `:` so deterministic control headers stay unambiguous.
//   - FENCED_BODY: the raw byte content between a triple-backtick opener
//     and its matching closer. Captured verbatim so editors can inject a
//     Python parser into the region.
//
// Tokens NOT scanned here (handled by tree-sitter's internal lexer via
// literal-token rules in grammar.js):
//
//   - Single backtick `` ` `` — opens / closes `inline_python_expr`.
//   - Triple backtick `` ``` `` — opens / closes a fenced Python block.
//     Tree-sitter's longest-match rule selects `` ``` `` over `` ` ``
//     wherever three consecutive backticks appear. We avoid scanner-side
//     peeking (which would commit advances that tree-sitter cannot roll
//     back on `return false`).

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// IMPORTANT: this enum order MUST match the `externals` array order in
// grammar.js. Tree-sitter passes symbol indices accordingly.
enum TokenType {
    KEDI_NEWLINE = 0,
    KEDI_INDENT,
    KEDI_DEDENT,
    KEDI_TEXT,
    KEDI_TEXT_IN_CALL,
    KEDI_CONDITION_TEXT,
    KEDI_FENCED_BODY,
    // Consumes a single '\n' WITHOUT updating the indent stack. Used by
    // the grammar between the opening "```" literal and the fenced
    // body so the body's own indentation does not push a new entry
    // onto the indent stack (which would then cause an erroneous
    // DEDENT when the close fence brings us back to the procedure's
    // body indent).
    KEDI_FENCED_NEWLINE,
    KEDI_SYSTEM_ANGLE_SEGMENT,
};

#define KEDI_INDENT_STACK_MAX 64
#define KEDI_TAB_WIDTH 4

typedef struct {
    uint16_t indent_stack[KEDI_INDENT_STACK_MAX];
    uint8_t  indent_depth;     // entries currently on the stack; stack[0] = 0
    int16_t  pending;          // >0 INDENTs queued, <0 DEDENTs queued
    bool     eof_newline_emitted;
} Scanner;

static void scanner_reset(Scanner *s) {
    memset(s, 0, sizeof(*s));
    s->indent_stack[0] = 0;
    s->indent_depth = 1;
    s->pending = 0;
    s->eof_newline_emitted = false;
}

void *tree_sitter_kedi_external_scanner_create(void) {
    Scanner *s = (Scanner *)malloc(sizeof(Scanner));
    scanner_reset(s);
    return s;
}

void tree_sitter_kedi_external_scanner_destroy(void *payload) {
    free(payload);
}

unsigned tree_sitter_kedi_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *s = (Scanner *)payload;
    unsigned pos = 0;
    buffer[pos++] = (char)s->indent_depth;
    buffer[pos++] = (char)((uint16_t)s->pending & 0xff);
    buffer[pos++] = (char)(((uint16_t)s->pending >> 8) & 0xff);
    buffer[pos++] = (char)(s->eof_newline_emitted ? 1 : 0);
    for (uint8_t i = 0; i < s->indent_depth; i++) {
        buffer[pos++] = (char)(s->indent_stack[i] & 0xff);
        buffer[pos++] = (char)((s->indent_stack[i] >> 8) & 0xff);
    }
    return pos;
}

void tree_sitter_kedi_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *s = (Scanner *)payload;
    scanner_reset(s);
    if (length == 0) return;
    unsigned pos = 0;
    s->indent_depth = (uint8_t)buffer[pos++];
    uint16_t lo = (uint8_t)buffer[pos++];
    uint16_t hi = (uint8_t)buffer[pos++];
    s->pending = (int16_t)(lo | (hi << 8));
    s->eof_newline_emitted = buffer[pos++] != 0;
    for (uint8_t i = 0; i < s->indent_depth; i++) {
        uint16_t blo = (uint8_t)buffer[pos++];
        uint16_t bhi = (uint8_t)buffer[pos++];
        s->indent_stack[i] = (uint16_t)(blo | (bhi << 8));
    }
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, /*skip=*/false); }
static inline bool is_eof(TSLexer *lexer)   { return lexer->eof(lexer); }

static bool drain_pending(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
    if (s->pending > 0 && valid_symbols[KEDI_INDENT]) {
        s->pending--;
        lexer->result_symbol = KEDI_INDENT;
        return true;
    }
    if (s->pending < 0 && valid_symbols[KEDI_DEDENT]) {
        s->pending++;
        if (s->indent_depth > 1) s->indent_depth--;
        lexer->result_symbol = KEDI_DEDENT;
        return true;
    }
    return false;
}

// Skip leading whitespace on the current physical line, counting columns
// with tabs as KEDI_TAB_WIDTH. Returns the column reached at the first
// non-whitespace character, or UINT32_MAX if the line was blank, a
// single-line `#` comment, or a `###` block-comment fence line.
//
// On UINT32_MAX, the lexer is positioned at the '\n' (or EOF) ending
// the skipped line. The scanner exposes a physical blank line only while a
// template expression is expected; structural contexts skip it like comments.
//
// For `###` block-comment fences we deliberately do NOT advance through
// the body. The body content is multi-line and contains arbitrary
// characters; advancing through it from the scanner risks misclassifying
// body lines that look like fences. Tree-sitter's `block_comment` regex
// in extras spans the entire `###...###` region in one match — we just
// need to ensure tree-sitter has a chance to run that regex when the
// next token attempt fires.
static uint32_t skip_leading_ws(TSLexer *lexer, bool *is_blank_line) {
    *is_blank_line = false;
    uint32_t col = 0;
    for (;;) {
        if (lexer->lookahead == ' ') { col += 1; advance(lexer); continue; }
        if (lexer->lookahead == '\t') { col += KEDI_TAB_WIDTH; advance(lexer); continue; }
        break;
    }
    if (lexer->lookahead == '\n') {
        *is_blank_line = true;
        return UINT32_MAX;
    }
    if (lexer->lookahead == 0 && is_eof(lexer)) return UINT32_MAX;
    if (lexer->lookahead != '#') return col;

    // We're at a '#'. Distinguish:
    //   - `#X` / `##X` (X != '#') — single-line comment.
    //   - `###` alone on its line — block-comment fence.
    //   - `### content` — non-fence; treat as line comment.
    //   - `####...` — line comment.
    advance(lexer);
    if (lexer->lookahead != '#') {
        while (lexer->lookahead != 0 && lexer->lookahead != '\n') advance(lexer);
        return UINT32_MAX;
    }
    advance(lexer);
    if (lexer->lookahead != '#') {
        while (lexer->lookahead != 0 && lexer->lookahead != '\n') advance(lexer);
        return UINT32_MAX;
    }
    advance(lexer);
    if (lexer->lookahead == '#') {
        while (lexer->lookahead != 0 && lexer->lookahead != '\n') advance(lexer);
        return UINT32_MAX;
    }
    // Exactly `###`. Trailing horizontal WS allowed, then `\n` / EOF.
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
    if (lexer->lookahead == '\n' || (lexer->lookahead == 0 && is_eof(lexer))) {
        // Block-comment fence. Leave the scanner at the '\n' so the
        // outer loop consumes it; the `block_comment` regex extras will
        // match the entire `###...###` region when tree-sitter
        // re-scans from the previous token's end.
        return UINT32_MAX;
    }
    while (lexer->lookahead != 0 && lexer->lookahead != '\n') advance(lexer);
    return UINT32_MAX;
}

static void apply_indent_change(Scanner *s, uint32_t new_col) {
    uint16_t top = s->indent_stack[s->indent_depth - 1];
    if ((uint32_t)top == new_col) return;
    if (new_col > top) {
        if (s->indent_depth < KEDI_INDENT_STACK_MAX) {
            s->indent_stack[s->indent_depth++] = (uint16_t)new_col;
            s->pending = 1;
        }
        return;
    }
    uint8_t i = s->indent_depth;
    int16_t dedents = 0;
    while (i > 1 && s->indent_stack[i - 1] > new_col) {
        i--;
        dedents++;
    }
    s->pending = (int16_t)-dedents;
}

// Returns true iff `c` terminates a TEXT run unconditionally.
static inline bool is_unconditional_text_stop(int32_t c) {
    return c == '<'  || c == '['  || c == '`' ||
           c == '>'  || c == ']'  || c == '\n' ||
           c == '#';
}

typedef enum {
    TEXT_SCAN_NONE,
    TEXT_SCAN_TEXT,
    TEXT_SCAN_BLANK_LINE,
} TextScanResult;

// Scan a TEXT or TEXT_IN_CALL token. A whitespace-only physical line is
// reported separately so the caller can emit the `_newline` token that keeps
// block grammars synchronized without treating indentation as prompt text.
//
// Behaviour:
//   - Leading whitespace is absorbed (tree-sitter cannot interleave
//     extras between a failed external-scanner call and a retry, so we
//     consume the indentation here and the CST→AST walker trims
//     it off each TextSegment).
//   - `@`, `~`, `=` at the very first non-whitespace position cause the
//     scan to return false so the grammar can dispatch procedure_def /
//     type_def / return_stmt. Once inside a text run they are absorbed
//     literally — matching the legacy parser, where escaping is only
//     required at line start.
//   - Unconditional stops: `<`, `[`, `` ` ``, `>`, `]`, `\n`, `#`.
//   - In call-argument context, additional stops on `,` and `)`.
//   - Backslash escapes (`\\X`) are consumed as two-character units.
static TextScanResult scan_text_run(
    TSLexer *lexer,
    bool in_call,
    bool condition_mode,
    bool newline_valid
) {
    bool seen_text = false;
    for (;;) {
        int32_t c = lexer->lookahead;
        if (c == 0 && is_eof(lexer)) break;
        if (c == '\n') {
            if (!seen_text && newline_valid) {
                advance(lexer);
                lexer->mark_end(lexer);
                return TEXT_SCAN_BLANK_LINE;
            }
            break;
        }
        if (is_unconditional_text_stop(c)) break;

        if (condition_mode && c == ':') {
            // A condition's final colon is structural. Mark the token end
            // before looking ahead; tree-sitter rewinds speculative advances
            // to this mark when we return the preceding CONDITION_TEXT.
            if (!seen_text) return TEXT_SCAN_NONE;
            lexer->mark_end(lexer);
            advance(lexer);
            while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                advance(lexer);
            }
            if (lexer->lookahead == '\n' || (lexer->lookahead == 0 && is_eof(lexer))) {
                return TEXT_SCAN_TEXT;
            }
            seen_text = true;
            continue;
        }

        if (!condition_mode && c == ':') {
            // Ordinary colons belong to template text. Only ``:=`` starts a
            // reassignment token, so look ahead without consuming it into
            // the current text run.
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '=') {
                return seen_text ? TEXT_SCAN_TEXT : TEXT_SCAN_NONE;
            }
            seen_text = true;
            continue;
        }

        if (c == ' ' || c == '\t') {
            advance(lexer);
            continue;
        }

        if (c == '@' || c == '~' || c == '=') {
            if (!seen_text) return TEXT_SCAN_NONE;
            advance(lexer);
            seen_text = true;
            continue;
        }

        if (in_call && (c == ',' || c == ')')) {
            if (!seen_text) return TEXT_SCAN_NONE;
            break;
        }

        if (c == '\\') {
            advance(lexer);
            int32_t nxt = lexer->lookahead;
            if (nxt == 0 && is_eof(lexer)) break;
            if (nxt == '\n') {
                // `\<newline>` is a line continuation: absorb the
                // newline and the leading whitespace of the next line
                // into the text token. The Python unescape later
                // collapses `\<newline>` into a single space.
                advance(lexer);
                while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                    advance(lexer);
                }
                seen_text = true;
                continue;
            }
            if (nxt == ' ' || nxt == '\t') {
                // Could be `\<WS>+<newline>` continuation, or a
                // (semantically invalid) `\<space>` mid-text escape.
                // Advance through the whitespace run and check: if
                // it's terminated by '\n', consume the newline + next
                // line's leading WS as part of this token.
                while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                    advance(lexer);
                }
                if (lexer->lookahead == '\n') {
                    advance(lexer);
                    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                        advance(lexer);
                    }
                }
                seen_text = true;
                continue;
            }
            // Normal `\<X>` escape pair: consume X as part of the run.
            advance(lexer);
            seen_text = true;
            continue;
        }

        advance(lexer);
        seen_text = true;
    }
    // Whitespace-only lines are blank lines, never template text. Horizontal
    // whitespace is an extra and remains valid after a real text segment.
    if (seen_text) lexer->mark_end(lexer);
    return seen_text ? TEXT_SCAN_TEXT : TEXT_SCAN_NONE;
}

static bool scan_system_angle_segment(TSLexer *lexer) {
    if (lexer->lookahead != '<') return false;
    advance(lexer);
    bool saw_body = false;
    while (lexer->lookahead != 0 && lexer->lookahead != '\n') {
        if (lexer->lookahead == '>') {
            advance(lexer);
            lexer->mark_end(lexer);
            return true;
        }
        saw_body = true;
        advance(lexer);
    }
    if (saw_body) {
        lexer->mark_end(lexer);
        return true;
    }
    return false;
}

// Scan the body of a fenced Python block.
//
// Entry contract: the caller is the grammar rule `python_code: $._fenced_body`
// which is invoked immediately after the opening "```" literal AND the
// newline that follows it on the open-fence line. So the lexer is at
// column 0 of the first body line (or EOF for an empty body that runs to
// the close fence on the next physical line).
//
// We accumulate complete lines until the next line is a close-fence line
// (stripped content exactly "```"). At that point we stop with mark_end
// at the line break preceding the close fence — the close-fence "```"
// literal in the grammar then matches.
//
// The body may be empty (zero bytes) when the open and close fences are
// adjacent.
static bool scan_fenced_body(TSLexer *lexer) {
    lexer->mark_end(lexer);
    for (;;) {
        if (lexer->lookahead == 0 && is_eof(lexer)) {
            // Unterminated fence: take everything up to EOF as the body.
            // The grammar will then fail to match the close fence and
            // surface an ERROR.
            return true;
        }

        // Peek the current line: is it a close fence?
        bool is_close = false;
        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
        if (lexer->lookahead == '`') {
            advance(lexer);
            if (lexer->lookahead == '`') {
                advance(lexer);
                if (lexer->lookahead == '`') {
                    advance(lexer);
                    if (lexer->lookahead != '`') {
                        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
                        if (lexer->lookahead == '\n' || (lexer->lookahead == 0 && is_eof(lexer))) {
                            is_close = true;
                        }
                    }
                }
            }
        }

        if (is_close) {
            // mark_end was set at the start of this line before we
            // peeked, so the body excludes the close fence. Tree-sitter
            // resets the lexer to mark_end when we return true.
            return true;
        }

        // Not a close fence. Advance through any remaining chars of this
        // line plus the trailing '\n', then include them in the body by
        // updating mark_end.
        while (lexer->lookahead != 0 && lexer->lookahead != '\n') advance(lexer);
        if (lexer->lookahead == '\n') {
            advance(lexer);
        } else if (is_eof(lexer)) {
            lexer->mark_end(lexer);
            return true;
        }
        lexer->mark_end(lexer);
    }
}

bool tree_sitter_kedi_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *s = (Scanner *)payload;

    // 1. Drain queued INDENT / DEDENT tokens first.
    if (drain_pending(s, lexer, valid_symbols)) return true;

    // 2. EOF: emit a synthetic terminating NEWLINE once, then DEDENTs.
    if (is_eof(lexer)) {
        if (!s->eof_newline_emitted && valid_symbols[KEDI_NEWLINE]) {
            s->eof_newline_emitted = true;
            lexer->result_symbol = KEDI_NEWLINE;
            return true;
        }
        if (s->indent_depth > 1 && valid_symbols[KEDI_DEDENT]) {
            s->indent_depth--;
            lexer->result_symbol = KEDI_DEDENT;
            return true;
        }
        return false;
    }

    // 3. FENCED_NEWLINE: consume a single '\n' without indent-stack
    //    updates. It must win over a normal NEWLINE when both are
    //    provisionally valid after an opening fence: the regular path
    //    would otherwise turn a fenced return block into an empty inline
    //    expression.
    if (lexer->lookahead == '\n' && valid_symbols[KEDI_FENCED_NEWLINE]) {
        advance(lexer);
        lexer->mark_end(lexer);
        lexer->result_symbol = KEDI_FENCED_NEWLINE;
        return true;
    }

    // 4. NEWLINE: consume '\n', mark_end so the token spans just the
    //    '\n', then look ahead past blank/comment-only lines to compute
    //    the next line's indent column.
    //
    //    We also handle the case where the cursor is parked on
    //    trailing horizontal whitespace immediately before the '\n'
    //    (e.g. `@f(): \n`). Tree-sitter's extras would normally
    //    consume the trailing space, but only if a non-NEWLINE token
    //    becomes valid afterwards — when NEWLINE is the SOLE valid
    //    next token, extras never get a chance and parsing stalls.
    //    Absorbing the trailing WS into the NEWLINE token here is
    //    safe (it has no syntactic significance) and matches the
    //    `line.rstrip()` semantics.
    // Trailing-WS absorption: when NEWLINE is the ONLY valid external
    // token (i.e. we're sitting right after a `:` or similar in a
    // tightly constrained state), tree-sitter's extras layer can't
    // consume `[ \t]` between us and the `\n` — there is no
    // subsequent non-NEWLINE token to anchor extras matching against.
    // Pre-consuming the trailing horizontal whitespace as part of the
    // NEWLINE token mirrors `line.rstrip()`
    // and unblocks parsing of inputs like ``@f(): \n``.
    if (valid_symbols[KEDI_NEWLINE] &&
        !valid_symbols[KEDI_TEXT] &&
        !valid_symbols[KEDI_TEXT_IN_CALL] &&
        !valid_symbols[KEDI_CONDITION_TEXT] &&
        !valid_symbols[KEDI_FENCED_BODY] &&
        (lexer->lookahead == ' ' || lexer->lookahead == '\t')) {
        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
            advance(lexer);
        }
        if (lexer->lookahead != '\n' && !is_eof(lexer)) {
            return false;
        }
        // Fall through to the regular newline handling below.
    }
    if (lexer->lookahead == '\n' && valid_symbols[KEDI_NEWLINE]) {
        advance(lexer);
        lexer->mark_end(lexer);
        for (;;) {
            bool is_blank_line = false;
            uint32_t new_col = skip_leading_ws(lexer, &is_blank_line);
            if (new_col != UINT32_MAX) {
                apply_indent_change(s, new_col);
                lexer->result_symbol = KEDI_NEWLINE;
                return true;
            }
            if (is_blank_line) {
                // Template bodies may need to retain a physical blank line
                // as a continuation delimiter. At structural boundaries,
                // though, source_file / validation rules already received
                // the preceding newline; emitting another one here corrupts
                // transitions such as a test block followed by a procedure.
                if (valid_symbols[KEDI_TEXT] || valid_symbols[KEDI_TEXT_IN_CALL] ||
                    valid_symbols[KEDI_CONDITION_TEXT]) {
                    lexer->result_symbol = KEDI_NEWLINE;
                    return true;
                }
                advance(lexer);
                continue;
            }
            if (is_eof(lexer)) {
                s->pending = (int16_t)-(int16_t)(s->indent_depth - 1);
                lexer->result_symbol = KEDI_NEWLINE;
                return true;
            }
            advance(lexer);  // consume the trailing '\n' of a blank/comment line
        }
    }

    // 5. FENCED_BODY: scan raw body bytes between open and close fences.
    if (valid_symbols[KEDI_FENCED_BODY]) {
        if (scan_fenced_body(lexer)) {
            lexer->result_symbol = KEDI_FENCED_BODY;
            return true;
        }
    }

    // 6. SYSTEM_ANGLE_SEGMENT: system instructions support only
    //    `<name>` substitutions plus the special literal `<``>` marker.
    //    The CST walker validates which form was used.
    if (valid_symbols[KEDI_SYSTEM_ANGLE_SEGMENT]) {
        if (scan_system_angle_segment(lexer)) {
            lexer->result_symbol = KEDI_SYSTEM_ANGLE_SEGMENT;
            return true;
        }
    }

    // 7. TEXT / TEXT_IN_CALL / CONDITION_TEXT.
    //
    // valid_symbols is the union across all active GLR states, so we may
    // see both TEXT and TEXT_IN_CALL set at once (e.g. initial state).
    // Prefer TEXT — we are only inside a call-argument list when TEXT
    // itself is NOT valid.
    bool text_valid = valid_symbols[KEDI_TEXT];
    bool call_valid = valid_symbols[KEDI_TEXT_IN_CALL];
    bool condition_valid = valid_symbols[KEDI_CONDITION_TEXT];
    if (text_valid || call_valid || condition_valid) {
        bool call_mode = call_valid && !text_valid;
        bool condition_mode = condition_valid && !text_valid && !call_valid;
        TextScanResult text_result = scan_text_run(
            lexer,
            call_mode,
            condition_mode,
            valid_symbols[KEDI_NEWLINE]
        );
        if (text_result == TEXT_SCAN_BLANK_LINE) {
            bool is_blank_line = false;
            uint32_t new_col = skip_leading_ws(lexer, &is_blank_line);
            if (new_col != UINT32_MAX) {
                apply_indent_change(s, new_col);
            } else if (is_eof(lexer)) {
                s->pending = (int16_t)-(int16_t)(s->indent_depth - 1);
            }
            lexer->result_symbol = KEDI_NEWLINE;
            return true;
        }
        if (text_result == TEXT_SCAN_TEXT) {
            lexer->result_symbol = call_mode
                ? KEDI_TEXT_IN_CALL
                : (condition_mode ? KEDI_CONDITION_TEXT : KEDI_TEXT);
            return true;
        }
    }

    return false;
}
