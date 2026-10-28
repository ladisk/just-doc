#!/usr/bin/env python3
"""just-doc -- highlight and comment a PDF in a local window.

Comments are written to ``<name>.comments.json`` next to the PDF, so a script
(or a coding assistant) can read exactly which text each comment refers to.

Usage
-----
    just-doc book.pdf            open the PDF for commenting
    just-doc notes.md            the same for a markdown file (needs pandoc)
    just-doc slides.html         the same for an HTML file (needs Chromium,
                                 Brave or Chrome)
    just-doc other.pdf           while a window is open: a new tab in it
    just-doc book.pdf --read     print the comments (with source lines if
                                 book.synctex.gz is next to the PDF)
    just-doc book.pdf --export   write book.commented.pdf with the comments
                                 as ordinary PDF annotations
    just-doc book.pdf --wait     open it, wait for Ctrl+Enter in the window,
                                 then print the comments
    just-doc book.pdf --reply 2 "text"
                                 add a reply to comment 2
    just-doc book.pdf --done 2   mark comment 2 as done
    just-doc --guide             print how a coding assistant uses the three
                                 commands above to review a document with you
"""
import argparse
import getpass
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parent / "web"
PORT = 8700
# changes with the code, so a command can tell that the running just-doc is another version
VERSION = hashlib.sha1(Path(__file__).read_bytes()).hexdigest()[:8]
MARKDOWN = (".md", ".markdown")
HTML = (".html", ".htm")
# typst rules for the tables of a markdown file: cell text ragged right, the
# header bold, a line above and below, and a long table continued on the next page
TABLE_STYLE = """\
#show table: set par(justify: false)
#show table.cell: set align(left)
#show figure.where(kind: table): set block(breakable: true)
#set table(stroke: (x, y) => if y == 0 { (top: 0.8pt) })
#show table: it => layout(size => {
  let head = it.children.any(c => c.func() == table.header)
  show table.cell.where(y: 0): c => if head { strong(c) } else { c }
  it
  v(0pt, weak: true)
  line(length: measure(it, width: size.width).width, stroke: 0.8pt)
})
"""
# put at the top of an HTML page that is printed: its folder for the links, and
# frames from a timer, as a headless browser on page time draws none
PRINT_HEAD = """<base href="{base}"><script>
window.requestAnimationFrame = f => setTimeout(() => f(performance.now()), 16);
window.cancelAnimationFrame = id => clearTimeout(id);
</script>"""
MERMAID = re.compile(r"^```+ *\{?\.?mermaid\}? *\n(.*?)^```+ *$", re.M | re.S)
WRITING = threading.Lock()   # held while the comments file is read, changed and written back
GUIDE = """\
just-doc: review a document together with its author

The author reads a PDF, a markdown or an HTML file in the just-doc window and writes
comments on pieces of its text. You answer the comments and fix the source.
Everything goes through these commands; do not edit the .comments.json file.

1. Open the document and wait for the comments:

       just-doc FILE --wait

   The command opens the window if needed and blocks until the author presses
   Ctrl+Enter there. It then prints the open comments and ends. If your shell
   limits the run time, add --timeout SECONDS (below the limit) and run the
   command again when it reports that nothing came; a Ctrl+Enter pressed in
   between is kept. Run it in the background if you can.

   Keep a --wait running for as long as the review goes on, and do not end
   your turn without one: an idle session does not notice a Ctrl+Enter, and
   the author waits in vain.

2. Read the comments. Each one looks like this:

       [3] p. 12  chapter.tex:140
           text:    the selected text
           comment: what the author says about it
           reply (NAME): an earlier reply
           reply (author): the author's answer to it

   3 is the number of the comment, p. 12 the page, and chapter.tex:140 the
   place in the source when it is known (for markdown and HTML, and for
   LaTeX with SyncTeX). "delete:" instead of "text:" means that the author wants this
   text removed. "area:" is a rectangle around a figure, an equation or code.
   "point:" is a spot on the page with no text, such as a place where
   something is missing; it gives the text line just above the spot.
   A comment without words is a plain highlight: ask what is meant.
   "text" is the text as it stands in the document now; when it was changed
   after the comment was written, a line below gives the text as it was.
   A comment can be about a change you made: then a line gives the text as
   it was before your change, and "removed:" stands for text you deleted.

3. Answer every open comment, in the language of the comment, in a sentence
   or two; the list in the window is narrow:

       just-doc FILE --reply 3 "text" --reply 5 "text" --from NAME

   The replies show in the window at once. Ask there when a comment is not
   clear. Do not change the source for a comment that asks a question or that
   you disagree with: reply and wait for the answer.

   When the author only agrees or confirms ("ok", "good", "done", "thanks"),
   there is nothing more to say: mark the comment as done (--done 3), with a
   short reply if one helps. Leave no open comment without either; the window
   shows the author which comments you were shown and left unanswered, and
   --wait marks such a comment with "(shown to you before and not answered)".

4. When a comment asks for a change, change the source file (for LaTeX,
   compile it again). The window loads the new version by itself. Then say
   what you did and mark the comment as done:

       just-doc FILE --reply 3 "what was changed" --done 3 --from NAME

5. Go back to step 1, until the author says that the review is over. Start
   the next --wait only after you answered every comment: the window shows
   your replies as they come, and takes a waiting --wait as the sign that
   your answers are complete.

Other commands: just-doc FILE --read prints all comments, also the ones that
are done or answered; add --json for the full data.
"""
BROWSERS = ("chromium", "brave", "google-chrome-stable", "google-chrome", "chromium-browser")


