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
just-doc page.html --live  # an HTML page as it is, scripts running, to comment and answer
just-doc page.html --shot page.png   # a picture of that page, to check it before showing it
just-doc                   # list the open documents; open the window again if it was closed
just-doc book.pdf --wait   # open it, wait for Ctrl+Enter, then print the comments
just-doc book.pdf --reply 2 "text"   # add a reply to comment 2
just-doc --hc-terminal t12 # bring the window up with the last document from hc terminal t12
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

### After an update

One just-doc serves all open documents, and it keeps running after just-doc
was updated. The next `just-doc` command that finds it running another version
(the package version and a hash of its code, so an editable install with new
commits counts too) restarts it as the new version on the same port, with the
same tabs, the hc terminals they came from, the pages of other machines and a
`Ctrl+Enter` that no `--wait` has taken yet. Comments and answers are on disk
already. The window stays and loads itself again once nothing is being typed
in it; fields filled in on a live page keep it on the old version until `F5`.
The window of a just-doc older than this behaviour closes, and a new one opens.
Commands started at the same moment take turns (a lock file in the cache
folder), so they start, or update, one just-doc with one window between them.

While a `just-doc --wait` waits on it, it is not restarted: the command prints
one line saying so and is done by the old just-doc, or ends with that line when
the old one cannot do it. The update follows when the `--wait` ends and no
other `--wait` starts within a few seconds.

## Keys

| key | action |
|---|---|
| `a` | highlight the selection and write a comment; `Enter` in an empty field leaves a plain highlight. On a comment (the selected one, the one of the open card or the one under the cursor): edit what you wrote last, the comment or your last reply, while the assistant has not seen it; after that, reply (see "Reviewing with a coding assistant"); an empty field takes an edited reply away |
| `x` | mark the comment done yourself, when the assistant's answer needs no reply; `x` again opens it |
| `za` | open or close the row of the comment in the list, or on a change the group of changes; `zR` / `zM` open / close all rows |
| `D` | show or hide the comments that are done |
| `m` / `M` | mark what changed since the last hand-over / since the last commit; the same key again hides the marks (see "What changed") |
| `a` on the card of a change | comment on that change |
| `gb` | show the page at the cursor as it was before the changes; `gb` or `Esc` goes back |
| `gh` | history: the rounds so far, each with what you handed over, the answers and the changes; `Enter` shows the document as it was at the end of a round (see "Rounds and history") |
| `Ctrl` `Enter` | hand the comments over to the `just-doc --wait` that is waiting for them |
| `s` | strike through the selection: this text should be deleted |
| `r` | draw a rectangle (for a figure, an equation or code) and comment on it; a click with no drag puts a point instead, for a place with no text |
| `d` | delete the selected highlight or rectangle (click it first) |
| `u` | undo the last delete |
| `c` | hide or show the comment list, so the page gets the full width |
| `C` | hide or show the highlights and the link marks on the page, to read the clean text; the selected one stays visible |
| `n` / `p` | go to the next / previous in the comment list, top to bottom: the answered comments first, then the open ones, then the changes; done comments of earlier rounds are skipped unless `D` shows them; a card shows the reply, your comment and the changes near it (see "What changed"); `gn` / `gN` do the same |
| `Enter` | follow the link under the cursor (a click on a link does the same); `Tab` / `Shift` `Tab` move the cursor to the next / previous link on the page |
| `K` | preview the target of the link under the cursor: a crop of the target page in a popup (resting the mouse on a link does the same); `j` / `k` or the mouse wheel scroll it within the target page, a click on it goes there, `Esc` or `K` closes it |
| `Ctrl` `o` / `Ctrl` `i` | jump back to where you were before a jump / forward again; the back / forward buttons of the mouse do the same |
| `/` | search the whole PDF: type the text, `Enter`; then `n` / `N` go to the next / previous match and `Esc` ends the search |
| `t` | table of contents: `j` / `k` move, `Enter` goes there, `Esc` closes |
| `h` `j` `k` `l`, `w` `b` `e`, `0` `$` | move the cursor (see below); the page follows it |
| `↓` / `↑` | move the cursor a line down / up, as `j` / `k` do; also in a selection |
| `f` / `F` + a character | move the cursor to that character after / before it on the line (`fa`, `3fa`); the wait for the character ends after 1.5 s |
| `;` / `,` | repeat the last `f` or `F` / repeat it the other way |
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
puts the cursor on the clicked character.

