"""
Python translation of the original `src/lib/display.js` helper module.

The goal is to keep formatting helpers small, dependency-free, and clear enough
that anyone can read the code and immediately understand what happens to their
strings. Every variable and transformation is narrated step by step.
"""

# No imports are necessary here because all operations rely on built-in string
# methods. Keeping the file import-free reinforces the "no hidden dependencies"
# requirement from the project guidance.


def format_as_block_quote(text):
    """
    Turn a block of text into a Markdown block quote.

    Parameters
    ----------
    text : Any
        The content to format. It is converted to a string so callers can pass
        numbers or other objects without causing errors.

    Returns
    -------
    str
        A new string where each original line is prefixed with `> `, matching the
        Markdown block quote style seen in the previous JavaScript implementation.
    """

    # If the caller provides an empty value like None or an empty string, we
    # short-circuit and return an empty string. This mirrors the original
    # JavaScript guard clause `if (!text) return ''`.
    if not text:
        return ""

    # Convert the input to a string explicitly. This step ensures that even if a
    # caller passes an integer or an object with a custom `__str__` method, we
    # still produce predictable output instead of raising an error.
    text_as_string = str(text)

    # Split the string into individual lines. `splitlines()` handles both Unix
    # (\n) and Windows (\r\n) newlines, mirroring the regular expression used in
    # the JavaScript version. The resulting list preserves the original line
    # order so we can process each line in turn.
    lines = text_as_string.splitlines()

    # For every line, prepend the Markdown quote marker "> " so Markdown
    # renderers treat the text as a quoted block. We use a list comprehension to
    # keep the transformation explicit and readable.
    quoted_lines = [f"> {line}" for line in lines]

    # Join the quoted lines back together with newline characters. This rebuilds
    # a single string that can be embedded directly into Markdown output.
    block_quote = "\n".join(quoted_lines)

    # Return the fully formatted block quote string to the caller.
    return block_quote


# Self-test and demonstration executed when running this file directly. This
# keeps the helper easy to experiment with without introducing external test
# frameworks or fixtures.
if __name__ == "__main__":
    sample = """Line one
Line two
Line three"""
    print("Original text:\n", sample)
    print("\nBlock quote formatted:\n", format_as_block_quote(sample))