def comments_path(doc):
    """Return the path of the comments file that belongs to ``doc``."""
    return doc.with_suffix(".comments.json")


def load_comments(doc):
    path = comments_path(doc)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"annots": []}


def save_comments(doc, annots):
    out = {"source": doc.name, "annots": annots}
    tmp = comments_path(doc).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, comments_path(doc))


def find_comment(doc, annots, ref):
    """Return the comment ``ref``: its number in the file or its id."""
    for a in annots:
        if a.get("id") == ref:
            return a
    if ref.isdigit() and 0 < int(ref) <= len(annots):
        return annots[int(ref) - 1]
    raise RuntimeError(f"no comment {ref} in {comments_path(doc).name}")


def now_stamp():
    """Return the current UTC time as ``YYYY-MM-DDTHH:MM:SS.mmmZ``, as the window writes it."""
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t % 1 * 1000):03d}Z"


def stamp_key(stamp):
    """Return a sort key for a time stamp with or without milliseconds.

    A missing or unreadable stamp sorts first.
    """
    try:
        m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z?", stamp)
        return (time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S"), int((m.group(2) or "0")[:3].ljust(3, "0")))
    except (TypeError, AttributeError, ValueError):
        return (time.gmtime(0), -1)


def answer(doc, ref, text, name):
    """Add a reply to the comment ``ref``; without a text mark the comment as done."""
    with WRITING:
        annots = load_comments(doc)["annots"]
        a = find_comment(doc, annots, ref)
        if text is None:
            a["done"] = True
            a["done_at"] = now_stamp()
        else:
            a.setdefault("replies", []).append(
                {"from": name, "text": text, "at": now_stamp()})
        save_comments(doc, annots)


def spoke_at(a):
    """Return when the author last said something on a comment: its creation or their last reply."""
    return max([a.get("created")] + [r.get("at") for r in a.get("replies", []) if not r.get("from")], key=stamp_key)


def mark_seen(doc):
    """Note on each open comment that a --wait shows it to the assistant now."""
    with WRITING:
        annots = load_comments(doc)["annots"]
        now = now_stamp()
        for a in annots:
            if is_open(a):
                a.setdefault("seen", []).append(now)
        save_comments(doc, annots)


def keep_replies(doc, annots):
    """Put the replies and done marks that are in the file but not in ``annots`` back in.

    The window sends the whole list after each change; a reply that was added
    from outside a moment before is not in it yet.
    """
    old = {a.get("id"): a for a in load_comments(doc)["annots"]}
    for a in annots:
        was = old.get(a.get("id"), {})
        missing = [r for r in was.get("replies", []) if r not in a.get("replies", [])]
        if missing:
            a["replies"] = sorted(a.get("replies", []) + missing, key=lambda r: stamp_key(r.get("at")))
        # a --wait that showed the comment to the assistant a moment ago
        if len(was.get("seen", [])) > len(a.get("seen", [])):
            a["seen"] = was["seen"]
        # the window sets done to false when the author answers a comment that was done
        if was.get("done") and "done" not in a:
            a["done"] = True
            if "done_at" in was:
                a["done_at"] = was["done_at"]


def cache_dir():
    path = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "just-doc"
    path.mkdir(parents=True, exist_ok=True)
    return path


def draw_diagrams(text):
    """Replace the mermaid blocks of a markdown ``text`` with pictures.

    Each diagram is drawn once with mmdc (mermaid-cli) and kept in the cache
    folder under a name made from its content. Without mmdc, and for a
    diagram with an error, the block stays as it is and shows as code.
    """
    if not shutil.which("mmdc"):
        return text

    def picture(match):
        code = match.group(1)
        out = cache_dir() / ("mermaid-" + hashlib.sha1(code.encode()).hexdigest()[:16] + ".pdf")
        if not out.exists():
            src = out.with_suffix(".mmd")
            src.write_text(code, encoding="utf-8")
            res = subprocess.run(["mmdc", "-i", str(src), "-o", str(out), "--pdfFit"], capture_output=True)
            src.unlink()
            if res.returncode or not out.exists():
                return match.group(0)
        return f"![]({out})\n"

    return MERMAID.sub(picture, text)


def is_converted(doc):
    """Whether ``doc`` is a source that is converted to a PDF (markdown or HTML)."""
    return doc.suffix.lower() in MARKDOWN + HTML


def shown_pdf(doc):
    """Return the PDF that is shown for ``doc``.

    A PDF is shown as it is. A markdown or an HTML file is converted into a
    PDF in the cache folder, again whenever the file or this code is newer.
    """
    if not is_converted(doc):
        return doc
    out = kept(doc, "shown")
    if not out.exists() or out.stat().st_mtime < max(doc.stat().st_mtime, Path(__file__).stat().st_mtime):
        convert(doc, None, out)
    return out


def convert(doc, text, out):
    """Write ``doc`` as a PDF to ``out``; ``text`` is its content, or None for the file as it is."""
    if doc.suffix.lower() in HTML:
        print_html(doc, text, out)
        return
    if not shutil.which("pandoc"):
        raise RuntimeError("a markdown file needs pandoc (https://pandoc.org) to be installed")
    if text is None:
        text = doc.read_text(encoding="utf-8")
    # headings get the ids GitHub gives them, so the #links written for GitHub find their target
    cmd = ["pandoc", "--from=markdown+gfm_auto_identifiers", "-o", str(out)]
    if shutil.which("typst"):
        # a wide --columns lets typst size the table columns to their text
        cmd += ["--pdf-engine=typst", "--columns=10000", "-V", "header-includes=" + TABLE_STYLE]
    res = subprocess.run(cmd, cwd=doc.parent, input=draw_diagrams(text), capture_output=True, text=True,
                         encoding="utf-8")
    if res.returncode:
        raise RuntimeError(f"pandoc could not convert {doc.name}:\n{res.stderr.strip()}")


def print_html(doc, text, out):
    """Print the HTML file ``doc`` to the PDF ``out`` with a headless browser.

    The page sets the paper size and the page breaks with its print rules
    (``@page``); a reveal.js deck gets one slide per page through
    ``?print-pdf``. Scripts run for up to ten seconds of page time first.
    ``text`` is printed in place of the file, or the file itself when it is
    None. A copy in a temporary folder is printed, with its pictures and
    styles taken from the folder of ``doc``.
    """
    exe = next((shutil.which(name) for name in BROWSERS if shutil.which(name)), None)
    if exe is None:
        raise RuntimeError("an HTML file needs Chromium, Brave or Chrome to be installed")
    if text is None:
        text = doc.read_text(encoding="utf-8")
    at = re.search(r"<head[^>]*>", text, re.I) or re.search(r"<!doctype[^>]*>", text, re.I)
    at = at.end() if at else 0
    text = text[:at] + PRINT_HEAD.format(base=doc.parent.as_uri() + "/") + text[at:]
    with tempfile.TemporaryDirectory(prefix="just-doc-") as tmp:
        page = Path(tmp) / doc.name
        page.write_text(text, encoding="utf-8")
        # an own profile, so a browser window that is open does not take the job over
        cmd = [exe, "--headless", "--disable-gpu", f"--user-data-dir={tmp}/profile", "--no-pdf-header-footer",
               "--virtual-time-budget=10000", f"--print-to-pdf={out}", page.as_uri() + "?print-pdf"]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"{Path(exe).name} did not finish printing {doc.name}") from None
    if res.returncode or not out.exists():
        raise RuntimeError(f"{Path(exe).name} could not print {doc.name}:\n{res.stderr.strip()}")


