# just-doc

Read a PDF, select text, press a key, write what is wrong with it. Every comment
is saved to a JSON file together with the exact text and position it refers to,
so a script or a coding assistant can find the right place in the source.

```bash
just-doc book.pdf          # open for commenting
just-doc book.pdf --read   # print the comments
just-doc book.pdf --export # write book.commented.pdf with the comments inside
just-doc notes.md          # a markdown file works the same way
just-doc slides.html       # and an HTML file, such as a slide deck
just-doc                   # list the open documents; open the window again if it was closed
just-doc book.pdf --wait   # open it, wait for Ctrl+Enter, then print the comments
just-doc book.pdf --reply 2 "text"   # add a reply to comment 2
just-doc --guide           # how a coding assistant reviews a document with you
```

## Install

With [uv](https://docs.astral.sh/uv/):

```bash
uv tool install git+https://github.com/ladisk/just-doc
```

or with pipx: `pipx install git+https://github.com/ladisk/just-doc`.

To try it without installing: `uvx --from git+https://github.com/ladisk/just-doc just-doc book.pdf`.

Needs Python 3.9 or newer; the only dependency is `pypdf`, used for the export. The window is a Chromium, Brave or
Chrome app window if one is installed, otherwise a tab in the default browser.

## Keys

| key | action |
|---|---|
| `a` | highlight the selection and write a comment; on a selected comment, edit it, or once it is answered or done, reply; `Enter` in an empty field leaves a plain highlight |
| `A` | reply to the selected comment, the one of the open card or the one under the cursor (see "Reviewing with a coding assistant") |
| `gn` / `gN` | go to the next / previous comment answered since the last hand-over, or change, starting from where you are; a card shows it (see "What changed") |
| `za` | open or close the row of the comment in the list, or on a change the group of changes; `zR` / `zM` open / close all rows |
| `D` | show or hide the comments that are done |
| `m` / `M` | mark what changed since the last hand-over / since the last commit; the same key again hides the marks (see "What changed") |
| `a` on the card of a change | comment on that change |
| `gb` | show the page at the cursor as it was before the changes; `gb` or `Esc` goes back |
| `gh` | history: the rounds so far, each with what you handed over, the answers and the changes; `Enter` shows the document as it was at the end of a round (see "Rounds and history") |
| `Ctrl` `Enter` | hand the comments over to the `just-doc --wait` that is waiting for them |
| `s` | strike through the selection: this text should be deleted |
| `r` | draw a rectangle (for a figure, an equation or code) and comment on it |
| `d` | delete the selected highlight or rectangle (click it first) |
| `u` | undo the last delete |
| `c` | hide or show the comment list, so the page gets the full width |
| `C` | hide or show the highlights and the link marks on the page, to read the clean text; the selected one stays visible |
| `n` / `p` | go to the next / previous comment, starting from the current page; the cursor goes to the start of its text |
| `Enter` | follow the link under the cursor (a click on a link does the same); `Tab` / `Shift` `Tab` move the cursor to the next / previous link on the page |
| `Ctrl` `o` / `Ctrl` `i` | jump back to where you were before a jump / forward again |
| `/` | search the whole PDF: type the text, `Enter`; then `n` / `N` go to the next / previous match and `Esc` ends the search |
| `t` | table of contents: `j` / `k` move, `Enter` goes there, `Esc` closes |
| `h` `j` `k` `l`, `w` `b` `e`, `0` `$` | move the cursor (see below); the page follows it |
| `↓` / `↑` | move the cursor a line down / up, as `j` / `k` do; also in a selection |
| `f` / `F` + a character | move the cursor to that character after / before it on the line (`fa`, `3fa`); the wait for the character ends after 1.5 s |
| `gg` / `G` | go to the top / bottom of the document, with the cursor on the first word / the last line; with a number first (`12G`) go to that page |
| `Ctrl` `d` / `Ctrl` `u` | half a page down / up |
| `zt` / `zz` / `zb` | scroll so that the cursor line is near the top / in the middle / near the bottom of the window, with about two lines above or below it; also in a selection |
| `←` / `→` | go to the previous / next page |
| `P` | single page view: show one page at a time, fitted to the window; `P` again goes back to the continuous view and the zoom from before |
| `v` / `V` | start a visual / visual line selection (see below) |
| `Ctrl` + wheel, `Ctrl` `+` / `-` / `0` | zoom the page around the pointer; the toolbar and comment list keep their size |
| `Ctrl` `S` | export a copy of the PDF with the comments inside |
| `Ctrl` `Shift` `S` | markdown or HTML file: save the PDF made from it as `notes.pdf` next to it, without comments |
| `H` / `L` | previous / next tab, when several documents are open; `Alt` `←` / `Alt` `→` do the same |
| `Ctrl` `w` | close the tab; `Alt` `w` does the same |
| `q` then `y` | stop just-doc and close its windows; a `--wait` that is waiting ends too. Closing the window alone leaves just-doc running, and `just-doc` without a file opens the window again |
| `?` | show or hide the full key list; in it `/` filters the keys by what you type |
| `Esc` | deselect |

A comment, a reply and an edit are written in a field at the bottom of the
comment's card, under its text. `Enter` saves, `Shift+Enter` starts a new
line, `Esc` cancels.

The browser's own shortcuts (print, find, history, bookmarks and so on) are
switched off in the window. Copy (`Ctrl+C`), reload (`Ctrl+R`, `F5`), full
screen (`F11`) and the developer tools (`F12`) still work.

### Tabs

The first `just-doc book.pdf` opens the window. While it runs, every further
`just-doc other.pdf` adds the document as a new tab of the same window and
returns at once. `H` and `L` change the tab and `Ctrl+w` closes it; the
tab bar shows only when more than one document is open. Each tab keeps its
page, zoom, cursor and search.

All tabs belong to the first command, so stopping it with `Ctrl+C` closes
them all. If the window was closed but the command still runs, the next
`just-doc` opens a new window with the tabs.

### Cursor and visual selection

A blue block marks the cursor. It moves as in vim, so no mouse is needed:

| key | move |
|---|---|
| `h` / `l` | one character left / right |
| `w` / `b` / `e` | next word / start of the word / end of the word |
| `j` / `k` | one line down / up |
| `0` / `$` | start / end of the line |

A number first repeats the move: `3w`, `5j`. The page scrolls to follow the
cursor, and when you scroll the page the cursor stays on the screen. A click
puts the cursor on the clicked word.

`v` starts a selection at the cursor; `V` does the same but selects whole
lines. The same keys then extend the selection, also onto the next page, and
`o` switches to its other end. Press `a` to comment on the selection or `s` to
strike it through. `Esc` cancels.

In a selection, `i` and one more key select the thing around the cursor:

| keys | select |
|---|---|
| `iw` | the word |
| `is` | the sentence |
| `ip` | the paragraph |
| `i(` `i[` `i{` `i<` | the text inside the brackets around the cursor |
| `i"` `i'` | the text inside the quotes, straight or typographic |

So `vis` `a` comments on the sentence under the cursor. The selection can be
extended with the usual keys afterwards.

In vim, `a` is the "around" form (`va(` takes the brackets too). Here `a` in a
selection writes the comment, so `va(` does not exist; the capital `A` takes
its place: `vA(`, `vA"`.

A sentence ends at `.`, `?` or `!` before a capital letter, so it can stop too
early after an abbreviation that is not known. A PDF stores lines and not
paragraphs, so a paragraph is guessed from a larger gap between lines, an
indented first line or a change of the text size. Both stay on one page. A
margin note next to the text is left out of the sentence or paragraph, and it
is a paragraph of its own.

`c` and `P` remember their state between runs.

In the single page view, `j` on the last line and `k` on the first line turn
the page, and so do `PageDown` and `PageUp`. A selection stays on its page.

### Links and jumping back

Links inside the PDF (a reference to an equation, a citation, an entry of the
printed contents) are marked with a blue underline and work: put the cursor on one and press `Enter`, or click it.
`Ctrl+o` then returns to the place of the link, with the cursor where it was.
The same key returns from every other jump: a search, the contents panel,
`n` / `p`, `gg`, `G`. `Ctrl+i` goes forward again. A web link opens in the
browser.

### Search

`/` searches all pages, not only the ones on the screen. Lower-case text
matches both cases; a capital letter in the query makes the search exact. The
cursor moves to the match, so `v` can start a selection there. While a search
is active, `n` and `N` step through the matches and not through the comments.

## Where comments go

`book.pdf` → `book.comments.json`, in the same folder, rewritten after every
change. Each entry holds the selected `text`, the `comment`, and `rects`: page
number `p` and position in PDF points measured from the top-left corner.
An entry with `kind` `strike` is struck-through text that should be deleted,
and `kind` `box` is a rectangle; an entry without `kind` is a highlight.

`before` and `after` hold the letters and digits around the text, to find it
again in a changed document (see "When the document changes"); `was` is the
text as it was when it has changed since, and `lost` marks a comment whose
text is not found any more. `change` marks a comment on a change (`a` on
the card of a change, see "What changed"): it holds the text as it was before the change, and
an empty `text` with a `change` means that the text was removed.

A comment can have `replies`, a list of entries with `text`, the time `at` and
`from`, the name given with `--reply`. A reply without `from` was written in
the window. `done` marks a comment as done, and `done_at` holds when.

## Reviewing with a coding assistant

A coding assistant (Claude Code, opencode, pi or any other that can run shell
commands) can answer your comments in the window and fix the source, so the
whole review happens in just-doc. Tell it:

> Run `just-doc --guide`, then review `notes.md` with me.

`just-doc --guide` prints the instructions for the assistant: which commands
to run and how to read their output. Nothing is set up for a particular
assistant; it only runs the three commands below.

The round goes like this:

1. The assistant runs `just-doc notes.md --wait`. The window opens.
2. You write comments and press `Ctrl+Enter`. The message at the bottom says
   whether somebody is waiting for them.
3. The assistant replies. Each reply shows at once in the list. A blue mark
   in the toolbar counts the comments with a new reply, and so do the tab and
   the title of the window. `gn` goes to the next answered comment and `gN`
   back; a comment that you go to is no longer new.
   While no reply has come, the mark says that the comments are handed over.
   The changes in the document are marked too, and `gn` goes through them
   together with the replies (see "What changed").
4. To answer a reply, press `A` on its card (or on the selected comment),
   write in the field that opens at the bottom of the card, and press
   `Ctrl+Enter` again.

Each row of the list is two lines: a mark that says where the comment stands
(new reply, answered, waiting, done, not handed over), the page and the text;
then who spoke last and what. The selected comment has a red frame and its row
is open, with the whole conversation; `za` opens or closes a row, `zR` / `zM`
all of them. Below the comments, one closed line counts the changes that are a
`gn` stop of their own; the row that `gn` is on shows under it, and `za` on a
change (or a click on the line) shows them all.
5. When you agree, the assistant changes the source. The window loads the new
   version by itself and the comment is marked as done.

### The commands

```bash
just-doc book.pdf --wait
```

opens the document if it is not open, waits for `Ctrl+Enter` in the window,
prints the open comments and ends. A comment is open when it is not done and
you spoke last. A `Ctrl+Enter` pressed while nobody waits is kept for the next
`--wait`. With `--timeout 100` the command gives up after 100 seconds with
exit status 2, for an assistant whose shell limits the run time; it then runs
the command again.

```bash
just-doc book.pdf --reply 2 "it converges only for a simple root" --from Ana
```

adds a reply to comment 2: its number in the `--read` output, or its `id` from
`--read --json`. `--from` is the name shown on the reply. `--reply` can be
given several times in one command. The export writes the replies into the
note of the highlight.

```bash
just-doc book.pdf --done 2
```

marks comment 2 as done (`done` in the JSON file). Its highlight fades and
it is greyed in the list, under "answered since your Ctrl+Enter". At your
next `Ctrl+Enter` the done comments that you have looked at leave the page
and the list, so each round starts with what is still open; nothing leaves
before that. `D` shows them again, and the
top of the list says how many there are. The card says whether the comment is
done. Answering a done comment opens it again, so the next
`--wait` prints it. `--done` can be combined
with `--reply` and given several times.

`--read` prints all comments with their replies, and marks each one that is
`(done)` or `(answered)`.

### When the document changes

When the file of an open document changes on disk (the markdown or HTML file
was edited, the PDF was compiled again), the window loads it again by itself and
stays on the page. It then looks for the text of every comment in the new
version:

- Text that only moved, to another line or page, gets its highlight at the
  new place.
- Text that was changed is found by the text around it. What stands there
  now is marked green, and the list shows both: ~~«teh»~~ → «the». `--read`
  prints the new text and the old one. The card shows the old text above the
  replies.
- When the text around it is gone too, the comment keeps its old place and
  the list says "text not found". A short text, such as one word, is not
  looked for on other pages, because the same word stands in many places.
- A comment on a page that the new version does not have (it got shorter)
  goes to the end of the last page, also with "text not found".

Each comment remembers 120 letters and digits before and after its text for
this. A changed text next to another changed text is found as one piece, so
two comments can then point to the same new sentence. A rectangle (`r`) stays
where it was drawn. The search runs in the window, so a document that changed
while it was not open is handled when it is opened next.

### What changed

After a round you see the new document, but only the places you commented on.
After your first `Ctrl+Enter` everything that is not as it was then is marked:
changed and new text is underlined in blue, and a red line stands where text
was removed. A change has only a line and no fill, so it is not mistaken for
a comment, which is filled. `m` hides the marks and shows them again; `M` marks everything
that is not as it was at the last commit instead. The marks stay on when the
window loads a new version of the file.

A change with a wavy line was not asked for: no comment of the round is within two
lines of it. These are the ones to read first, when an assistant changed more
than you asked. A comment of the round is an open one, or one that was done
since your last `Ctrl+Enter`. A change near a comment belongs to it.

`gn` goes to the next thing to look at, in page order from the selected
comment or the cursor: a comment that the assistant answered (or marked done)
since your last `Ctrl+Enter`, or a change; changes a few lines apart on one
page are one stop, with a card that lists them. `gN` goes to the one before, so
`gn` then `gN` comes back to the same place; what you have seen stays in the
list. A card under it says who replied and what, with your comment above in
grey, and shows the changes that belong to it, each as a sentence with the old
words struck out in red and the new ones in green; the other changes have
cards of their own, which name your comment only when it is still open. The card counts where you are ("3 of 7") and what is not seen yet,
and what you have seen fades. `Esc` closes the card. On the card of a change, `a` comments on the change
itself: the box and the comment keep the change in view, and `--wait` shows
the assistant the text as it was before.

Words are compared, so a change in an equation, a figure or the layout is
easy to miss. `gb` covers the page at the cursor with the same page of the
old version; press `gb` again to flip back and see what moved.

The words of the two versions are compared in reading order, so text that
only moved to another line or page is not a change. Page numbers and running
heads are left out. Figures and the layout are not compared (use `gb`).

For "the last commit":

- A file that is in git (a markdown or HTML file, a PDF that is committed) is taken
  from the last commit.
- A PDF that is built from a source and is not in git has no version there.
  just-doc keeps a copy of it whenever a commit is made in its repository
  while the document is open, so compile the PDF before you commit. A PDF
  that is older than the last commit counts as that version too.

The copies are kept in the cache folder (`~/.cache/just-doc`).

### Rounds and history

Every `Ctrl+Enter` starts a round, and just-doc keeps a copy of the document
as it was then. The comment list puts what is new on top: the comments not
handed over yet, then the ones answered since your last `Ctrl+Enter`, then
the open ones; the older ones are greyed at the end.

`gh` opens the history, newest round first. `j` / `k` move through the rounds,
and the selected one shows the comments and replies you handed over, the
answers that came back, and the changes in the document from that
`Ctrl+Enter` to the next one (for the last round, to now). A click on a
comment goes to it.

`Enter` shows the document in the window as it was at the end of that round,
as if it were then: the version of the next `Ctrl+Enter`, the changes of the
round marked, and only the comments and replies there were by then. The
toolbar turns purple and says which round it is. This view is read only;
`gh` and `Enter` on the last round go back to now. `Esc` closes the history.

## Sharing the comments

The comments are not stored in the PDF, so other viewers do not show them.
`Ctrl+S` (or `--export`) writes `book.commented.pdf`: a copy of the PDF with
every highlight, strike-through and comment as an ordinary PDF annotation, readable in Okular,
Evince, Acrobat and others. The original PDF is never changed. The JSON file
stays the working copy; export again after adding comments.

## LaTeX: comment → source line

If `book.synctex.gz` is next to the PDF (compile with `-synctex=1`), `--read`
adds the `.tex` file and line for each comment:

```
[1] p. 37  /path/chapters/chapter_02.tex:1228
    text:    the roots are found with a method that always converges
    comment: too strong, say when it converges
```

The lookup uses the position of the comment in the PDF. After compiling again
the window moves the comments to their text in the new PDF (see "When the
document changes"), so the lines stay right as long as the document is open
in the window, or is opened once before `--read`.

## Markdown files

`just-doc notes.md` converts the file to a PDF with [pandoc](https://pandoc.org)
and opens that, so pandoc must be installed (with [typst](https://typst.app)
or a LaTeX installation to make the PDF; typst is used when it is found). The
PDF is kept in `~/.cache/just-doc` and made again when the markdown file has
changed. Comments go to `notes.comments.json` next to the markdown file, and
`--export` writes `notes.commented.pdf` there. `Ctrl+Shift+S` saves the PDF
without comments as `notes.pdf` next to the markdown file, replacing a
`notes.pdf` that is there.

A ```` ```mermaid ```` block is drawn as a diagram when `mmdc`
([mermaid-cli](https://github.com/mermaid-js/mermaid-cli)) is installed;
without it the block shows as code. The text in a diagram can be selected and
searched like the rest of the page.

`--read` adds the line in the markdown file for each comment. It finds the
line by searching for the selected text, so it also works after the file was
edited elsewhere; a text that occurs more than once gets its first line and a
note:

```
[1] p. 1  notes.md:3 (first of 2 places)
    text:    always converges
    comment: too strong
```

After the markdown file was edited, the highlights move to their text in the
new PDF (see "When the document changes").

## HTML files

`just-doc slides.html` prints the page to a PDF with the browser that shows the
window (Chromium, Brave or Chrome, run without a window) and opens that. The
rest is as for a markdown file: the PDF is kept in `~/.cache/just-doc` and made
again when the HTML file has changed, `Ctrl+Shift+S` saves it as `slides.pdf`,
and `--read` adds the line in the HTML file for each comment. Only the text of
the page is searched, not the tags, scripts, styles or title; text that a
script writes has no line.

The page decides the paper and the page breaks with its print rules, so a
slide deck needs them to get one slide per page:

```css
@page { size: 1280px 720px; margin: 0 }
section { page-break-after: always }
```

A [reveal.js](https://revealjs.com) deck does this by itself: the page is
opened as `slides.html?print-pdf`, which is reveal's print view. Scripts run
for up to ten seconds of page time before the page is printed. Pictures and
styles are loaded as the page links them, also from the internet.

A change in a linked file (a style sheet, a picture) is not seen; save the HTML
file again to make the PDF again.

## Third-party code

`web/pdfjs/` is a copy of [PDF.js](https://mozilla.github.io/pdf.js/) 4.10.38
(Apache License 2.0, see `web/pdfjs/LICENSE`).
