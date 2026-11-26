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
    just-doc page.html --live    show an HTML page as it is, with its scripts
                                 running, and load it again when it changes;
                                 --live with --wait, --read, --reply, --done:
                                 the comments and answers of that page
    just-doc page.html --shot p.png
                                 save a picture of the page as it looks live
                                 (--size 1500x900), to check it; opens nothing
    just-doc book.pdf --read     print the comments (with source lines if
                                 book.synctex.gz is next to the PDF)
    just-doc book.pdf --export   write book.commented.pdf with the comments
                                 as ordinary PDF annotations
    just-doc book.pdf --wait     open it, wait for Ctrl+Enter in the window,
                                 then print the comments
    just-doc book.pdf --reply 2 "text"
                                 add a reply to comment 2
    just-doc book.pdf --done 2   mark comment 2 as done
    just-doc --hc-terminal t12   bring the window to the front with the document
                                 that was opened or changed last from the hc
                                 terminal t12 (HC_TERMINAL_ID of the opening shell)
    just-doc --hc-terminal t12 --hc-machine work2
                                 the same for a document (PDF or live page) that
                                 a command on the machine work2 opened there,
                                 shown through ssh
    just-doc --hc-terminal t12 --list
                                 print every document of the terminal, newest
                                 first, one JSON object per line
    just-doc --hc-terminal t12 --doc ID
                                 show that document (an id from --list) instead
                                 of the latest one; also with --hc-machine
    just-doc --guide             print how a coding assistant uses the three
                                 commands above to review a document with you
"""
import argparse
import calendar
import contextlib
import fcntl
import functools
import getpass
import hashlib
import json
import mimetypes
import queue
import os
import posixpath
import re
import shlex
import shutil
import signal
import socket
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
from pathlib import Path, PurePosixPath

WEB = Path(__file__).resolve().parent / "web"
PORT = 8700


def build_id():
    """Return the version of the package and a hash of its code and of the window's files.

    An editable install with new commits gives another id, so a command can tell
    that the running just-doc is another version than itself. JUST_DOC_BUILD
    overrides it (for the tests).
    """
    if os.environ.get("JUST_DOC_BUILD"):
        return os.environ["JUST_DOC_BUILD"]
    try:
        from importlib.metadata import version
        package = version("just-doc")
    except Exception:  # noqa: BLE001
        package = "0"
    h = hashlib.sha1()
    for f in [Path(__file__), *sorted(WEB.glob("*.html")), *sorted(WEB.glob("*.js")),
              WEB / "_lib" / "page.css", WEB / "_lib" / "plotly-theme.js"]:
        try:
            h.update(f.read_bytes())
        except OSError:
            pass
    return f"{package}+{h.hexdigest()[:10]}"


VERSION = build_id()
# what this just-doc can do, for a command that finds an older one it cannot update now (see current)
FEATURES = ["live", "remote", "live-comments", "session"]
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

Which command the author's words ask for:

    "open it as PDF", or no way named    just-doc FILE --wait
        FILE is a .pdf, .md or .html; just-doc makes the PDF of a markdown or
        HTML file itself and shows it again when the source changes. Do not
        make a PDF yourself.
    "open the HTML", "show it live"      just-doc FILE.html --live --wait
        the page as it is, scripts running (see "Showing a page live").

Both are commented, answered and closed the same way, with the same keys in
the window. On a machine without a display (over ssh) no window opens there:
the author brings the document to their own machine with their key for it
(in hc: Ctrl+Space f), a PDF as well as a live page. Never serve the files
yourself (no http server, no port) and never send the author a URL instead.

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

   3 is the number of the comment: it never changes, also when the comments
   move in the document, and the author sees it in the window as #3. p. 12
   is the page, and chapter.tex:140 is the place in the source when it is
   known (for markdown and HTML, and for LaTeX with SyncTeX). "delete:" instead of "text:" means that the author wants this
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
Showing a page live
-------------------

To show the author a plot to zoom or a model to turn, write an HTML file and
run

       just-doc PAGE.html --live

It opens as a tab of the just-doc window with its scripts running, and loads
again by itself whenever you save the file; run the command once. On a
machine without a display (over ssh) no window opens: the author sees the
page from their own machine through ssh. Files next to the page can be linked by relative paths.
These are served by just-doc; use them instead of the internet:

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
                                           zooms, shift + scroll turns; a mouse wheel zooms;
                                           use it with every OrbitControls
    /_lib/three/fast.js                    mergeByMaterial(root, {keep}): a model of thousands of
                                           meshes in a few draw calls; sharpWhenStill(renderer,
                                           render): coarse pixels while the view moves
    /_lib/three/scene.js                   <jd-scene>: a viewer of one or more parts (STL, STEP,
                                           GLB) with part list, views and section plane, in
                                           which the author can comment on a point of the
                                           surface; see "A model" below
    /_lib/occt/                            the STEP reader (occt-import-js) that scene.js loads
                                           by itself; a page does not use it

A plot:

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

A model (STL, STEP or GLB files, one or several parts): use <jd-scene>. It
has the part list (checkbox, colour, opacity), the views (iso, top, front,
side), a section plane, touchpad navigation, the full width, light and dark,
and the author can comment on a point of the surface (see below). Parts load
in parallel and show as they arrive. The files are next to the page:

    <!doctype html>
    <meta charset="utf-8">
    <title>Bracket</title>
    <link rel="stylesheet" href="/_lib/page.css">
    <script type="module" src="/_lib/three/scene.js"></script>
    <h1>Bracket</h1>
    <jd-scene id="bracket">
      <script type="application/json">
      {"parts": [{"src": "housing.stl"},
                 {"src": "cover.step", "colour": "#e15759", "opacity": 0.7}],
       "units": "mm"}
      </script>
    </jd-scene>
    <p>What the view shows and what to look at.</p>

Give it an id. Config: parts (at least one) with, for each, src (.stl, .step,
.stp or .glb), name (default: the file name), group (a folder in the list),
colour (hex; STEP and GLB colours are used without it), opacity (0 to 1),
visible (false: not loaded until the author shows it), split (STEP only: one
part per solid); units ("mm", shown with the size and the section); height
(pixels; default: the class view of page.css); up ("z" default, or "y"; GLB
files are Y-up); src (a .json file with these keys instead of the script).
The config is read once: save the page to change it. The comments need the
element only; nothing else to do. Write three.js yourself only for what it
cannot do: a scene you build in code (a mesh, a field, a plot in 3D) or an
own animation:

    <!doctype html>
    <meta charset="utf-8">
    <title>Part</title>
    <link rel="stylesheet" href="/_lib/page.css">
    <h1>Torus knot</h1>
    <div class="controls">
      <label><input id="wire" type="checkbox" class="toggle"> wireframe</label>
    </div>
    <div id="view" class="view"></div>
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
      // draw only when something changed: a view that stands still costs nothing
      let queued = false;
      const draw = () => { if (queued) return; queued = true;
        requestAnimationFrame(() => { queued = false; renderer.render(scene, camera); }); };
      controls.addEventListener('change', draw);
      // the view follows the width of the page, which narrows while the comment panel is open
      new ResizeObserver(() => {
        renderer.setSize(box.clientWidth, box.clientHeight);
        camera.aspect = box.clientWidth / box.clientHeight;
        camera.updateProjectionMatrix();
        draw();
      }).observe(box);
      document.getElementById('wire').onchange = e => { mesh.material.wireframe = e.target.checked; draw(); };
    </script>

Layout: decide it for each page. What matters most (a 3D model, a plot)
gets the full width: page.css gives class "plot" and class "view" the full
width of the page and keeps text in a readable column. The page narrows while
the comment panel is open; Plotly follows it by itself, a three.js view with
a ResizeObserver as in the example. Put the sliders, choices and switches of
a plot or a view in a bar above it, <div class="controls">, as a rule; parts
side by side only when each still has enough room: <div class="pair"> (or a
"grid") puts two side by side while each gets 560 px, otherwise one above
the other. A control needs a name only when its value should be handed over
with Ctrl+Enter. Do not enable damping in OrbitControls: the model must stop
when the user lets go. Draw only when something changed, as in the example:
call draw() after each change to the scene. Do not use setAnimationLoop for a
view that stands still: it draws 60 times a second, and a large model (a
PCB, an assembly) keeps the author's machine busy and hot. Use it only while
something moves by itself, and stop it after.

Every 3D view of a part or an assembly has a section: the author must be
able to cut it open. <jd-scene> has one. In your own three.js, add the
same: buttons off, X, Y, Z and a slider for the position, in the controls
bar above the view, with a clipping plane on the renderer:

    // Section: off / X / Y / Z buttons and a position slider in the controls bar
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    function section(axis, at) {  // axis: null (off), 'x', 'y' or 'z'; at: position in model units
      renderer.clippingPlanes = axis ? [plane] : [];
      if (axis) plane.set(new THREE.Vector3(...['x', 'y', 'z'].map(a => a === axis ? -1 : 0)), at);
      draw();
    }

Your own three.js with hundreds of parts or more (CAD, KiCad) is slow, one
draw call per part (<jd-scene> merges the meshes of a part by itself). After
loading, and after measuring and finding parts by name, merge it with
mergeByMaterial, and draw with sharpWhenStill (coarse pixels while the view
moves, sharp when it stops):

    import { mergeByMaterial, sharpWhenStill } from '/_lib/three/fast.js';
    mergeByMaterial(model, { keep: m => moved.has(m) });  // one mesh per material; keep: meshes you still move, pick or recolour
    const draw = sharpWhenStill(renderer, () => renderer.render(scene, camera));  // use draw() as in the example

Look at the page before you show it to the author:

       just-doc PAGE.html --shot /tmp/page.png [--size 900x900]

saves a picture of it as it looks live (opening nothing); read the picture
and fix what is squeezed, cut off or empty. Where no browser can start (a
container), it says so; then check the layout in the HTML.

To ask the author something on a page, use form fields with a name: radios in
<fieldset class="choice"> show as pills, a checkbox with class="toggle" as a
switch. The author chooses, can change the choice, and presses Ctrl+Enter:

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

Then

       just-doc PAGE.html --live --wait

waits for that Ctrl+Enter (opening the page if needed) and prints the answers
(see below); just-doc PAGE.html --live --read prints the last ones again.

A single checkbox gives true or false, checkboxes with the same name a list of
the checked values, radios the chosen value or null, a select with multiple a
list. Buttons count for nothing.

The author can also comment on a live page, as on a PDF: on selected text, or
on the element under the mouse. On a <jd-scene> the author points at the model
and a comment is pinned to that point of its surface: the numbered marker
stays on the model while it turns, and selecting the comment turns the view
to it only when the point is out of sight. Give sections, figures, plots and
models an id, and where it helps data-src="FILE:LINE" for the code that makes
them; a comment is anchored to the nearest element with an id (or data-src),
so it stays in place when you change the page. Without --json, --wait and --read print the
open comments, then the answers:

       [2] #fig-psd  plots.py:120
           element: <the text inside the element, if any>
           comment: what the author says about it

       [4] #bracket  part: housing  at (12.3, 4.5, 8) mm
           surface: a point on the surface of a 3D model, normal (0, 0, 1)
           comment: this edge is too sharp

       answers (round 1, 2026-11-25T10:31:07.512Z):
       {"variant": "B", "damping": true, "notes": "clamp must not scratch"}

"text:" instead of "element:" is a selected text. A line with "part: ... at (x, y, z)"
is a point on the surface of the model in the <jd-scene> with that id: the part
by its name in the list and the point in the units of the model files (the
unit is the one in the config); "normal" is the direction the surface faces.
With --json it is anchor.scene = {part, point, normal, units}. A comment marked
"(detached ...)" is on an element that is no longer in the page. A comment can
be about a change you made to the page: a line "(a comment on a change: before
it, the text was: ...)" gives the text as it was, and "removed:" stands for
text you deleted (it is the text as it was). With --json
the output is {"comments": [...], "answers": {"round", "at", "answers"} or
null}; each comment has its anchor: id, src (data-src), selector and quote.
Answer and close comments as in steps 3 and 4, with --live:

       just-doc PAGE.html --live --reply 2 "text" --done 2 --from NAME

The rules of --wait above hold here too: keep one running while the author
works on the page.
"""
BROWSERS = ("chromium", "brave", "google-chrome-stable", "google-chrome", "chromium-browser")