def kept(doc, what):
    """Return the path in the cache folder of a PDF that is kept for ``doc``.

    ``what`` is "shown" (a markdown or an HTML file as a PDF), "handed" (the PDF at the
    last Ctrl+Enter), "commit" (the PDF at the last commit) or "round3" (the
    PDF at the third Ctrl+Enter).
    """
    name = hashlib.sha1(str(doc).encode()).hexdigest()[:16]
    return cache_dir() / (name + (".pdf" if what == "shown" else f".{what}.pdf"))


def rounds(doc):
    """Return the times of the Ctrl+Enter presses in ``doc``, one per round, oldest first."""
    note = kept(doc, "handed").with_suffix(".rounds.json")
    try:
        return json.loads(note.read_text())
    except (OSError, ValueError):
        # a hand-over from before rounds were kept is the first round
        old = kept(doc, "handed")
        if not old.exists():
            return []
        shutil.copyfile(old, kept(doc, "round1"))
        note.write_text(json.dumps([old.stat().st_mtime]))
        return [old.stat().st_mtime]


def new_round(doc):
    """Keep the document as it is at a Ctrl+Enter: the start of a new round."""
    times = rounds(doc) + [time.time()]
    shutil.copyfile(shown_pdf(doc), kept(doc, "handed"))
    shutil.copyfile(kept(doc, "handed"), kept(doc, f"round{len(times)}"))
    kept(doc, "handed").with_suffix(".rounds.json").write_text(json.dumps(times))


