"""Tree-sitter grammar bindings for the Kedi DSL — typing stub."""

def language() -> object:
    """Return a PyCapsule wrapping the TSLanguage pointer for Kedi.

    The returned capsule is consumed by `tree_sitter.Language(capsule)`.
    """
