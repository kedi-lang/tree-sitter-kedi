"""Tree-sitter grammar bindings for the Kedi DSL.

Usage:

    from tree_sitter import Language, Parser
    import tree_sitter_kedi

    parser = Parser(Language(tree_sitter_kedi.language()))
    tree = parser.parse(open("program.kedi", "rb").read())
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:

    def language() -> object: ...

else:
    from ._binding import language

__all__ = ["language"]