def git(doc, *args):
    """Run git in the folder of ``doc``; return its output, or None when it fails."""
    try:
        res = subprocess.run(["git", "-C", str(doc.parent), *args], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return None if res.returncode else res.stdout


def head_log(doc):
    """Return the file of the repository of ``doc`` that changes with every commit, or None."""
    out = git(doc, "rev-parse", "--absolute-git-dir")
    return Path(out.decode().strip()) / "logs" / "HEAD" if out else None


def commit_pdf(doc, log, now=False):
    """Return the PDF of ``doc`` as it was at the last commit, or None when it is not known.

    A file that is in git is taken from there. A PDF that is not, because it
    is built from a source, is copied when a commit is made while it is open
    (``now``) and when it is older than the last commit; ``log`` is the file
    from ``head_log``.
    """
    out, note = kept(doc, "commit"), kept(doc, "commit").with_suffix(".id")
    was = note.read_text() if note.exists() and out.exists() else ""
    blob = git(doc, "rev-parse", "-q", "--verify", "HEAD:./" + doc.name)
    try:
        if blob:
            mark = blob.decode().strip()
            if was != mark:
                data = git(doc, "show", "HEAD:./" + doc.name)
                if data is None:
                    return None
                if is_converted(doc):
                    convert(doc, data.decode("utf-8"), out)
                else:
                    out.write_bytes(data)
                note.write_text(mark)
            return out
        if log is None or not log.exists() or is_converted(doc):
            return None
        mark = f"commit at {log.stat().st_mtime}"
        if was != mark:
            if not now and doc.stat().st_mtime > log.stat().st_mtime:
                # changed after the commit, and its state at the commit was not seen
                out.unlink(missing_ok=True)
                return None
            shutil.copyfile(doc, out)
            note.write_text(mark)
        return out
    except (OSError, RuntimeError, UnicodeDecodeError):
        return None


def export_path(doc):
    """Return the path of the exported PDF that carries the comments."""
    return doc.with_suffix(".commented.pdf")


def export(doc):
    """Write a copy of ``doc`` with the comments as standard PDF highlights.

    The original PDF is not changed. Returns the output path and the number
    of annotations written.
    """
    try:
        from pypdf import PdfReader, PdfWriter
        from pypdf.annotations import Highlight, Rectangle, Text
        from pypdf.generic import ArrayObject, FloatObject, NameObject, TextStringObject
    except ImportError as exc:
        raise RuntimeError("export needs the pypdf package (it comes with 'uv tool install')") from exc

    writer = PdfWriter(clone_from=PdfReader(str(shown_pdf(doc))))
    author = TextStringObject(getpass.getuser())
    count = 0
    for a in load_comments(doc)["annots"]:
        by_page = {}
        for r in a["rects"]:
            by_page.setdefault(r["p"], []).append(r)
        for k, (number, rects) in enumerate(sorted(by_page.items())):
            # stored positions are measured from the top-left corner; PDF counts from the bottom-left
            box = writer.pages[number - 1].cropbox
            left, top = float(box.left), float(box.top)
            quads, xs, ys = [], [], []
            for r in rects:
                x1, x2 = left + r["x"], left + r["x"] + r["w"]
                y1, y2 = top - r["y"], top - r["y"] - r["h"]
                quads += [x1, y1, x2, y1, x1, y2, x2, y2]
                xs += [x1, x2]
                ys += [y1, y2]
            bounds = (min(xs), min(ys), max(xs), max(ys))
            if a.get("kind") == "pin":
                # a point: a sticky note whose icon stands just above and right of it
                x, y = bounds[0], bounds[1]
                annot = Text(rect=(x, y, x + 18, y + 18), text="")
                annot[NameObject("/C")] = ArrayObject(FloatObject(v) for v in (0.94, 0.5, 0.0))
            elif a.get("kind") == "box":
                annot = Rectangle(rect=bounds)
                annot[NameObject("/C")] = ArrayObject(FloatObject(v) for v in (0.94, 0.5, 0.0))
            else:
                annot = Highlight(rect=bounds, quad_points=ArrayObject(FloatObject(round(v, 2)) for v in quads),
                                  highlight_color="ffb347" if a["comment"] else "ffe45c")
                if a.get("kind") == "strike":
                    annot[NameObject("/Subtype")] = NameObject("/StrikeOut")
                    annot[NameObject("/C")] = ArrayObject(FloatObject(v) for v in (0.82, 0.0, 0.0))
            annot[NameObject("/T")] = author
            said = [a["comment"]] + [f"{r.get('from') or author}: {r['text']}" for r in a.get("replies", [])]
            if any(said) and k == 0:
                annot[NameObject("/Contents")] = TextStringObject("\n\n".join(t for t in said if t))
            writer.add_annotation(page_number=number - 1, annotation=annot)
            count += 1
    out = export_path(doc)
    writer.write(str(out))
    return out, count


class Tabs:
    """The documents that are open in the window, one per tab."""

    def __init__(self):
        self.docs = {}       # id -> path, in the order of the tabs
        self.focus = None    # id of the document that was opened last
        self.opened = 0      # counts the open requests, so the window shows each one once
        self.version = 0     # counts every change of the list
        self.windows = 0     # windows that are listening for changes
        self.rev = {}        # id -> counts the changes of the comments that did not come from the window
        self.handed = {}     # id -> how often Ctrl+Enter was pressed in the document
        self.taken = {}      # id -> how many of those a --wait has seen
        self.waiting = {}    # id -> the --wait commands that are waiting now
        self.left = {}       # id -> when the last --wait stopped waiting (time.monotonic)
        self.stamp = {}      # id -> the time of the last change of the file that the window knows of
        self.logs = {}       # id -> the file of its repository that changes with every commit, and its time
        self.quit = False    # set by the q key: the windows close and just-doc stops
        self.changed = threading.Condition()

    def open(self, doc):
        key = hashlib.sha1(str(doc).encode()).hexdigest()[:10]
        with self.changed:
            self.docs[key] = doc
            self.focus = key
            self.opened += 1
            self.version += 1
            self.changed.notify_all()

    def close(self, key):
        with self.changed:
            if self.docs.pop(key, None) is not None:
                if self.focus == key:
                    self.focus = next(reversed(self.docs), None)
                self.version += 1
                self.changed.notify_all()

    def touch(self, key):
        """Tell the window that the comments of a document were changed from outside."""
        with self.changed:
            self.rev[key] = self.rev.get(key, 0) + 1
            self.version += 1
            self.changed.notify_all()

    def hand(self, key):
        """Note a Ctrl+Enter; return whether a --wait is there to get it."""
        with self.changed:
            self.handed[key] = self.handed.get(key, 0) + 1
            self.changed.notify_all()
            return self.waiting.get(key, 0) > 0

    def wait(self, key, seconds):
        """Wait for a Ctrl+Enter that no --wait has seen yet; False when none came in time."""
        end = time.monotonic() + seconds
        with self.changed:
            if not self.listens(key):
                # the window shows that the assistant waits
                self.version += 1
                self.changed.notify_all()
            self.waiting[key] = self.waiting.get(key, 0) + 1
            try:
                while self.handed.get(key, 0) <= self.taken.get(key, 0):
                    left = end - time.monotonic()
                    if left <= 0 or key not in self.docs:
                        return False
                    self.changed.wait(left)
                self.taken[key] = self.handed[key]
                return True
            finally:
                self.waiting[key] -= 1
                self.left[key] = time.monotonic()

    def listens(self, key):
        """Whether a --wait waits for the document; it asks again every 25 s, so a short gap counts too."""
        return self.waiting.get(key, 0) > 0 or time.monotonic() - self.left.get(key, -10) < 3

    def listing(self):
        tabs = []
        for key, doc in self.docs.items():
            try:
                changed = doc.stat().st_mtime
            except OSError:
                changed = 0
            # a file that is being written is left alone until it is a second old
            if key not in self.stamp or time.time() - changed > 1:
                self.stamp[key] = changed
            self.committed(key, doc)
            tabs.append({"id": key, "name": doc.name, "path": str(doc), "rev": self.rev.get(key, 0),
                         "file": self.stamp[key], "waiting": self.listens(key),
                         # a Ctrl+Enter that no --wait has taken yet
                         "pending": self.handed.get(key, 0) > self.taken.get(key, 0)})
        return {"tabs": tabs, "focus": self.focus, "opened": self.opened, "quit": self.quit}

    def committed(self, key, doc):
        """Keep the PDF of a document as it is when a commit is made in its repository."""
        if key not in self.logs:
            self.logs[key] = [head_log(doc), None]
        log, seen = self.logs[key]
        try:
            at = log.stat().st_mtime if log else None
        except OSError:
            at = None
        if at != seen:
            self.logs[key][1] = at
            commit_pdf(doc, log, now=seen is not None)


def make_handler(tabs):
    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript"}

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB), **kwargs)

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _route(self):
            """Return the route and the document that the request is about.

            The document is named by ``?d=<id>``; without it the first one is taken.
            """
            url = urllib.parse.urlsplit(self.path)
            key = urllib.parse.parse_qs(url.query).get("d", [None])[0]
            docs = dict(tabs.docs)
            return url.path, key, docs.get(key) if key else next(iter(docs.values()), None)

        def _events(self):
            """Send the list of tabs to a window, now and after every change.

            The list is looked at every two seconds too, to see a file that was changed.
            """
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            with tabs.changed:
                tabs.windows += 1
            sent = seen = None
            try:
                while True:
                    with tabs.changed:
                        if seen == tabs.version:
                            tabs.changed.wait(2)
                        seen, listing = tabs.version, tabs.listing()
                    if listing != sent:
                        self.wfile.write(f"data: {json.dumps(listing, ensure_ascii=False)}\n\n".encode("utf-8"))
                        sent = listing
                    else:
                        # a line that the window ignores; writing it fails once the window is closed
                        self.wfile.write(b": still here\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with tabs.changed:
                    tabs.windows -= 1

        def do_GET(self):
            route, key, doc = self._route()
            if route == "/api/events":
                self._events()
            elif route == "/api/tabs":
                self._json(200, {"app": "just-doc", "version": VERSION, "windows": tabs.windows, **tabs.listing()})
            elif route in ("/", "/view"):
                self.path = "/tabs.html" if route == "/" else "/index.html"
                super().do_GET()
            elif route in ("/doc", "/api/info", "/api/annotations", "/api/wait", "/api/before", "/api/rounds") and doc is None:
                self._json(404, {"error": "this document is not open"})
            elif route == "/doc":
                try:
                    body = shown_pdf(doc).read_bytes()
                except RuntimeError as exc:
                    self._json(500, {"error": str(exc)})
                    return
                self._send(200, body, "application/pdf")
            elif route == "/api/before":
                # the document as it was at the last Ctrl+Enter or at the last commit
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                commit = query.get("k") == ["commit"]
                old = (commit_pdf(doc, tabs.logs.get(key, [None])[0]) if commit
                       else kept(doc, f"round{int(query['n'][0])}") if query.get("k") == ["round"] else kept(doc, "handed"))
                if old is None or not old.exists():
                    self._json(404, {"error": "the version of the last commit is not known" if commit
                                     else "nothing was handed over yet (Ctrl+Enter)"})
                else:
                    self._send(200, old.read_bytes(), "application/pdf")
            elif route == "/api/rounds":
                self._json(200, {"rounds": rounds(doc)})
            elif route == "/api/info":
                self._json(200, {"name": doc.name, "path": str(doc), "file": doc.stat().st_mtime})
            elif route == "/api/annotations":
                self._json(200, load_comments(doc))
            elif route == "/api/wait":
                # answers within half a minute, so the command notices when just-doc is gone
                seconds = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("s", ["25"])[0]
                done = tabs.wait(key, min(25.0, float(seconds)))
                if done:
                    # the comments that the --wait prints now: the window shows them as seen
                    mark_seen(doc)
                    tabs.touch(key)
                self._json(200, {"done": done})
            else:
                super().do_GET()

        def _body(self):
            size = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(size).decode("utf-8"))

        def do_POST(self):
            route, key, doc = self._route()
            if route == "/api/open":
                # a web page cannot send JSON to another address, so this comes from the just-doc command
                if self.headers.get("Content-Type") != "application/json":
                    self._json(400, {"error": "JSON expected"})
                    return
                try:
                    new = Path(self._body()["path"])
                    if not new.is_file():
                        raise ValueError(f"not found: {new}")
                    shown_pdf(new)
                except Exception as exc:  # noqa: BLE001
                    self._json(400, {"error": str(exc)})
                    return
                windows = tabs.windows
                tabs.open(new)
                self._json(200, {"ok": True, "windows": windows})
                return
            if route == "/api/quit":
                # as for /api/open: JSON only, so that another web page cannot stop just-doc
                if self.headers.get("Content-Type") != "application/json":
                    self._json(400, {"error": "JSON expected"})
                    return
                with tabs.changed:
                    tabs.quit = True
                    tabs.version += 1
                    tabs.changed.notify_all()
                self._json(200, {"ok": True})
                # a moment later, so that every window still hears of it and closes
                threading.Timer(0.7, self.server.shutdown).start()
                return
            if route == "/api/close":
                tabs.close(key)
                self._json(200, {"ok": True})
                return
            if route not in ("/api/export", "/api/pdf", "/api/annotations", "/api/reply", "/api/done") or doc is None:
                self._json(404, {"error": "not found"})
                return
            if route == "/api/done":
                try:
                    new_round(doc)
                except (OSError, RuntimeError):
                    pass
                self._json(200, {"ok": True, "listening": tabs.hand(key)})
                return
            if route == "/api/reply":
                try:
                    if self.headers.get("Content-Type") != "application/json":
                        raise ValueError("JSON expected")
                    obj = self._body()
                    text = obj.get("text")
                    answer(doc, str(obj["ref"]), None if text is None else str(text), str(obj.get("from", "")))
                except Exception as exc:  # noqa: BLE001
                    self._json(400, {"error": str(exc)})
                    return
                tabs.touch(key)
                self._json(200, {"ok": True})
                return
            if route == "/api/pdf":
                # the PDF made from a markdown or an HTML file, saved next to it without comments
                if not is_converted(doc):
                    self._json(400, {"error": "this document is a PDF already"})
                    return
                try:
                    out = doc.with_suffix(".pdf")
                    shutil.copyfile(shown_pdf(doc), out)
                except (OSError, RuntimeError) as exc:
                    self._json(500, {"error": str(exc)})
                    return
                self._json(200, {"ok": True, "file": out.name})
                return
            if route == "/api/export":
                try:
                    out, count = export(doc)
                except Exception as exc:  # noqa: BLE001
                    self._json(500, {"error": str(exc)})
                    return
                self._json(200, {"ok": True, "file": out.name, "n": count})
                return
            try:
                obj = self._body()
                if not isinstance(obj.get("annots"), list):
                    raise ValueError("annots must be a list")
            except Exception as exc:  # noqa: BLE001
                self._json(400, {"error": str(exc)})
                return
            with WRITING:
                keep_replies(doc, obj["annots"])
                save_comments(doc, obj["annots"])
            self._json(200, {"ok": True, "n": len(obj["annots"])})

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, *args):
            pass

    return Handler


