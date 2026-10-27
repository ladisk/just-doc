# just-doc

A PDF commenting tool. The user selects text in a browser window and presses a
key; each comment is saved to `book.comments.json` next to the PDF, with the
exact text and its position. `README.md` is the user-facing reference for keys,
the JSON format, export and the LaTeX source lookup.

## Layout

- `just_doc/__init__.py` — all the Python: the `just-doc` command (`main`), the
  `--read` and `--export` modes, and the code that opens the window.
- `just_doc/web/index.html` — the viewer of one document: the whole user
  interface in one file (HTML, CSS and JavaScript together).
- `just_doc/web/tabs.html` — the window: a tab bar and one viewer per open
  document, each in its own frame. One running `just-doc` serves all open
  documents; a later `just-doc file` hands its document over to it as a tab.
- `just_doc/web/pdfjs/` — a bundled copy of PDF.js 4.10.38 (third-party, Apache
  2.0). Do not edit it.
- `pyproject.toml` — packaging; built with hatchling.

## Design

Everything is shortcut driven. Every action has a key, and a new feature gets a
key too, not only a button or a menu. Add the key to the hint bar at the bottom
of the window and to the table in `README.md`.

The review with a coding assistant (`--wait`, `--reply`, `--done`) must work
with any assistant that can run shell commands. `--guide` prints its
instructions (`GUIDE` in `__init__.py`); keep them and the output of `--wait`
complete enough that an assistant needs nothing else.

## Constraints

- Python 3.9 or newer.
- `pypdf` is the only dependency and is used only for export. Do not add
  dependencies without asking.
- A markdown file is converted to a PDF with the external `pandoc` program
  (`shown_pdf`); everything after that works on the PDF. `pandoc` is needed
  only for markdown files.
- The original PDF is never changed. The JSON file is the working copy; export
  writes a separate `book.commented.pdf`.
- Positions are in PDF points measured from the top-left corner of the page.

## Running

```bash
uv run just-doc book.pdf          # open for commenting
uv run just-doc book.pdf --read   # print the comments
uv run just-doc book.pdf --export # write book.commented.pdf
```

```bash
node tests/smoke.mjs              # smoke test in headless Chromium, see tests/README.md
```

There are no other automated tests; check changes by running the tool on a PDF.

## Documentation

When a change adds or alters a key, a command-line flag or the JSON format,
update `README.md` in the same commit.