def comments_path(doc, live=False):
    """Return the path of the comments file that belongs to ``doc``; ``live``: to it as a live page.

    The comments of a live page are kept apart from those of its PDF, as they are anchored
    to elements of the page and not to places on PDF pages.
    """
    return doc.with_suffix(".live.comments.json" if live else ".comments.json")


def answers_path(doc):
    """Return the path of the file with the answers of the live page ``doc``."""
    return doc.with_suffix(".answers.json")


def load_answers(doc):
    try:
        return json.loads(answers_path(doc).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"source": doc.name, "rounds": []}


def live_rounds(doc):
    """Return the times of the Ctrl+Enter presses in the live page ``doc``, one per round, in seconds since 1970."""
    out = []
    for r in load_answers(doc)["rounds"]:
        try:
            out.append(calendar.timegm(time.strptime(r["at"][:19], "%Y-%m-%dT%H:%M:%S")) + int(r["at"][20:23]) / 1000)
        except (KeyError, ValueError):
            pass
    return out


def save_answers(doc, answers):
    """Add the fields of the live page ``doc`` at a Ctrl+Enter as a new round; return its number."""
    with WRITING:
        data = load_answers(doc)
        data["source"] = doc.name
        data["rounds"].append({"round": len(data["rounds"]) + 1, "at": now_stamp(), "answers": answers})
        tmp = answers_path(doc).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, answers_path(doc))
        return len(data["rounds"])


def load_comments(doc, live=False):
    path = comments_path(doc, live)
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        numbered(data.setdefault("annots", []))
        return data
    return {"annots": []}


def numbered(annots):
    """Give each comment without a number ``n`` the next free one, in the order they were written.

    The number stays with the comment: the window shows it, --wait prints it and
    --reply takes it, also after the comments have moved in the document.
    """
    top = max((a["n"] for a in annots if isinstance(a.get("n"), int)), default=0)
    for a in sorted((a for a in annots if not isinstance(a.get("n"), int)), key=lambda a: stamp_key(a.get("created"))):
        top += 1
        a["n"] = top


def save_comments(doc, annots, live=False):
    out = {"source": doc.name, "annots": annots}
    tmp = comments_path(doc, live).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, comments_path(doc, live))


def find_comment(doc, annots, ref, live=False):
    """Return the comment ``ref``: its number ``n`` or its id."""
    for a in annots:
        if a.get("id") == ref or (ref.isdigit() and a.get("n") == int(ref)):
            return a
    raise RuntimeError(f"no comment {ref} in {comments_path(doc, live).name}")


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


def answer(doc, ref, text, name, live=False):
    """Add a reply to the comment ``ref``; without a text mark the comment as done."""
    with WRITING:
        annots = load_comments(doc, live)["annots"]
        a = find_comment(doc, annots, ref, live)
        if text is None:
            a["done"] = True
            a["done_at"] = now_stamp()
        else:
            a.setdefault("replies", []).append(
                {"from": name, "text": text, "at": now_stamp()})
        save_comments(doc, annots, live)


def spoke_at(a):
    """Return when the author last said something on a comment: its creation or their last reply."""
    return max([a.get("created")] + [r.get("at") for r in a.get("replies", []) if not r.get("from")], key=stamp_key)


def mark_seen(doc, live=False):
    """Note on each open comment that a --wait shows it to the assistant now."""
    with WRITING:
        annots = load_comments(doc, live)["annots"]
        now = now_stamp()
        for a in annots:
            if is_open(a):
                a.setdefault("seen", []).append(now)
        save_comments(doc, annots, live)


def keep_replies(doc, annots, live=False):
    """Put the replies and done marks that are in the file but not in ``annots`` back in.

    The window sends the whole list after each change; a reply that was added
    from outside a moment before is not in it yet.
    """
    old = {a.get("id"): a for a in load_comments(doc, live)["annots"]}
    for a in annots:
        was = old.get(a.get("id"), {})
        # a window that was opened before the comments had numbers
        if "n" not in a and "n" in was:
            a["n"] = was["n"]
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


def shot(doc, out, size="1500x900"):
    """Save a picture of the HTML page ``doc`` as it looks live, ``size`` (WIDTHxHEIGHT) pixels, to ``out``.

    The page is served by a just-doc of its own, inside this command, so that
    /_lib/ works and nothing is opened in the window; a headless browser draws
    it, with its scripts, and waits until it is still (network idle and timers
    run, up to eight seconds of page time). WebGL runs in software.
    """
    m = re.fullmatch(r"(\d+)[x,](\d+)", size)
    if not m:
        raise RuntimeError(f"--size takes WIDTHxHEIGHT, such as 1500x900, not {size!r}")
    no_browser = "no browser to take a screenshot here; check the layout in the HTML"
    exe = next((shutil.which(name) for name in BROWSERS if shutil.which(name)), None)
    if exe is None:
        fail(no_browser)
    tabs = Tabs()
    tabs.open(doc, live=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(tabs))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/live/{tabs.focus}/{urllib.parse.quote(doc.name)}"
    out = Path(out).resolve()
    out.unlink(missing_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="just-doc-shot-") as tmp:
            # an own profile, so a browser window that is open does not take the job over
            cmd = [exe, "--headless", f"--user-data-dir={tmp}/profile", "--hide-scrollbars", "--use-angle=swiftshader",
                   "--enable-unsafe-swiftshader", f"--window-size={m[1]},{m[2]}", "--virtual-time-budget=8000",
                   f"--screenshot={out}", url]
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            except subprocess.TimeoutExpired:
                fail(no_browser)
    finally:
        server.shutdown()
        server.server_close()
    if res.returncode or not out.exists() or not out.stat().st_size:
        fail(no_browser)
    print(f"{doc.name}: {m[1]}x{m[2]} -> {out}")