def open_window(url):
    """Open ``url`` in a chromeless app window, or in the default browser."""
    for name in BROWSERS:
        exe = shutil.which(name)
        if exe:
            subprocess.Popen([exe, f"--app={url}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return
    webbrowser.open(url)


def hand_over(url, doc):
    """Open ``doc`` as a tab of the just-doc that runs at ``url``.

    Returns the number of windows it has, or None when no just-doc answers there.
    """
    try:
        with urllib.request.urlopen(url + "api/tabs", timeout=1) as resp:
            if json.loads(resp.read()).get("app") != "just-doc":
                return None
    except Exception:  # noqa: BLE001
        return None
    req = urllib.request.Request(url + "api/open", data=json.dumps({"path": str(doc)}).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())["windows"]
    except urllib.error.HTTPError as exc:
        raise RuntimeError(json.loads(exc.read()).get("error", str(exc))) from exc


def ask(url, body=None, timeout=5):
    """Send a request to a running just-doc and return its JSON answer."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(json.loads(exc.read()).get("error", str(exc))) from exc


def running(doc, port):
    """Find the just-doc that has ``doc`` open.

    Returns its address, the id of the tab and the number of its windows, or None.
    Says so when that just-doc runs another version of the code than this command.
    """
    first = port or PORT
    for candidate in range(first, first + 20):
        url = f"http://127.0.0.1:{candidate}/"
        try:
            state = ask(url + "api/tabs", timeout=1)
        except Exception:  # noqa: BLE001
            continue
        for tab in state.get("tabs", []) if state.get("app") == "just-doc" else []:
            if tab["path"] == str(doc):
                if state.get("version") != VERSION:
                    print(f"note: the just-doc at {url} runs another version than this command and may behave "
                          "differently; stop it (Ctrl+C in its terminal, or kill it) and run this command again")
                return url, tab["id"], state["windows"]
    return None


def reply(doc, replies, done, name, port):
    """Add replies to comments and mark comments as done.

    This goes through the running just-doc, so that its window shows them.
    """
    found = running(doc, port)
    annots = load_comments(doc)["annots"]
    # numbers are taken as they are now, also when a new comment comes in between
    changes = [(find_comment(doc, annots, ref).get("id", ref), text) for ref, text in replies]
    changes += [(find_comment(doc, annots, ref).get("id", ref), None) for ref in done]
    for ref, text in changes:
        if found:
            ask(f"{found[0]}api/reply?d={found[1]}", {"ref": ref, "text": text, "from": name})
        else:
            answer(doc, ref, text, name)
    print(f"{len(replies)} reply(ies), {len(done)} done -> {comments_path(doc).name}"
          + ("" if found else " (not open in a window)"))


def wait(doc, port, window, as_json, limit):
    """Open ``doc`` if it is not open, wait for Ctrl+Enter in its window, then print the comments."""
    found = running(doc, port)
    if found and window and not found[2]:
        open_window(found[0])
    if not found:
        # a just-doc of its own, which stays when this command ends
        shown_pdf(doc)
        cmd = [sys.executable, "-c", "import just_doc; just_doc.main()", str(doc)]
        cmd += (["--port", str(port)] if port else []) + ([] if window else ["--no-window"])
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            time.sleep(0.1)
            found = running(doc, port)
            if found:
                break
        else:
            raise RuntimeError("could not open the document")
    url, key, _ = found
    print(f"{doc.name}: waiting for Ctrl+Enter in the window, {url}", flush=True)
    end = time.monotonic() + limit if limit else None
    while True:
        left = min(25, end - time.monotonic()) if end else 25
        if left <= 0:
            print("no Ctrl+Enter yet; run the same command again to keep waiting")
            sys.exit(2)
        try:
            if ask(f"{url}api/wait?d={key}&s={left:.0f}", timeout=60)["done"]:
                break
        except RuntimeError as exc:
            raise RuntimeError("the tab was closed") from exc
        except OSError as exc:
            raise RuntimeError("just-doc was stopped") from exc
    read(doc, as_json, only_open=True)


def serve(doc, port, window):
    # One just-doc serves all open documents: the first command starts it, and every later
    # command hands its document over to it as a new tab and returns.
    first = port or PORT
    for candidate in range(first, first + 20):
        url = f"http://127.0.0.1:{candidate}/"
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), make_handler(tabs := Tabs()))
        except OSError:
            windows = hand_over(url, doc)
            if windows is None:
                continue
            print(f"{doc.name}: new tab in the running just-doc, {url}")
            if window and not windows:
                open_window(url)
            return
        tabs.open(doc)
        print(f"{doc.name}: {url}  (comments -> {comments_path(doc).name}, Ctrl+C to stop)")
        if window:
            open_window(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return
    sys.exit("no free port found")


def show(port, window):
    """Print the documents of every running just-doc; open a window for one that has none."""
    first, found = port or PORT, False
    for candidate in range(first, first + 20):
        url = f"http://127.0.0.1:{candidate}/"
        try:
            state = ask(url + "api/tabs", timeout=1)
        except Exception:  # noqa: BLE001
            continue
        if state.get("app") != "just-doc":
            continue
        found = True
        opens = window and not state["windows"]
        print(f"{url}  ({'no window, opening one' if opens else 'its window is open' if state['windows'] else 'no window'})")
        for tab in state["tabs"]:
            print(f"  {tab['path']}")
        if opens:
            open_window(url)
    if not found:
        sys.exit("no just-doc is running; start one with: just-doc FILE")


def source_line(doc, rect, centre=False):
    """Map a highlight to ``file:line`` in the TeX source via SyncTeX, if available.

    A text highlight is looked up at its start, a rectangle at its centre.
    """
    if not shutil.which("synctex"):
        return None
    if not any(doc.with_suffix(ext).exists() for ext in (".synctex.gz", ".synctex")):
        return None
    x = rect["x"] + (rect["w"] / 2 if centre else 2)
    spot = f"{rect['p']}:{x:.2f}:{rect['y'] + rect['h'] / 2:.2f}:{doc.name}"
    res = subprocess.run(["synctex", "edit", "-o", spot], cwd=doc.parent, capture_output=True, text=True)
    name = line = None
    for row in res.stdout.splitlines():
        if row.startswith("Input:") and name is None:
            name = os.path.normpath(row[6:])
        elif row.startswith("Line:") and line is None:
            line = row[5:]
    return f"{name}:{line}" if name and line else None


class PageText(HTMLParser):
    """Collect the letters and digits of the text of an HTML page, each with its line.

    The tags, their attributes, scripts, styles and the title are left out.
    """

    def __init__(self):
        super().__init__()
        self.chars, self.lines, self.skip = [], [], 0

    def handle_starttag(self, tag, attrs):
        self.skip += tag in ("script", "style", "title")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "title") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if self.skip:
            return
        line = self.getpos()[0]
        for ch in data:
            if ch == "\n":
                line += 1
            elif ch.isalnum():
                self.chars.append(ch.lower())
                self.lines.append(line)


def source_lines(doc, annots):
    """Find the line of each comment's text in the markdown or HTML file ``doc``.

    Only letters and digits are compared, so the markup, the line breaks and
    the hyphenation of the PDF do not matter. A text that occurs more than
    once gets the line of its first occurrence and a note.
    """
    text = doc.read_text(encoding="utf-8")
    if doc.suffix.lower() in HTML:
        page = PageText()
        page.feed(text)
        page.close()
        chars, lines = page.chars, page.lines
    else:
        chars, lines = [], []
        for number, row in enumerate(text.splitlines(), 1):
            for ch in row:
                if ch.isalnum():
                    chars.append(ch.lower())
                    lines.append(number)
    body = "".join(chars)
    for a in annots:
        # a point has no text of its own: the line above it stands in
        key = "".join(ch.lower() for ch in a["text"] or a.get("near", "") if ch.isalnum())[:80]
        at = body.find(key) if len(key) > 2 else -1
        if at < 0:
            a["source"] = None
            continue
        count = body.count(key)
        a["source"] = f"{doc.name}:{lines[at]}" + (f" (first of {count} places)" if count > 1 else "")


def is_open(a):
    """Whether the comment waits for a reply: not done, and the author spoke last."""
    replies = a.get("replies", [])
    return not a.get("done") and (not replies or not replies[-1].get("from"))


def read(doc, as_json, only_open=False):
    annots = load_comments(doc)["annots"]
    if is_converted(doc):
        source_lines(doc, annots)
    else:
        for a in annots:
            a["source"] = source_line(doc, a["rects"][0], centre=a.get("kind") in ("box", "pin"))
    for i, a in enumerate(annots, 1):
        a["number"], a["open"] = i, is_open(a)
    shown = [a for a in annots if a["open"] or not only_open]
    if as_json:
        print(json.dumps(shown, ensure_ascii=False, indent=1))
        return
    for a in shown:
        i = a["number"]
        where = f"p. {a['rects'][0]['p']}" + (f"  {a['source']}" if a["source"] else "")
        kind = {"box": "area", "strike": "delete", "pin": "point"}.get(a.get("kind"), "text")
        text = a["text"] or "(no text inside)"
        if a.get("kind") == "pin":
            r = a["rects"][0]
            text = f"at x {r['x']:.0f}, y {r['y']:.0f} pt, under the line «{a.get('near') or '?'}»"
        if a.get("change") is not None and not a["text"]:
            kind, text = "removed", a["change"]
        where += "  (done)" if a.get("done") else "" if a["open"] or only_open else "  (answered)"
        print(f"[{i}] {where}\n    {kind + ':':<8} {text}\n    comment: {a['comment'] or '(none)'}")
        if a.get("change") is not None and a["text"]:
            print(f"    (a comment on a change: before it, the text was: {a['change'] or '(nothing, it is new)'})")
        if a.get("was") is not None:
            print(f"    (the text was changed after the comment; it was: {a['was']})")
        if a.get("lost"):
            print("    (the text is no longer found in the document; the page is the old one)")
        for r in a.get("replies", []):
            print(f"    reply ({r.get('from') or 'author'}): {r['text']}")
        seen = a.get("seen", [])
        if a["open"] and len(seen) > 1 and stamp_key(spoke_at(a)) <= stamp_key(seen[-2]):
            print("    (shown to you before and not answered)")
        print()
    if only_open:
        print(f"{len(shown)} open comment(s), {len(annots) - len(shown)} done or answered ({doc.name} --read shows all)")
        print(f'Answer:  just-doc {doc.name} --reply N "text" [--done N] --from NAME   then  just-doc {doc.name} --wait')
        print("How this works:  just-doc --guide")
    else:
        print(f"{len(annots)} comment(s) in {comments_path(doc).name}")


def main():
    ap = argparse.ArgumentParser(prog="just-doc", description="Highlight and comment a PDF, a markdown or an HTML file; comments are saved as JSON.")
    ap.add_argument("pdf", type=Path, metavar="file", nargs="?", help="a PDF, a markdown or an HTML file; without it, the documents that are open are listed")
    ap.add_argument("--read", action="store_true", help="print the comments instead of opening the PDF")
    ap.add_argument("--json", action="store_true", help="with --read or --wait: print JSON")
    ap.add_argument("--wait", action="store_true",
                    help="open the file, wait for Ctrl+Enter in the window, then print the comments")
    ap.add_argument("--timeout", type=float, default=0, metavar="SECONDS",
                    help="with --wait: give up after this time (exit status 2); the default is to wait without end")
    ap.add_argument("--guide", action="store_true",
                    help="print how a coding assistant reviews a document with you through just-doc")
    ap.add_argument("--reply", nargs=2, action="append", metavar=("N", "TEXT"),
                    help="add a reply to comment N (its number in --read, or its id); can be given several times")
    ap.add_argument("--done", action="append", metavar="N", default=[],
                    help="mark comment N as done: its highlight fades and leaves at the next Ctrl+Enter; can be given several times")
    ap.add_argument("--from", dest="name", default="reply", metavar="NAME", help="with --reply: the name on the reply")
    ap.add_argument("--export", action="store_true", help="write <name>.commented.pdf with the comments inside")
    ap.add_argument("--port", type=int, default=0, help=f"port (default: {PORT})")
    ap.add_argument("--no-window", action="store_true", help="start the server only")
    args = ap.parse_args()
    if args.guide:
        print(GUIDE, end="")
        return
    if args.pdf is None:
        if args.reply or args.done or args.wait or args.read or args.export:
            ap.error("the file is missing")
        show(args.port, not args.no_window)
        return
    doc = args.pdf.resolve()
    if not doc.is_file():
        sys.exit(f"not found: {doc}")
    try:
        if args.export:
            out, count = export(doc)
            print(f"{count} annotation(s) -> {out}")
        elif args.reply or args.done:
            reply(doc, args.reply or [], args.done, args.name, args.port)
        elif args.wait:
            wait(doc, args.port, not args.no_window, args.json, args.timeout)
        elif args.read:
            read(doc, args.json)
        else:
            shown_pdf(doc)
            serve(doc, args.port, not args.no_window)
    except RuntimeError as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    main()