`v` starts a selection at the cursor; `V` does the same but selects whole
lines. The same keys then extend the selection, also onto the next page, and
`o` switches to its other end. Press `a` to comment on the selection or `s` to
strike it through. `Esc` cancels. Text selected with the mouse (a drag, a
double or a triple click) is the same selection: the cursor is at its end and
the keys go on from there.

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
To look at the target without going there, rest the mouse on the link or press `K`: a popup shows that part of the target page. The wheel or `j` / `k` scroll it
up and down within that page.
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
change (a page shown with `--live` has its own, see "Comments on a live page"). Each entry holds the selected `text`, the `comment`, and `rects`: page
number `p` and position in PDF points measured from the top-left corner.
An entry with `kind` `strike` is struck-through text that should be deleted,
`kind` `box` is a rectangle, and `kind` `pin` is a point: its one rectangle has
no size, `text` is empty, and `near` holds the text line just above it. An
entry without `kind` is a highlight.

`before` and `after` hold the letters and digits around the text, to find it
again in a changed document (see "When the document changes"); `was` is the
text as it was when it has changed since, and `lost` marks a comment whose
text is not found any more. `n` is the number of the comment, given when it is
written; it never changes, and the window, `--read`, `--wait` and `--reply`
use it. `change` marks a comment on a change (`a` on
the card of a change, see "What changed"): it holds the text as it was before the change, and
an empty `text` with a `change` means that the text was removed.