def kept(doc, what):
    """Return the path in the cache folder of a PDF that is kept for ``doc``.

    ``what`` is "shown" (a markdown or an HTML file as a PDF), "handed" (the PDF at the
    last Ctrl+Enter), "commit" (the PDF at the last commit) or "round3" (the
    PDF at the third Ctrl+Enter).
    """
    name = hashlib.sha1(str(doc).encode()).hexdigest()[:16]
    return cache_dir() / (name + (".pdf" if what == "shown" else f".{what}.pdf"))


def kept_live(doc, what):
    """Return the path in the cache folder of what is kept for the live page ``doc``.

    ``what`` is "round3.html" (the page file at the third Ctrl+Enter) or "round3.txt"
    (the words of the page as the window showed them then, for "what changed").
    """
    name = hashlib.sha1((str(doc) + "\0live").encode()).hexdigest()[:16]
    return cache_dir() / f"{name}.{what}"


def keep_live_round(doc, number, text):
    """Keep the live page ``doc`` and its ``text`` as they are at the Ctrl+Enter that started round ``number``."""
    shutil.copyfile(doc, kept_live(doc, f"round{number}.html"))
    kept_live(doc, f"round{number}.txt").write_text(text or "", encoding="utf-8")


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
        self.live = set()    # ids of the HTML pages that are shown live, not as a PDF
        self.terms = {}      # id -> the hc terminal (HC_TERMINAL_ID) the document was opened from
        self.opened_at = {}  # id -> when the document was opened last (time.time)
        self.roots = {}      # id -> the project folder of a local document, see project_root
        self.remote = {}     # id -> a document (live page or PDF) of a just-doc on another machine, see open_remote
        self.forwards = Forwards()
        self.quit = False    # set by the q key: the windows close and just-doc stops
        self.opening = 0     # until when (time.monotonic) a window that this just-doc opened is still starting
        self.changed = threading.Condition()
        self.labels = {}     # hc terminal -> the just-doc label it was given last ("live", "waiting")
        self.hc = queue.Queue()  # hc label commands, run in order by one thread, so that opening never waits

    def relabel(self, clear=False):
        """Label the hc terminals of the open documents with their state, for the hc sidebar.

        ``just-doc=waiting`` while a --wait waits for a document of the terminal, ``just-doc=live``
        while one is open, and no label once none is (or with ``clear``, when just-doc stops).
        Call with ``self.changed`` held. Without hc nothing happens.
        """
        want = {}
        if not clear:
            for key in self.docs:
                t = self.terms.get(key)
                if t:
                    state = "waiting" if self.listens(key) else "live"
                    want[t] = "waiting" if want.get(t) == "waiting" else state
        for t in set(self.labels) | set(want):
            if self.labels.get(t) != want.get(t):
                self.hc.put((t, want.get(t, "")))
        self.labels = want
        if not hasattr(self, "_hc_thread"):
            self._hc_thread = threading.Thread(target=self._run_hc, daemon=True)
            self._hc_thread.start()

    def _run_hc(self):
        while True:
            t, state = self.hc.get()
            try:
                subprocess.run(["hc", "label", t, f"just-doc={state}"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            except (OSError, subprocess.SubprocessError):
                pass
            self.hc.task_done()

    def open(self, doc, live=False, terminal=None):
        # a page shown live is another tab than the same page as a PDF
        key = hashlib.sha1((str(doc) + ("\0live" if live else "")).encode()).hexdigest()[:10]
        with self.changed:
            self.docs[key] = doc
            if live:
                self.live.add(key)
            if terminal:
                self.terms[key] = terminal
            self.opened_at[key] = time.time()
            self.focus = key
            self.opened += 1
            self.version += 1
            self.relabel()
            self.changed.notify_all()

    def close(self, key):
        with self.changed:
            if self.docs.pop(key, None) is not None:
                self.live.discard(key)
                self.remote.pop(key, None)
                if self.focus == key:
                    self.focus = next(reversed(self.docs), None)
                self.version += 1
                self.relabel()
                self.changed.notify_all()

    def open_remote(self, info):
        """Open a document of another machine as a tab and show it; return its id.

        ``info`` has the machine, its ssh target, the port of the just-doc there,
        and the id, name, path and file time of the document in that just-doc, and
        ``live`` (a live page, or a PDF; missing: a live page, as older versions
        showed only those).
        """
        key = hashlib.sha1(f"{info['machine']}\0{info['id']}".encode()).hexdigest()[:10]
        with self.changed:
            self.docs[key] = Path(info["path"])
            self.remote[key] = info
            self.focus = key
            self.opened += 1
            self.version += 1
            self.changed.notify_all()
        return key

    def remote_file(self, key, stamp, rev, wait=None):
        """Note the file time of a remote document and the count of changes of its comments there.

        A new file time makes the window load the document again, a new count its comments.
        ``wait`` is the (waiting, waits, pending) of its tab there, shown on a PDF.
        """
        with self.changed:
            info = self.remote.get(key)
            if info is None:
                return
            if wait is not None and not info.get("live", True):
                old = (info.get("waiting"), info.get("waits"), info.get("pending"))
                if old != wait:
                    info["waiting"], info["waits"], info["pending"] = wait
                    self.version += 1
                    self.changed.notify_all()
            if (info.get("file"), info.get("rev", 0)) != (stamp, rev):
                info["file"], info["rev"] = stamp, rev
                self.version += 1
                self.changed.notify_all()

    def shown(self):
        """The number of windows, counting one that is still starting, so that no command opens a second one."""
        return self.windows or (1 if time.monotonic() < self.opening else 0)

    def session(self):
        """Return what a new just-doc needs to show the same tabs: see restore."""
        with self.changed:
            out = []
            for key, doc in self.docs.items():
                out.append({"path": str(doc), "live": key in self.live, "terminal": self.terms.get(key),
                            "opened_at": self.opened_at.get(key), "remote": self.remote.get(key),
                            "pending": self.handed.get(key, 0) > self.taken.get(key, 0), "focus": key == self.focus})
            return out

    def restore(self, session):
        """Open the tabs of ``session`` (from session(), or from the listing of an older just-doc)."""
        focus = None
        for e in session:
            if e.get("remote"):
                key = self.open_remote(e["remote"])
            else:
                self.open(Path(e["path"]), bool(e.get("live")), e.get("terminal"))
                key = self.focus
            with self.changed:
                if e.get("opened_at"):
                    self.opened_at[key] = e["opened_at"]
                # a Ctrl+Enter that no --wait has taken yet stays for the next --wait
                if e.get("pending"):
                    self.handed[key], self.taken[key] = 1, 0
            if e.get("focus"):
                focus = key
        with self.changed:
            if focus:
                self.focus = focus
            self.version += 1
            self.changed.notify_all()

    def of_terminal(self, terminal):
        """Return ``[(id, time)]`` of the documents from ``terminal``, newest first.

        The time is when the document was opened or changed last (epoch seconds).
        """
        def last(key):
            try:
                return max(self.opened_at.get(key, 0), self.docs[key].stat().st_mtime)
            except OSError:
                return self.opened_at.get(key, 0)
        with self.changed:
            found = [(key, last(key)) for key in self.docs if self.terms.get(key) == terminal]
        return sorted(found, key=lambda item: -item[1])

    def latest(self, terminal, key=None):
        """Return the id of the document from ``terminal`` that was opened or changed last, or None.

        With ``key``: that id, if the document is from ``terminal``, else None.
        """
        found = [k for k, _ in self.of_terminal(terminal)]
        if key is not None:
            return key if key in found else None
        return found[0] if found else None

    def select(self, key):
        """Show the tab ``key`` in the window."""
        with self.changed:
            self.focus = key
            self.opened += 1
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
            self.relabel()
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
                # a --wait asks again within 3 s (see listens); only after that is the terminal live again
                threading.Timer(3.2, self._relabel_later).start()

    def _relabel_later(self):
        with self.changed:
            self.relabel()

    def listens(self, key):
        """Whether a --wait waits for the document; it asks again every 25 s, so a short gap counts too."""
        return self.waiting.get(key, 0) > 0 or time.monotonic() - self.left.get(key, -10) < 3

    def listing(self):
        tabs = []
        for key, doc in self.docs.items():
            info = self.remote.get(key)
            if info:
                # served by the just-doc of that machine, through an ssh forward
                live = info.get("live", True)
                tab = {"id": key, "name": f"{info['machine']}: {info['name']}", "path": f"{info['machine']}:{info['path']}",
                       "live": live, "remote": info["machine"], "rid": info["id"], "rev": info.get("rev", 0), "file": info.get("file"),
                       "waiting": False, "pending": False, "terminal": info.get("terminal"),
                       "root": info.get("root") or str(PurePosixPath(info["path"]).parent)}
                if live:
                    tab["src"] = f"remote/{key}/live/{info['id']}/{urllib.parse.quote(info['name'])}"
                else:
                    # the viewer here; its requests for this id go on to the other machine
                    tab.update({"waiting": bool(info.get("waiting")), "waits": info.get("waits", 0),
                                "pending": bool(info.get("pending"))})
                tabs.append(tab)
                continue
            try:
                changed = doc.stat().st_mtime
            except OSError:
                changed = 0
            # a file that is being written is left alone until it is a second old
            if key not in self.stamp or time.time() - changed > 1:
                self.stamp[key] = changed
            live = key in self.live
            if not live:
                self.committed(key, doc)
            if key not in self.roots:
                self.roots[key] = str(project_root(doc))
            tabs.append({"id": key, "name": doc.name, "path": str(doc), "live": live, "rev": self.rev.get(key, 0),
                         "file": self.stamp[key], "waiting": self.listens(key), "waits": self.waiting.get(key, 0),
                         # a Ctrl+Enter that no --wait has taken yet
                         "pending": self.handed.get(key, 0) > self.taken.get(key, 0),
                         "terminal": self.terms.get(key), "root": self.roots[key]})
        groups = group_tabs(tabs)
        # build: the window loads itself again when just-doc was updated (restarted with another version)
        return {"tabs": tabs, "groups": groups, "focus": self.focus, "opened": self.opened, "quit": self.quit,
                "build": VERSION}

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


def project_root(path):
    """Return the project folder of a document: the nearest folder above it with a ``.git``, else its own folder."""
    path = Path(path)
    for folder in path.parents:
        if (folder / ".git").exists():
            return folder
    return path.parent


def group_tabs(tabs):
    """Group the tabs of the window by the session that opened them; set ``group`` on each tab.

    A group is the hc terminal that opened its documents, on its machine (``terminal``;
    ``remote`` is the machine name of a document of another machine). Documents without
    a terminal form the group "other" of their machine. Return the list of groups in the
    order of their first tab: ``id`` ("t1", "work2:t3", "other"), ``label``, ``machine``
    ("" here), ``terminal``, ``count``. The label is the last part of the common folder of
    the project folders of its documents (the repository folder where there is a ``.git``),
    with the machine in front for another machine; two equal labels get the terminal id.
    """
    groups = {}
    for tab in tabs:
        machine, terminal = tab.get("remote") or "", tab.get("terminal") or ""
        gid = (machine + ":" if machine else "") + (terminal or "other")
        tab["group"] = gid
        g = groups.setdefault(gid, {"id": gid, "machine": machine, "terminal": terminal, "count": 0, "roots": []})
        g["count"] += 1
        if terminal and tab.get("root"):
            g["roots"].append(tab["root"])
    for g in groups.values():
        name = "other"
        if g["roots"]:
            common = posixpath.commonpath(g["roots"]) if len({r.startswith("/") for r in g["roots"]}) == 1 else ""
            name = posixpath.basename(common.rstrip("/")) or common or "/"
        g["label"] = f"{g['machine']}: {name}" if g["machine"] else name
        del g["roots"]
    labels = [g["label"] for g in groups.values()]
    for g in groups.values():
        if labels.count(g["label"]) > 1 and g["terminal"]:
            g["label"] += f" {g['terminal']}"
    return list(groups.values())


def config():
    """Return the settings in ``~/.config/just-doc/config.json``, or none.

    ``{"ssh": "ssh", "machines": {"NAME": {"target": "user@host", "just-doc": "~/bin/just-doc"}}}``:
    the ssh command, and for a machine name the ssh target and the just-doc command there.
    """
    path = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "just-doc" / "config.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        print(f"just-doc: {path} is not read: {exc}", file=sys.stderr)
        return {}


def ssh_command():
    return shlex.split(config().get("ssh", "ssh"))


class Forwards:
    """Ports of this machine forwarded by ssh to the just-doc of another machine.

    A forward is made when it is first needed and closed after ten minutes in
    which nothing used it. When a shared connection to the host (ControlMaster)
    is open, the forward is added to it (``ssh -O forward``) and taken off again
    (``ssh -O cancel``); otherwise an own ``ssh -N -L`` keeps it.
    """
    IDLE = 600

    def __init__(self):
        self.lock = threading.Lock()
        self.open = {}   # (ssh target, port there) -> [ssh process or None (shared), port here, when last used]

    @staticmethod
    def _reaches(local):
        try:
            socket.create_connection(("127.0.0.1", local), timeout=0.5).close()
            return True
        except OSError:
            return False

    @staticmethod
    def _spec(local, remote):
        return f"127.0.0.1:{local}:127.0.0.1:{remote}"

    def port(self, target, remote):
        """Return the local port that leads to port ``remote`` on ``target``."""
        with self.lock:
            fwd = self.open.get((target, remote))
            if fwd and (fwd[0].poll() is None if fwd[0] else self._reaches(fwd[1])):
                fwd[2] = time.monotonic()
                return fwd[1]
            if fwd:
                self._close(target, remote, fwd)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                local = sock.getsockname()[1]
            spec, proc = self._spec(local, remote), None
            shared = subprocess.run(ssh_command() + ["-O", "check", "--", target], capture_output=True, timeout=10)
            if shared.returncode == 0:
                res = subprocess.run(ssh_command() + ["-O", "forward", "-L", spec, "--", target],
                                     capture_output=True, text=True, timeout=20)
                if res.returncode:
                    raise RuntimeError(f"ssh {target} could not forward a port: {res.stderr.strip()}")
            else:
                cmd = ssh_command() + ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no",
                                       "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
                                       "-L", spec, "--", target]
                err = tempfile.TemporaryFile()
                proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err)
            end = time.monotonic() + 30
            while not self._reaches(local):
                if proc and proc.poll() is not None:
                    err.seek(0)
                    raise RuntimeError(f"ssh {target} could not forward a port: "
                                       + err.read().decode("utf-8", "replace").strip())
                if time.monotonic() > end:
                    self._close(target, remote, [proc, local, 0])
                    raise RuntimeError(f"ssh {target} did not forward a port in 30 s")
                time.sleep(0.1)
            self.open[(target, remote)] = [proc, local, time.monotonic()]
            return local

    def _close(self, target, remote, fwd):
        proc, local, _ = fwd
        if proc:
            proc.terminate()
        else:
            subprocess.run(ssh_command() + ["-O", "cancel", "-L", self._spec(local, remote), "--", target],
                           capture_output=True, timeout=10)
        self.open.pop((target, remote), None)

    def reap(self, everything=False):
        """Close the forwards that were not used for ten minutes, or all of them."""
        with self.lock:
            for (target, remote), fwd in list(self.open.items()):
                if everything or (fwd[0] and fwd[0].poll() is not None) or time.monotonic() - fwd[2] > self.IDLE:
                    try:
                        self._close(target, remote, fwd)
                    except (OSError, subprocess.TimeoutExpired):
                        self.open.pop((target, remote), None)


