# Wishlist

Ideas that are not decided or not started. Move one out of here when the work
begins.

## just-doc as an app

Start just-doc without a file and open documents from inside the window.

- `just-doc` alone opens the window on a start page, or brings up the one
  that already runs.
- An open box (`o`), on the start page and in any document. It lists the
  recent files first and typing filters them. A typed path browses folders,
  showing only PDF and markdown files; `Tab` completes and `Enter` opens the
  file as a new tab.
- Recent files are kept in one small file in the user folder, newest first.
- The entry that `just-doc --install-desktop` writes also starts just-doc from
  the application launcher or a window manager key, on the start page.
- A key to quit just-doc from the window, because an app started from the
  launcher has no terminal to stop it in.

The picker must be just-doc's own: a browser window does not give a page the
full path of a file chosen in the system dialog. No new dependency is needed.

## Quick comments

A short list of the user's frequent remarks ("too informal", "wrong word"),
put on the selection with one key and a number. Each one becomes an ordinary
comment, so the JSON format, `--read` and the review stay as they are. The
list is a text file with one remark per line.

Put aside until the same remarks really repeat.

## Markdown through LaTeX

A choice to convert a markdown file with a LaTeX engine and not with typst.
With typst, pandoc drops LaTeX outside `$…$`: environments such as
`\begin{align}`, `\newcommand` macros and packages. LaTeX keeps them and is
slower.

## Live HTML reports with feedback

A separate tool, not a part of just-doc. An assistant publishes an HTML
report to a server that keeps running, and the user answers in the page.

- The page stays live: interactive plots, equations and images work as the
  assistant wrote them. Printing the page to a PDF for just-doc is not
  enough for that reason.
- Feedback is more than comments on text: the report can ask, and the user
  picks one of several options, ticks boxes or types a value.
- The same round as in just-doc: the assistant publishes and waits, the user
  answers and hands over with a key, the assistant reads the answers.
- Comments on a selection work as in just-doc where that fits, with the same
  commands (`--wait`, `--reply`) if possible, so an assistant learns one way.