A comment can have `replies`, a list of entries with `text`, the time `at` and
`from`, the name given with `--reply`. A reply without `from` was written in
the window. `done` marks a comment as done, and `done_at` holds when. `seen`
lists the times a `just-doc --wait` showed the comment to the assistant.

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
   the title of the window. The answered comments come first in the list,
   and `n` goes through them from the top; a comment that you go to is no
   longer new. While no reply has come, the mark says that the comments are
   handed over; while a `just-doc --wait` waits for you, a green mark says
   so, and an amber one says that no `--wait` has taken your `Ctrl+Enter`
   yet: the assistant has to run `--wait` again. The replies come one by
   one while the assistant works ("the assistant is answering … 2 replies
   so far"); when it waits again, its answers are complete: a large green
   mark says "✓ answers ready", a message pops up, and the title of the
   window and the tab get a ✓. The changes in the document are marked too, and come last in
   the list (see "What changed").
4. To answer a reply, press `a` on its card (or on the selected comment),
   write in the field that opens at the bottom of the card, and press
   `Ctrl+Enter` again. Before `Ctrl+Enter`, `a` again edits that reply.
   When the answer needs no reply, press `x` to mark the comment done.
5. When you agree, the assistant changes the source. The window loads the new
   version by itself and the comment is marked as done.

Each row of the list is two lines: a mark that says where the comment stands,
the page and the text;
then who spoke last and what. The selected comment has a red frame and its row
is open, with the whole conversation; `za` opens or closes a row, `zR` / `zM`
all of them. Below the comments, one closed line counts the changes that have
no comment; the row that `n` is on shows under it, and `za` on a
change (or a click on the line) shows them all.

The marks (the `?` key list explains them too):

| mark | meaning |
|---|---|
| not handed over | written or answered after your last `Ctrl+Enter` |
| not seen yet | handed over, but no `--wait` has shown it to the assistant yet |
| seen 10:42, no reply | the assistant was shown it then and neither answered nor marked it done |
| new reply / new: done | the assistant answered or marked it done, and you have not looked yet |
| answered | the assistant spoke last and you have looked at it |
| done ✓ | done; it leaves the list at your next `Ctrl+Enter` |
| change | a change since the last hand-over that no comment asked for |

When the assistant is shown a comment again that it left unanswered before,
`--wait` marks it with "(shown to you before and not answered)".

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

adds a reply to comment 2: its number (`#2` in the window, `[2]` in the
`--read` output), or its `id` from `--read --json`. The number stays with the
comment, also when the document changes and the comments move. `--from` is the name shown on the reply. `--reply` can be
given several times in one command. The export writes the replies into the
note of the highlight.

```bash
just-doc book.pdf --done 2
```

marks comment 2 as done (`done` in the JSON file). Its highlight fades and
it is greyed in the list. At your
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
two comments can then point to the same new sentence. A rectangle or a point
(`r`) stays where it was drawn. The search runs in the window, so a document that changed
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

`n` and `p` go through the comment list as it is shown, from the selected
comment (or the first one after the cursor): the comments that the assistant
answered (or marked done) since your last `Ctrl+Enter`, the open ones, and
last the changes that have no comment. The comments that were done before
that are skipped, unless `D` shows them; changes a few lines
apart on one page are one stop, with a card that lists them. `n` then `p`
comes back to the same place; a click on a comment, in the list or on the page,
opens its card too. A card beside the page (the pages move left to make room for it; under the text when the window is too narrow) says who replied and what, with your comment above in
grey, and shows the changes that belong to it, each as a sentence with the old
words struck out in red and the new ones in green; the other changes have
cards of their own, which name your comment only when it is still open. The card says where you are ("3 of 7"); the toolbar counts what you have not looked at yet,
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
as it was then. The comment list is always in page order, top to bottom;
the mark on each row says whether it is new, answered or still open, and
the comments done before the last `Ctrl+Enter` are greyed. The changes that
no comment asked for come after the comments.

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
every highlight, strike-through, rectangle, point (a sticky note) and comment as an ordinary PDF annotation, readable in Okular,
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

## Live pages

`just-doc page.html --live` shows an HTML page as it is, with its scripts
running, as a tab of the just-doc window: a Plotly plot zooms, a three.js model
turns. The tab carries a green `live` mark, a green dot while another tab is
shown, and the tab bar shows also when the live page is the only tab. Its comments are kept apart from those of the
PDF of the same file (see "Comments on a live page"); without `--live` the
same file is printed to a PDF for commenting as before, and both can be open
at the same time.

The page is served from its own folder, so its relative links (pictures,
scripts, data files) work; nothing outside that folder is served. When the
HTML file changes, the page is loaded again and keeps its scroll position. A
change in another file of the folder is not seen; save the HTML file again.

just-doc serves Plotly and three.js at fixed addresses, so a page that an
assistant writes needs neither the internet nor copies of them:

```text
/_lib/page.css                         a small style sheet: a readable text column, light
                                       and dark, tables, and the classes card, grid, stat,
                                       plot (480 px high), view (75 % of the window high),
                                       controls and pair; plots and views use the full width
/_lib/plotly.min.js                    Plotly 4.1.2, the global Plotly; plots follow light and
                                       dark and the width of the window by themselves
                                       (colours in the layout and config.responsive win)
/_lib/three/three.module.js            three.js r186 as an ES module
/_lib/three/addons/OrbitControls.js    also GLTFLoader.js and STLLoader.js
/_lib/three/touchpad.js                touchpad(controls): two-finger scroll pans, pinch
                                       zooms, shift + scroll turns; a mouse wheel zooms
```

The three.js add-ons import `three.module.js` by a relative path, so a page
needs no import map. A plot:

```html
<!doctype html>
<meta charset="utf-8">
<title>Frequency response</title>
<link rel="stylesheet" href="/_lib/page.css">
<script src="/_lib/plotly.min.js"></script>
<h1>Frequency response</h1>
<div id="plot" class="plot"></div>
<script>
  const f = Array.from({length: 500}, (_, i) => i * 0.2);
  const H = f.map(x => 1 / Math.hypot(1 - (x / 40) ** 2, 0.05 * x / 40));
  Plotly.newPlot('plot', [{x: f, y: H}], {xaxis: {title: {text: 'f [Hz]'}},
    yaxis: {type: 'log', title: {text: '|H|'}}}, {responsive: true});
</script>
```

and a model that turns with the mouse, with its controls above it:

```html
<!doctype html>
<meta charset="utf-8">
<title>Part</title>
<link rel="stylesheet" href="/_lib/page.css">
<h1>Bracket</h1>
<div class="controls">
  <label>Scale <input id="scale" type="range" min="0.2" max="2" step="0.1" value="1"> <output id="scale-v">1.0</output></label>
  <label><input id="wire" type="checkbox" class="toggle"> wireframe</label>
</div>
<div id="view" class="view"></div>
<p>What the view shows and what to look at.</p>
<script type="module">
  import * as THREE from '/_lib/three/three.module.js';
  import { OrbitControls } from '/_lib/three/addons/OrbitControls.js';
  import { touchpad } from '/_lib/three/touchpad.js';
  const box = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({antialias: true});
  box.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(3, 2, 4);
  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 128, 16), new THREE.MeshNormalMaterial());
  scene.add(mesh);
  const controls = new OrbitControls(camera, renderer.domElement);
  // two-finger scroll pans, pinch zooms, shift + scroll turns; a mouse wheel zooms
  touchpad(controls);
  // the view follows the width of the page, which narrows while the comment panel is open
  new ResizeObserver(() => {
    renderer.setSize(box.clientWidth, box.clientHeight);
    camera.aspect = box.clientWidth / box.clientHeight;
    camera.updateProjectionMatrix();
  }).observe(box);
  const scale = document.getElementById('scale');
  scale.oninput = () => {
    mesh.scale.setScalar(+scale.value);
    document.getElementById('scale-v').value = (+scale.value).toFixed(1);
  };
  document.getElementById('wire').onchange = e => mesh.material.wireframe = e.target.checked;
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
</script>
```

### Layout

`just-doc page.html --shot page.png [--size 1500x900]` saves a picture of the
page as it looks live, so an assistant can check the layout before it shows
the page. The page is served by a just-doc inside the command, so `/_lib/`
works, and a headless Chromium, Brave or Chrome draws it; it waits until the
page is still (plots drawn), up to eight seconds of page time, with WebGL in
software. Nothing opens in the window. Without a browser that starts, the
command ends with status 1 and "no browser to take a screenshot here; check
the layout in the HTML".

Decide the layout for each page. What matters most (a 3D model, a plot) gets
the full width: `page.css` gives `.plot` and `.view` the full width of the page
and keeps text in a readable column. The page narrows while the comment panel
is open; Plotly follows it by itself, a three.js view with a `ResizeObserver`
as in the example. The sliders, choices and switches of a plot or a view
usually go in a bar above it, `<div class="controls">`. Put parts side by side
only when each still has enough room: `<div class="pair">` (or a `.grid`)
puts two side by side while each gets 560 px, otherwise one above the other.
A control needs a name only when its value should be handed over with
`Ctrl+Enter`. Do not enable damping in `OrbitControls`: the model must stop
when the user lets go.

### Answers from a live page

A live page can ask questions with plain form fields; it needs no script.
Every field with a `name` counts: text fields, text areas, selects, radios and
checkboxes. A choice keeps its state and can be changed until `Ctrl+Enter`
hands all fields over, as `Ctrl+Enter` does in a PDF. `page.css` shows radios
in a `<fieldset class="choice">` as pills and a checkbox with
`class="toggle"` as a switch:

```html
<!doctype html>
<meta charset="utf-8">
<title>Mount</title>
<link rel="stylesheet" href="/_lib/page.css">
<h1>Which mount?</h1>
<fieldset class="choice"><legend>Variant</legend>
  <label><input type="radio" name="variant" value="A"> A: four bolts</label>
  <label><input type="radio" name="variant" value="B"> B: clamp</label>
  <label><input type="radio" name="variant" value="C"> C: glued</label>
</fieldset>
<p><label><input type="checkbox" class="toggle" name="damping"> add rubber damping</label></p>
<p><label>Notes<br><textarea name="notes"></textarea></label></p>
<p class="muted">Press Ctrl+Enter when you are done.</p>
```

The answers are written to `page.answers.json` next to the page, one round per
`Ctrl+Enter`, and

```bash
just-doc page.html --live --wait   # opens the page if needed, waits for Ctrl+Enter, prints open comments and answers
just-doc page.html --live --read   # prints all comments and the answers of the last Ctrl+Enter
```

print the last round after the comments (see "Comments on a live page"):

```text
answers (round 1, 2026-11-25T10:31:07.512Z):
{"variant": "B", "damping": true, "notes": "clamp must not scratch"}
```

A single checkbox gives true or false, checkboxes that share a name the list of
the checked values, radios the chosen value (null: none), a select with
`multiple` a list. A form is not sent anywhere, and buttons count for nothing.
Without `--live`, `--wait` and `--read` are about the comments of the PDF of
the same file, as before. On a page of another machine the answers are kept on
that machine, where its agent runs `--wait`.

### Comments on a live page

A live page is commented as a PDF is, and its plots and models keep working.
Select text and press `a`, or point at an element with the mouse (a plot, a
figure, a table) and press `a`. The comments are listed in a panel at the
right of the window; the page narrows to make room and keeps its own layout.
On the page they are marked over it: selected text is highlighted, an element
is outlined, with a dot where the mouse was and its number `#n`.

| key (outside a text field) | action |
|---|---|
| `a` | comment on the selected text, or on the element under the mouse; on the selected comment: edit what you wrote last while the assistant has not seen it, after that reply |
| `Enter` / `Shift` `Enter` / `Esc` | in the comment field: save / new line / cancel |
| `x` | mark the selected comment done; again opens it |
| `za` | open or close the row of the selected comment in the list |
| `n` / `p` | select the next / previous comment and scroll the page to it; a click on a row or a `#n` mark does the same |
| `d` / `u` | delete the selected comment / undo the delete |
| `c` | hide or show the comment panel |
| `Esc` | unselect the comment |
| `Ctrl` `Enter` | hand the comments and the answers over to the `just-doc --live --wait` that waits |

`Alt+Left` / `Alt+Right`, `Ctrl+w` and, outside a text field, `H` / `L`
still change or close the tab. All other keys belong to the page.

The comments are kept in `page.live.comments.json` next to the page, with the
fields of the PDF comments where they apply (`n`, `text` for the quote,
`comment`, `created`, `replies`, `done`, `done_at`, `seen`), and in addition:

```json
{
 "kind": "text",
 "anchor": {"id": "fig-psd", "src": "plots.py:120", "path": "figcaption:nth-of-type(1)",
            "selector": "body > section:nth-of-type(2) > figure:nth-of-type(1) > figcaption:nth-of-type(1)",
            "tag": "figcaption", "quote": "peak at 42 Hz", "prefix": "Figure 3: ", "suffix": " is the first",
            "at": null},
 "detached": false
}
```

`kind` is `text` (selected text) or `element` (the element under the mouse;
`at` is where the mouse was, as fractions of its width and height). The HTML
file is never written to: the anchor finds the place again when the page is
loaded. A comment is placed by `id` (the id, or the `data-src`, of the element
or of its nearest ancestor that has one; for text the quote is searched inside
it), then by the quote with the text before and after it, then by the CSS
`selector`. A comment on an element is put on the nearest element with an id
or `data-src` around the mouse. A comment that cannot be placed stays in the
list, marked `detached`, and is never dropped. So give sections, figures and
plots an `id`, and where it helps `data-src="plots.py:120"` for the code that
makes them; then a comment stays in place when the page is rewritten, and the
assistant knows where to change it.

`--live --wait` and `--live --read` print the comments as `--wait` and
`--read` do for a PDF, with the anchor in place of the page:

```text
[2] #fig-psd  plots.py:120
    text:    peak at 42 Hz
    comment: is this the first mode?
    selector: body > section:nth-of-type(2) > figure:nth-of-type(1) > figcaption:nth-of-type(1)
    reply (assistant): yes, the first bending mode

answers (round 1, 2026-11-25T10:31:07.512Z):
{"damping": true}
```

With `--json` they print `{"comments": [...], "answers": {"round", "at",
"answers"} or null}`. `--live --reply N "text"` and `--live --done N` answer
and close a comment; the panel shows it at once. On a page of another machine
the comments are kept on that machine, next to the page, where its agent
reads them.

Limits: a comment is on text or on a whole element, not on a point inside a
plot's data (the dot shows where the mouse was, and moves with the element, not
with the data); text inside a canvas or a WebGL view cannot be selected; the
comment keys work once the page has finished loading.