def watch_remote(tabs):
    """Look every two seconds whether a remote document changed, while a window is open; close idle forwards."""
    while True:
        time.sleep(2)
        tabs.forwards.reap()
        if not tabs.windows:
            continue
        for key, info in list(tabs.remote.items()):
            try:
                local = tabs.forwards.port(info["target"], info["port"])
                state = ask(f"http://127.0.0.1:{local}/api/tabs", timeout=3)
                tab = next(t for t in state["tabs"] if t["id"] == info["id"])
            except Exception:  # noqa: BLE001
                continue
            tabs.remote_file(key, tab["file"], tab.get("rev", 0),
                             (bool(tab.get("waiting")), tab.get("waits", 0), bool(tab.get("pending"))))


@functools.lru_cache(maxsize=1)
def plotly_bundle():
    """Return Plotly followed by plotly-theme.js, as /_lib/plotly.min.js serves it; the files stay as they are."""
    lib = WEB / "_lib"
    return (lib / "plotly.min.js").read_bytes() + b"\n" + (lib / "plotly-theme.js").read_bytes()


# the requests of the viewer that a PDF of another machine answers there
REMOTE_ROUTES = ("/doc", "/api/info", "/api/annotations", "/api/done", "/api/rounds", "/api/before",
                 "/api/export", "/api/pdf", "/api/reply")