## The last document of a terminal

When `just-doc FILE` (with or without `--live`) runs in a shell where
`HC_TERMINAL_ID` is set, as in an hc or herdr terminal pane (for example
`t12`), the document is noted with that terminal. Then

```bash
just-doc --hc-terminal t12
```

shows the tab of the document that was opened or changed last from that
terminal and brings the just-doc window to the front (on Hyprland, through
`hyprctl`; elsewhere only the tab changes). It is meant for a key binding: when
no running just-doc has a document from that terminal, it prints a short
message to stderr, exits with status 1 and opens nothing.

### Pages of another machine

An agent on another machine (an hc machine reached over ssh) runs
`just-doc page.html --live` there as usual. Without a display (no
`WAYLAND_DISPLAY` or `DISPLAY`) just-doc opens no window; its server runs on
127.0.0.1 there and notes the terminal. On that machine

```bash
just-doc --hc-terminal t12 --print   # {"port": 8700, "id": ..., "name": ..., "url": "/live/...", ...}
```

prints where the terminal's latest document is (status 1: none). Here,

```bash
just-doc --hc-terminal t12 --hc-machine work2
```

asks `work2` over ssh (`just-doc --hc-terminal t12 --print`), forwards a local
port to the just-doc there (`ssh -N -L`, also through an open shared connection
of the host), and shows the page as a tab named `work2: page.html`. The page,
its relative files and its changes come through the forward; `/_lib/` comes
from the just-doc here. The forward closes ten minutes after the tab was
closed or the window was closed, and when just-doc stops. Only live pages of
another machine are shown. With `--hc-machine ""` the terminal is one of this
machine, so a key binding can always pass `$HC_FOCUSED_MACHINE`:

```bash
just-doc --hc-terminal "$HC_FOCUSED_TERMINAL" --hc-machine "$HC_FOCUSED_MACHINE"
```

The machine name is taken as the ssh target, unless `hc machine ls` names
another target for it, or `~/.config/just-doc/config.json` does:

```json
{"machines": {"lab": {"target": "klemen@lab.example.org", "just-doc": "~/bin/just-doc"}}}
```

`just-doc` there is run as `PATH="$HOME/.local/bin:$PATH" just-doc` unless the
config names another command; a top-level `"ssh"` replaces the ssh command.
ssh runs with `BatchMode=yes`, so the host must be reachable without typing a
password (a key in the agent).

## Third-party code

`web/pdfjs/` is a copy of [PDF.js](https://mozilla.github.io/pdf.js/) 4.10.38
(Apache License 2.0, see `web/pdfjs/LICENSE`).

`web/_lib/plotly.min.js` is [Plotly](https://plotly.com/javascript/) 4.1.2 (MIT)
and `web/_lib/three/` is [three.js](https://threejs.org) r186 (0.186.1, MIT),
taken from the npm packages; their licences are in `web/_lib/licenses/`. In
the three.js add-ons and utils the import from `'three'` is changed to
`'../three.module.js'`; nothing else is changed. just-doc serves `/_lib/plotly.min.js` with
`web/_lib/plotly-theme.js` (ours) appended: it gives every plot a default
template with a transparent background and text and grid colours that suit the
page (the colours of `page.css` when it is linked), and draws the plots again
when the system switches between light and dark. Colours in a page's own
layout, and a template it sets, win.