def make_handler(tabs):
    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript",
                          ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm"}

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

        def _live(self, route):
            """Send a file of the folder of a live page: ``/live/<id>/<path in the folder>``.

            Nothing outside that folder is sent, also not through a link.
            """
            _, _, key, rel = route.split("/", 3) if route.count("/") >= 3 else ("", "", "", "")
            doc = tabs.docs.get(key) if key in tabs.live else None
            rel = urllib.parse.unquote(rel)
            old = re.fullmatch(r"\.jd-(round\d+|commit)\.html", rel)
            if old and doc is not None:
                # an earlier version of the page, in the folder of the page so that its relative files work
                copy = kept_live(doc, old[1] + ".html")
                if old[1] == "commit":
                    body = git(doc, "show", "HEAD:./" + doc.name)
                else:
                    body = copy.read_bytes() if copy.exists() else None
                if body is None:
                    self._json(404, {"error": "the page is not in git, or not committed yet" if old[1] == "commit"
                                     else "the page of this round is not kept"})
                else:
                    self._send(200, body, "text/html; charset=utf-8")
                return
            try:
                base = doc.parent.resolve()
                file = (base / rel).resolve()
                if file == base or base not in file.parents or not file.is_file():
                    raise ValueError
                body = file.read_bytes()
            except (AttributeError, OSError, ValueError):
                self._json(404, {"error": "not found"})
                return
            ctype = self.extensions_map.get(file.suffix.lower()) or mimetypes.guess_type(file.name)[0]
            self._send(200, body, ctype or "application/octet-stream")

        def _remote(self, body=None):
            """Pass ``/remote/<id>/<path>`` on to the just-doc of the other machine as ``/<path>``.

            ``body`` is the body of a POST request, None for GET.
            """
            url = urllib.parse.urlsplit(self.path)
            _, _, key, rest = (url.path.split("/", 3) + ["", "", "", ""])[:4]
            self._pass(tabs.remote.get(key), rest, url.query, body)

        def _pass(self, info, rest, query, body=None):
            """Ask the just-doc of the machine of ``info`` for ``/<rest>?<query>`` and send its answer on."""
            if info is None:
                self._json(404, {"error": "not found"})
                return
            try:
                local = tabs.forwards.port(info["target"], info["port"])
                there = f"http://127.0.0.1:{local}/{rest}" + (f"?{query}" if query else "")
                req = urllib.request.Request(there, data=body, headers={} if body is None else
                                             {"Content-Type": self.headers.get("Content-Type", "")})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    code, ctype, body = resp.status, resp.headers.get("Content-Type"), resp.read()
            except urllib.error.HTTPError as exc:
                code, ctype, body = exc.code, exc.headers.get("Content-Type"), exc.read()
            except (OSError, RuntimeError) as exc:
                self._json(502, {"error": f"{info['machine']}: {exc}"})
                return
            self._send(code, body, ctype or "application/octet-stream")

        def _remote_pdf(self, route, key, body=None):
            """Pass a request for a PDF of another machine (``?d=`` is its tab here) on there; False if it is not one."""
            info = tabs.remote.get(key)
            if info is None or info.get("live", True) or route not in REMOTE_ROUTES:
                return False
            query = urllib.parse.urlsplit(self.path).query
            query = urllib.parse.urlencode([(k, info["id"] if k == "d" else v)
                                            for k, v in urllib.parse.parse_qsl(query, keep_blank_values=True)])
            self._pass(info, route.lstrip("/"), query, body)
            return True

        def do_GET(self):
            route, key, doc = self._route()
            if self._remote_pdf(route, key):
                return
            if route.startswith("/live/"):
                self._live(route)
            elif route.startswith("/remote/"):
                self._remote()
            elif route == "/_lib/plotly.min.js":
                self._send(200, plotly_bundle(), "text/javascript")
            elif route == "/api/latest":
                # for --hc-terminal --print: the document of a terminal, without showing it
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                terminal = query.get("t", [""])[0]
                if query.get("list"):
                    # every document of the terminal, newest first (for --list)
                    names = {t["id"]: t for t in tabs.listing()["tabs"]}
                    self._json(200, {"docs": [{**{k: names[key][k] for k in ("id", "name", "path", "live", "file")}, "time": stamp}
                                              for key, stamp in tabs.of_terminal(terminal) if key in names]})
                    return
                last = tabs.latest(terminal, query.get("id", [None])[0])
                tab = next((t for t in tabs.listing()["tabs"] if t["id"] == last), None)
                if tab is None:
                    self._json(404, {"error": "no document from this terminal"})
                else:
                    self._json(200, {k: tab[k] for k in ("id", "name", "path", "live", "file", "root")})
            elif route == "/api/events":
                self._events()
            elif route == "/api/tabs":
                self._json(200, {"app": "just-doc", "version": VERSION, "features": FEATURES, "windows": tabs.shown(),
                                 **tabs.listing()})
            elif route == "/api/session":
                self._json(200, {"version": VERSION, "tabs": tabs.session()})
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
            elif route == "/api/was":
                # the words of a live page as they were at the Ctrl+Enter of round n
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                try:
                    text = kept_live(doc, f"round{int(query['n'][0])}.txt").read_text(encoding="utf-8")
                except (OSError, KeyError, ValueError, TypeError, AttributeError):
                    self._json(404, {"error": "the text of this round is not kept"})
                else:
                    self._json(200, {"text": text})
            elif route == "/api/rounds":
                self._json(200, {"rounds": live_rounds(doc) if key in tabs.live else rounds(doc)})
            elif route == "/api/info":
                self._json(200, {"name": doc.name, "path": str(doc), "file": doc.stat().st_mtime})
            elif route == "/api/annotations":
                self._json(200, load_comments(doc, key in tabs.live))
            elif route == "/api/wait":
                # answers within half a minute, so the command notices when just-doc is gone
                seconds = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("s", ["25"])[0]
                done = tabs.wait(key, min(25.0, float(seconds)))
                if done:
                    # the comments that the --wait prints now: the window shows them as seen
                    mark_seen(doc, key in tabs.live)
                    tabs.touch(key)
                self._json(200, {"done": done})
            else:
                super().do_GET()

        def _body(self):
            size = int(self.headers.get("Content-Length", "0"))
            return json.loads(self.rfile.read(size).decode("utf-8"))

        def do_POST(self):
            route, key, doc = self._route()
            if route in REMOTE_ROUTES and key in tabs.remote and not tabs.remote[key].get("live", True):
                # comments, Ctrl+Enter and export of a PDF of another machine are kept there, where its agent runs
                self._remote_pdf(route, key, self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                return
            if route.startswith("/remote/"):
                # the answers of a live page of another machine are kept there, where its agent runs
                self._remote(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                return
            if route == "/api/answers":
                # Ctrl+Enter in a live page: its fields; JSON only, as /api/open
                try:
                    if self.headers.get("Content-Type") != "application/json":
                        raise ValueError("JSON expected")
                    if key not in tabs.live or doc is None:
                        raise ValueError("this is not a live page that is open")
                    obj = self._body()
                    answers = obj["answers"]
                    if not isinstance(answers, dict):
                        raise ValueError("answers must be an object")
                    text = obj.get("text")
                    number = save_answers(doc, answers)
                    keep_live_round(doc, number, text if isinstance(text, str) else "")
                except (OSError, KeyError, ValueError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                self._json(200, {"ok": True, "round": number, "listening": tabs.hand(key)})
                return
            if route == "/api/open":
                # a web page cannot send JSON to another address, so this comes from the just-doc command
                if self.headers.get("Content-Type") != "application/json":
                    self._json(400, {"error": "JSON expected"})
                    return
                try:
                    obj = self._body()
                    new, live, terminal = Path(obj["path"]), bool(obj.get("live")), obj.get("terminal")
                    if not new.is_file():
                        raise ValueError(f"not found: {new}")
                    if live and new.suffix.lower() not in HTML:
                        raise ValueError("only an HTML file can be shown live")
                    if not live:
                        shown_pdf(new)
                except Exception as exc:  # noqa: BLE001
                    self._json(400, {"error": str(exc)})
                    return
                windows = tabs.shown()
                tabs.open(new, live, terminal)
                self._json(200, {"ok": True, "windows": windows})
                return
            if route == "/api/focus":
                # the tab of the document that a terminal opened or changed last; JSON only, as above
                if self.headers.get("Content-Type") != "application/json":
                    self._json(400, {"error": "JSON expected"})
                    return
                body = self._body()
                key = tabs.latest(str(body.get("terminal")), body.get("id"))
                if key is None:
                    self._json(404, {"error": "no document from this terminal"})
                    return
                tabs.select(key)
                self._json(200, {"ok": True, "name": tabs.docs[key].name, "windows": tabs.shown()})
                return
            if route == "/api/remote":
                # a document of another machine, from --hc-machine; JSON only, as above
                if self.headers.get("Content-Type") != "application/json":
                    self._json(400, {"error": "JSON expected"})
                    return
                try:
                    obj = self._body()
                    info = {k: obj[k] for k in ("machine", "port", "id", "name", "path", "file")}
                    info["live"] = bool(obj.get("live", True))
                    # the hc terminal there and the project folder there, for the group of the tab
                    info["terminal"] = str(obj["terminal"]) if obj.get("terminal") else None
                    info["root"] = str(obj["root"]) if obj.get("root") else None
                    # the ssh target comes from the machine name here, never from the request
                    info["target"], info["port"] = machine_target(str(info["machine"]))[0], int(info["port"])
                    tabs.forwards.port(info["target"], info["port"])
                except (KeyError, TypeError, ValueError, OSError, RuntimeError) as exc:
                    self._json(502, {"error": str(exc)})
                    return
                windows = tabs.shown()
                tabs.open_remote(info)
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
                    tabs.relabel(clear=True)
                    tabs.changed.notify_all()
                self._json(200, {"ok": True})
                # a moment later, so that every window still hears of it and closes
                # (and once the hc labels are cleared, for at most 3 s more)
                def stop(server=self.server):
                    end = time.monotonic() + 3
                    while tabs.hc.unfinished_tasks and time.monotonic() < end:
                        time.sleep(0.05)
                    server.shutdown()
                threading.Timer(0.7, stop).start()
                return
            if route == "/api/stop":
                # a newer just-doc takes over (see restart): stop without closing the windows, which
                # connect again to the new one and load themselves again; JSON only, as /api/quit
                if self.headers.get("Content-Type") != "application/json":
                    self._json(400, {"error": "JSON expected"})
                    return
                self._json(200, {"ok": True})
                threading.Timer(0.2, self.server.shutdown).start()
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
                    answer(doc, str(obj["ref"]), None if text is None else str(text), str(obj.get("from", "")),
                           key in tabs.live)
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
                keep_replies(doc, obj["annots"], key in tabs.live)
                numbered(obj["annots"])
                save_comments(doc, obj["annots"], key in tabs.live)
            self._json(200, {"ok": True, "n": len(obj["annots"])})

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, *args):
            pass

    return Handler


def has_display():
    """Whether a window can be opened: on Linux, not over ssh without a display."""
    return not sys.platform.startswith("linux") or bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("DISPLAY"))


def open_window(url):
    """Open ``url`` in a chromeless app window, or in the default browser; nothing on a machine without a display."""
    if not has_display():
        return
    for name in BROWSERS:
        exe = shutil.which(name)
        if exe:
            subprocess.Popen([exe, f"--app={url}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return
    webbrowser.open(url)


_held = threading.local()


@contextlib.contextmanager
def server_lock(port):
    """Hold the lock of starting, finding and updating the just-doc of ``port`` (Linux, macOS).

    Two commands at the same moment would otherwise both start a just-doc, or
    both restart one; the second waits here and then finds the first one's.
    The same process may take it again (a restart inside a hand-over).
    """
    depth = getattr(_held, "depth", 0)
    if depth:
        _held.depth = depth + 1
        try:
            yield
        finally:
            _held.depth -= 1
        return
    with open(cache_dir() / f"server-{port or PORT}.lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        _held.depth = 1
        try:
            yield
        finally:
            _held.depth = 0
            fcntl.flock(f, fcntl.LOCK_UN)


def port_free(port):
    """Whether a just-doc could listen on ``port`` now."""
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def port_owner(port):
    """Return the process id that listens on the local TCP ``port``, or None (Linux only)."""
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            f = line.split()
            # state 0A: listening
            if int(f[1].rsplit(":", 1)[1], 16) == port and f[3] == "0A":
                inodes.add(f[9])
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            for fd in (proc / "fd").iterdir():
                if os.readlink(fd) in {f"socket:[{i}]" for i in inodes}:
                    return int(proc.name)
        except OSError:
            continue
    return None


def busy(state):
    """Whether a --wait waits on the just-doc whose /api/tabs answer is ``state``."""
    # an older just-doc has only "waiting", which stays true for 3 s after a --wait ended; the
    # --wait of a document of another machine waits on the just-doc there, not on this one
    return any(t.get("waits", t.get("waiting")) for t in state.get("tabs", []) if not t.get("remote"))


def restart(url, state):
    """Stop the just-doc at ``url`` and start this version in its place, with the same tabs.

    Comments and answers are on disk already; the tabs, the hc terminals they came
    from and a Ctrl+Enter that no --wait has taken yet are carried over. A window of
    a just-doc that can be updated this way stays and loads itself again; the window
    of an older one closes, and a new one opens when there is a display.
    """
    port = urllib.parse.urlsplit(url).port
    newer = "session" in state.get("features", [])
    if newer:
        session = ask(url + "api/session", timeout=5)["tabs"]
    else:
        # an older just-doc: its listing has the documents, without terminals; its pages of
        # other machines cannot be opened again from it
        session = [{"path": t["path"], "live": bool(t.get("live")), "pending": bool(t.get("pending")),
                    "focus": t["id"] == state.get("focus")} for t in state.get("tabs", []) if not t.get("remote")]
    fd, saved = tempfile.mkstemp(prefix="just-doc-session-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(session, f)
    try:
        ask(url + ("api/stop" if newer else "api/quit"), {}, timeout=5)
    except Exception:  # noqa: BLE001
        pass
    for attempt in range(100):
        if port_free(port):
            break
        if attempt == 50:
            # it did not stop by itself
            pid = port_owner(port)
            if pid:
                os.kill(pid, signal.SIGTERM)
        time.sleep(0.1)
    else:
        os.unlink(saved)
        raise RuntimeError(f"the just-doc at {url} runs another version and could not be stopped; stop it and run this again")
    window = not newer and state.get("windows", 0) > 0
    # the windows of a newer one connect again by themselves, in a few seconds
    expect = newer and state.get("windows", 0) > 0
    cmd = [sys.executable, "-c", f"import just_doc; just_doc.resume({port}, {window}, {saved!r}, {expect})"]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(150):
        time.sleep(0.1)
        try:
            if ask(url + "api/tabs", timeout=1).get("version") == VERSION:
                print(f"just-doc: updated the running just-doc at {url} to this version ({len(session)} tab(s) kept)",
                      file=sys.stderr)
                return
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError(f"the new just-doc at {url} did not start")


def resume(port, window, saved, expect=False):
    """Serve on ``port`` the tabs saved by restart in the file ``saved``."""
    session = json.loads(Path(saved).read_text(encoding="utf-8"))
    Path(saved).unlink(missing_ok=True)
    serve(None, port, window, session=session, exact=True, locked=True, expect=expect)


def current(url, state, needs=()):
    """Return the /api/tabs answer ``state`` of the just-doc at ``url``, after updating it to this version.

    A just-doc of another version is restarted as this one (see restart) unless a
    --wait waits on it; then it stays as it is, with a note, and a request that it
    cannot do (``needs``, names from FEATURES) ends this command.
    """
    if state.get("version") == VERSION:
        return state
    with server_lock(urllib.parse.urlsplit(url).port):
        # another command may have updated it while this one waited for the lock
        state = ask(url + "api/tabs", timeout=5)
        if state.get("version") == VERSION:
            return state
        if not busy(state):
            restart(url, state)
            return ask(url + "api/tabs", timeout=5)
    message = (f"the just-doc at {url} runs another version; it is updated when the just-doc --wait "
               "that waits on it ends")
    missing = [n for n in needs if n not in state.get("features", [])]
    if missing:
        fail(f"{message}; until then it cannot do this ({', '.join(missing)})")
    print(f"just-doc: note: {message}", file=sys.stderr)
    return state


def update_later(url):
    """After a --wait: update the just-doc at ``url`` in the background once no --wait waits on it."""
    try:
        if ask(url + "api/tabs", timeout=2).get("version") == VERSION:
            return
    except Exception:  # noqa: BLE001
        return
    cmd = [sys.executable, "-c", f"import just_doc; just_doc.update_when_idle({url!r})"]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def update_when_idle(url):
    # an older just-doc counts a --wait as waiting for 3 s after it ended
    time.sleep(4)
    try:
        state = ask(url + "api/tabs", timeout=2)
        if state.get("version") != VERSION and not busy(state):
            current(url, state)
    except Exception:  # noqa: BLE001
        pass


def hand_over(url, doc, live=False, terminal=None):
    """Open ``doc`` as a tab of the just-doc that runs at ``url``.

    Returns the number of windows it has, or None when no just-doc answers there.
    """
    try:
        with urllib.request.urlopen(url + "api/tabs", timeout=1) as resp:
            state = json.loads(resp.read())
        if state.get("app") != "just-doc":
            return None
    except Exception:  # noqa: BLE001
        return None
    state = current(url, state, ["live"] if live else [])
    body = {"path": str(doc), "live": live, "terminal": terminal}
    req = urllib.request.Request(url + "api/open", data=json.dumps(body).encode("utf-8"),
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


def running(doc, port, live=False):
    """Find the just-doc that has ``doc`` open (``live``: as a live page).

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
            if tab["path"] == str(doc) and bool(tab.get("live")) == live:
                state = current(url, state, ["live-comments"] if live else [])
                # the tab id stays the same in a just-doc that was updated
                return url, tab["id"], state["windows"]
    return None


def reply(doc, replies, done, name, port, live=False):
    """Add replies to comments and mark comments as done (``live``: of the live page).

    This goes through the running just-doc, so that its window shows them.
    """
    found = running(doc, port, live)
    annots = load_comments(doc, live)["annots"]
    # a number stays with its comment, so it means the one --wait printed
    changes = [(find_comment(doc, annots, ref, live).get("id", ref), text) for ref, text in replies]
    changes += [(find_comment(doc, annots, ref, live).get("id", ref), None) for ref in done]
    for ref, text in changes:
        if found:
            ask(f"{found[0]}api/reply?d={found[1]}", {"ref": ref, "text": text, "from": name})
        else:
            answer(doc, ref, text, name, live)
    print(f"{len(replies)} reply(ies), {len(done)} done -> {comments_path(doc, live).name}"
          + ("" if found else " (not open in a window)"))


def wait(doc, port, window, as_json, limit, live=False):
    """Open ``doc`` if it is not open, wait for Ctrl+Enter in its window, then print the comments.

    For a ``live`` page print its open comments and the answers: its fields at the Ctrl+Enter.
    """
    found = running(doc, port, live)
    if found and window and not found[2]:
        open_window(found[0])
    if not found:
        # a just-doc of its own, which stays when this command ends
        if not live:
            shown_pdf(doc)
        cmd = [sys.executable, "-c", "import just_doc; just_doc.main()", str(doc)] + (["--live"] if live else [])
        cmd += (["--port", str(port)] if port else []) + ([] if window else ["--no-window"])
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            time.sleep(0.1)
            found = running(doc, port, live)
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
    if live:
        read_live(doc, as_json, only_open=True)
    else:
        read(doc, as_json, only_open=True)
    # a just-doc of another version, which could not be updated while this waited
    update_later(url)


def serve(doc, port, window, live=False, session=None, exact=False, locked=False, expect=False):
    """Serve ``doc`` (None: no document yet) or hand it over to the just-doc that runs already.

    ``session``: tabs to open, from a just-doc that was updated (see restart);
    ``exact``: on ``port`` only; ``locked``: the command that started this one
    holds the lock of the port (see restart).
    """
    with contextlib.nullcontext() if locked else server_lock(port):
        server, tabs, url = _start(doc, port, window, live, session, exact, expect)
    if server is None:
        return
    threading.Thread(target=watch_remote, args=(tabs,), daemon=True).start()
    # a kill ends it as Ctrl+C does, so that its ssh forwards are closed too
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        tabs.forwards.reap(everything=True)


def _start(doc, port, window, live, session, exact, expect=False):
    """Listen on a free port with the tabs of serve, or hand ``doc`` over; return (server, tabs, url) or Nones."""
    terminal = os.environ.get("HC_TERMINAL_ID") or None
    # One just-doc serves all open documents: the first command starts it, and every later
    # command hands its document over to it as a new tab and returns.
    first = port or PORT
    for candidate in range(first, first + (1 if exact else 20)):
        url = f"http://127.0.0.1:{candidate}/"
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), make_handler(tabs := Tabs()))
        except OSError:
            if doc is None:
                # a just-doc runs there already (one started at the same moment): nothing more to do
                try:
                    if ask(url + "api/tabs", timeout=2).get("app") == "just-doc":
                        return None, None, url
                except Exception:  # noqa: BLE001
                    pass
                continue
            windows = hand_over(url, doc, live, terminal)
            if windows is None:
                continue
            print(f"{doc.name}: new tab in the running just-doc, {url}")
            if window and not windows:
                open_window(url)
            return None, None, url
        if session:
            tabs.restore(session)
        if doc is None:
            print(f"{url}  (Ctrl+C to stop)")
        else:
            tabs.open(doc, live, terminal)
            print(f"{doc.name}: {url}  ({'live' if live else 'comments -> ' + comments_path(doc).name}, Ctrl+C to stop)")
        if (window and has_display()) or expect:
            # a command right after this one counts the window as open while it starts (or connects again)
            tabs.opening = time.monotonic() + 20
        if window and has_display():
            open_window(url)
        return server, tabs, url
    sys.exit("no free port found")


def raise_window():
    """Bring the just-doc window to the front on Hyprland; return whether it was found.

    The window is known by its title, which ends in "– just-doc".
    """
    if not shutil.which("hyprctl"):
        return False
    try:
        res = subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, text=True, timeout=5)
        found = [c for c in json.loads(res.stdout) if c.get("title", "").endswith("– just-doc")]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False
    if not found:
        return False
    # the one that had the focus last
    address = min(found, key=lambda c: c.get("focusHistoryID", 0))["address"]
    for cmd in (f'hl.dsp.focus({{ window = "address:{address}" }})',   # Hyprland with a Lua config
                f"focuswindow address:{address}"):                     # older Hyprland
        try:
            res = subprocess.run(["hyprctl", "dispatch", cmd], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return False
        if res.returncode == 0 and "error" not in (res.stdout + res.stderr).lower():
            return True
    return False


def fail(message):
    """End a --hc-terminal that found nothing: a short message on stderr and status 1."""
    print(f"just-doc: {message}", file=sys.stderr)
    sys.exit(1)


def hc_list(terminal, port):
    """Print every document of the hc terminal ``terminal``, newest first, one JSON object per line.

    Each has id, name, path, live, file, time (epoch seconds) and the port of its
    just-doc. Exits with status 1 and a short message when there is none.
    """
    first = port or PORT
    found = []
    for candidate in range(first, first + 20):
        try:
            got = ask(f"http://127.0.0.1:{candidate}/api/latest?t={urllib.parse.quote(terminal)}&list=1", timeout=1)
        except Exception:  # noqa: BLE001
            continue
        found += [{**doc, "port": candidate} for doc in got.get("docs", [])]
    if not found:
        fail(f"no open document from terminal {terminal}")
    for doc in sorted(found, key=lambda d: -d["time"]):
        print(json.dumps(doc, ensure_ascii=False))


def hc_terminal(terminal, port, window=True, as_print=False, doc_id=None):
    """Show the document that the hc terminal ``terminal`` opened or changed last, and raise the window.

    With ``doc_id`` show that document of the terminal instead.

    With ``as_print`` only print where it is, as JSON: the port of its just-doc
    and its id, name, path, whether it is live, its file time and its address
    there. Exits with status 1 and a short message when no running just-doc has
    a document from that terminal.
    """
    first = port or PORT
    for candidate in range(first, first + 20):
        url = f"http://127.0.0.1:{candidate}/"
        try:
            if as_print:
                got = ask(f"{url}api/latest?t={urllib.parse.quote(terminal)}"
                          + (f"&id={urllib.parse.quote(doc_id)}" if doc_id else ""), timeout=1)
                got["url"] = (f"/live/{got['id']}/{urllib.parse.quote(got['name'])}" if got["live"]
                              else f"/view?d={got['id']}")
                print(json.dumps({"port": candidate, **got}, ensure_ascii=False))
                return
            state = ask(url + "api/tabs", timeout=1)
            if state.get("app") != "just-doc":
                continue
            # a just-doc of another version is updated first, as the other commands do
            current(url, state)
            got = ask(url + "api/focus", {"terminal": terminal, **({"id": doc_id} if doc_id else {})}, timeout=5)
        except Exception:  # noqa: BLE001
            continue
        if window and not got["windows"]:
            open_window(url)
        elif window:
            raise_window()
        print(f"{got['name']}: {url}")
        return
    fail(f"no open document {doc_id} from terminal {terminal}" if doc_id else f"no open document from terminal {terminal}")


def machine_target(name):
    """Return the ssh target of the hc machine ``name`` and its settings from the config file.

    The config file decides first, then ``hc machine ls``; otherwise the name is the target.
    """
    if not name or name.startswith("-"):
        raise ValueError(f"not a machine name: {name!r}")
    conf = config().get("machines", {}).get(name, {})
    if conf.get("target"):
        return conf["target"], conf
    if shutil.which("hc"):
        try:
            out = subprocess.run(["hc", "machine", "ls"], capture_output=True, text=True, timeout=5).stdout
            for m in json.loads(out).get("machines", []):
                if m.get("name") == name and not m.get("via") and m.get("target"):
                    return m["target"], conf
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    return name, conf


def local_just_doc(port):
    """Return the address of the just-doc that runs here; start one without a window if none does."""
    first = port or PORT
    for attempt in range(60):
        for candidate in range(first, first + 20):
            url = f"http://127.0.0.1:{candidate}/"
            try:
                state = ask(url + "api/tabs", timeout=1)
            except Exception:  # noqa: BLE001
                continue
            if state.get("app") != "just-doc":
                continue
            current(url, state, ["remote"])
            return url
        if attempt == 0:
            cmd = [sys.executable, "-c", f"import just_doc; just_doc.serve(None, {port}, False)"]
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        time.sleep(0.2)
    fail("could not start just-doc")


def hc_remote_list(terminal, machine):
    """Print the documents of the terminal ``terminal`` on the machine ``machine`` (as ``hc_list`` does there), with "machine" added."""
    try:
        target, conf = machine_target(machine)
    except ValueError as exc:
        fail(str(exc))
    there = conf.get("just-doc", 'PATH="$HOME/.local/bin:$PATH" just-doc')
    cmd = ssh_command() + ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target,
                           f"{there} --hc-terminal {shlex.quote(terminal)} --list"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail(f"ssh {target}: {exc}")
    if res.returncode == 255:
        fail(f"ssh {target}: " + (res.stderr.strip().splitlines() or ["failed"])[-1])
    docs = []
    for line in res.stdout.splitlines():
        try:
            docs.append({**json.loads(line), "machine": machine})
        except ValueError:
            continue
    if not docs:
        fail(f"no open document from terminal {terminal} on {machine}")
    for doc in docs:
        print(json.dumps(doc, ensure_ascii=False))


def hc_remote(terminal, machine, port, window=True, doc_id=None):
    """Show the document (live page or PDF) that the hc terminal ``terminal`` of the machine ``machine`` opened or changed last.

    The just-doc there is asked over ssh (``--hc-terminal ID --print``); its document
    comes through an ssh forward into a tab of the window here. With ``doc_id`` it is
    that document (its id there, from ``--list``) instead of the latest one.
    """
    try:
        target, conf = machine_target(machine)
    except ValueError as exc:
        fail(str(exc))
    there = conf.get("just-doc", 'PATH="$HOME/.local/bin:$PATH" just-doc')
    cmd = ssh_command() + ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target,
                           f"{there} --hc-terminal {shlex.quote(terminal)} --print"
                           + (f" --doc {shlex.quote(doc_id)}" if doc_id else "")]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail(f"ssh {target}: {exc}")
    if res.returncode == 255:
        fail(f"ssh {target}: " + (res.stderr.strip().splitlines() or ["failed"])[-1])
    try:
        got = json.loads(res.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        fail(f"no open document from terminal {terminal} on {machine}")
    url = local_just_doc(port)
    info = {"machine": machine, "port": got["port"], "id": got["id"], "name": got["name"],
            "path": got["path"], "file": got.get("file"), "live": bool(got.get("live")),
            "terminal": terminal, "root": got.get("root")}
    try:
        state = ask(url + "api/remote", info, timeout=90)
    except (OSError, RuntimeError) as exc:
        fail(str(exc))
    if window and not state["windows"]:
        open_window(url)
    elif window:
        raise_window()
    print(f"{machine}: {got['name']}: {url}")


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
    for a in annots:
        a["open"] = is_open(a)
    shown = [a for a in annots if a["open"] or not only_open]
    if as_json:
        print(json.dumps(shown, ensure_ascii=False, indent=1))
        return
    for a in shown:
        i = a["n"]
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


def scene_text(scene):
    """Return the part and the point of a comment pinned to a model in a <jd-scene>: ``part: housing  at (12.3, 4.5, 8) mm``."""
    point = ", ".join(f"{float(v):.5g}" for v in scene.get("point") or [])
    unit = f" {scene['units']}" if scene.get("units") else ""
    return f"part: {scene.get('part') or '?'}  at ({point}){unit}"


def anchor_text(a):
    """Return where a comment of a live page sits: the id, data-src and selector of its element, and for a point of a model its part and point."""
    anchor = a.get("anchor") or {}
    parts = [f"#{anchor['id']}" if anchor.get("id") else "", anchor.get("src") or "",
             "" if anchor.get("id") else anchor.get("selector") or "",
             scene_text(anchor["scene"]) if anchor.get("scene") else ""]
    return "  ".join(p for p in parts if p) or "(no anchor)"


def read_live(doc, as_json, only_open=False):
    """Print the comments of the live page ``doc`` and its last answers, as --read does for a PDF.

    With ``only_open`` (for --wait) only the comments that wait for an answer.
    """
    annots = load_comments(doc, live=True)["annots"]
    for a in annots:
        a["open"] = is_open(a)
    shown = [a for a in annots if a["open"] or not only_open]
    rounds = load_answers(doc)["rounds"]
    last = rounds[-1] if rounds else None
    if as_json:
        print(json.dumps({"comments": shown, "answers": last}, ensure_ascii=False, indent=1))
        return
    for a in shown:
        where = anchor_text(a)
        where += "  (done)" if a.get("done") else "" if a["open"] or only_open else "  (answered)"
        kind = "element:" if a.get("kind") == "element" else "text:"
        text = a.get("text") or "(no text inside)"
        if a.get("change") is not None and not a.get("text"):
            kind, text = "removed:", a["change"]
        scene = (a.get("anchor") or {}).get("scene")
        if scene:
            normal = ", ".join(f"{float(v):.4g}" for v in scene.get("normal") or [])
            kind, text = "surface:", f"a point on the surface of a 3D model, normal ({normal})"
        print(f"[{a['n']}] {where}\n    {kind:<8} {text}\n    comment: {a.get('comment') or '(none)'}")
        if a.get("change") is not None and a.get("text"):
            print(f"    (a comment on a change: before it, the text was: {a['change'] or '(nothing, it is new)'})")
        anchor = a.get("anchor") or {}
        if anchor.get("id") and anchor.get("selector"):
            print(f"    selector: {anchor['selector']}")
        if a.get("detached"):
            print("    (detached: the element is no longer found in the page; the comment was made on an older version)")
        for r in a.get("replies", []):
            print(f"    reply ({r.get('from') or 'author'}): {r['text']}")
        seen = a.get("seen", [])
        if a["open"] and len(seen) > 1 and stamp_key(spoke_at(a)) <= stamp_key(seen[-2]):
            print("    (shown to you before and not answered)")
        print()
    if last:
        print(f"answers (round {last['round']}, {last['at']}):")
        print(json.dumps(last["answers"], ensure_ascii=False))
        print()
    if only_open:
        print(f"{len(shown)} open comment(s), {len(annots) - len(shown)} done or answered "
              f"({doc.name} --live --read shows all)")
        print(f'Answer:  just-doc {doc.name} --live --reply N "text" [--done N] --from NAME   '
              f"then  just-doc {doc.name} --live --wait")
        print("How this works:  just-doc --guide")
    else:
        print(f"{len(annots)} comment(s) in {comments_path(doc, True).name}"
              + ("" if last else f"; no answers yet in {answers_path(doc).name}"))


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
                    help="add a reply to comment N (its number in --read and in the window, or its id); can be given several times")
    ap.add_argument("--done", action="append", metavar="N", default=[],
                    help="mark comment N as done: its highlight fades and leaves at the next Ctrl+Enter; can be given several times")
    ap.add_argument("--from", dest="name", default="reply", metavar="NAME", help="with --reply: the name on the reply")
    ap.add_argument("--export", action="store_true", help="write <name>.commented.pdf with the comments inside")
    ap.add_argument("--live", action="store_true",
                    help="show an HTML file as it is, with its scripts running, instead of as a PDF; its comments are kept in <name>.live.comments.json")
    ap.add_argument("--hc-terminal", metavar="ID",
                    help="bring the window to the front with the document that was opened or changed last "
                         "from this hc terminal (the HC_TERMINAL_ID of the shell that opened it)")
    ap.add_argument("--hc-machine", metavar="NAME", default="",
                    help="with --hc-terminal: the hc machine of the terminal (empty: this one); its document (PDF or live page) is "
                         "shown here through ssh")
    ap.add_argument("--print", dest="as_print", action="store_true",
                    help="with --hc-terminal: only print where the document is, as JSON (exit status 1: none)")
    ap.add_argument("--list", dest="as_list", action="store_true",
                    help="with --hc-terminal: print every document of the terminal, newest first, one JSON object per line "
                         "(id, name, path, live, file, time, port; also machine with --hc-machine; exit status 1: none)")
    ap.add_argument("--doc", metavar="ID", help="with --hc-terminal: show the document with this id (from --list) instead of the latest one")
    ap.add_argument("--shot", metavar="OUT.png",
                    help="save a picture of an HTML page as it looks live (with its scripts, /_lib/ served), "
                         "for an assistant to check the page before showing it; opens no window")
    ap.add_argument("--size", default="1500x900", metavar="WxH", help="with --shot: the size of the window (default 1500x900)")
    ap.add_argument("--port", type=int, default=0, help=f"port (default: {PORT})")
    ap.add_argument("--no-window", action="store_true", help="start the server only")
    args = ap.parse_args()
    if args.guide:
        print(GUIDE, end="")
        return
    if args.hc_terminal:
        if args.as_list:
            if args.hc_machine:
                hc_remote_list(args.hc_terminal, args.hc_machine)
            else:
                hc_list(args.hc_terminal, args.port)
        elif args.hc_machine and not args.as_print:
            hc_remote(args.hc_terminal, args.hc_machine, args.port, not args.no_window, args.doc)
        else:
            hc_terminal(args.hc_terminal, args.port, not args.no_window, args.as_print, args.doc)
        return
    if args.pdf is None:
        if args.reply or args.done or args.wait or args.read or args.export:
            ap.error("the file is missing")
        show(args.port, not args.no_window)
        return
    doc = args.pdf.resolve()
    if not doc.is_file():
        sys.exit(f"not found: {doc}")
    if args.live and doc.suffix.lower() not in HTML:
        ap.error("--live shows an HTML file")
    if args.live and args.export:
        ap.error("a live page cannot be exported; leave out --live")
    if args.shot and doc.suffix.lower() not in HTML:
        ap.error("--shot takes an HTML file")
    try:
        if args.shot:
            shot(doc, args.shot, args.size)
        elif args.export:
            out, count = export(doc)
            print(f"{count} annotation(s) -> {out}")
        elif args.reply or args.done:
            reply(doc, args.reply or [], args.done, args.name, args.port, args.live)
        elif args.wait:
            wait(doc, args.port, not args.no_window, args.json, args.timeout, args.live)
        elif args.read and args.live:
            read_live(doc, args.json)
        elif args.read:
            read(doc, args.json)
        elif args.live:
            serve(doc, args.port, not args.no_window, live=True)
        else:
            shown_pdf(doc)
            serve(doc, args.port, not args.no_window)
    except RuntimeError as exc:
        sys.exit(str(exc))


if __name__ == "__main__":
    main()
