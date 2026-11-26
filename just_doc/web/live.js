// Comments on live pages, loaded by tabs.html. The page stays as it is: its comments are drawn on
// a layer over it (#__jd_marks, outside its layout) and listed in a side panel of the window.
//
// A comment is anchored to an element of the page: the id (or data-src) of the element or of the
// nearest ancestor that has one, the path from there to the element, a CSS path from <body> and
// the quoted text with a little text before and after it. After the page is loaded again, the
// comment is placed by the id first, then by the quote, then by the CSS path; one that cannot be
// placed is marked detached and stays in the list.
//
// A comment can also be pinned to a point on the surface of a model in a <jd-scene> (scene.js in
// /_lib/three/): its anchor is the element, with anchor.scene = {part, point, normal, units}. The element
// draws the numbered markers; this file gives it the comments (setMarks), asks it for the point under
// the pointer (pick), has it show a selected point that is out of sight (reveal) and hears a click on a
// marker (jd-mark).
//
// What changed (m, M), the page as it was (gb) and the history of the rounds (gh) work on the text the
// reader sees, word by word: the words of the page now against the words at the last hand-over (kept
// by the server with every Ctrl+Enter) or at the last commit.
const LIVE = (() => {
  const S = {};          // tab id -> its state: t, f, annots, where, sel, editing, rounds, looked, filed, undo, pointer, changes, item, old, ...
  let panel = null;      // c: true / false; null: shown while the page has comments
  try { panel = JSON.parse(localStorage.getItem('livePanel')); } catch {}
  const side = document.createElement('div');
  side.id = 'side';
  document.body.appendChild(side);

  const api = (t, path) => t.remote ? `remote/${t.id}/${path}?d=${t.rid}` : `${path}?d=${t.id}`;
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const now = () => new Date().toISOString();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  
  // ---- anchoring ----

  // the text of root with runs of white space as one space, and for each character its text node and offset
  function textIndex(root) {
    const doc = root.ownerDocument, map = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n =>
      n.parentElement?.closest('script, style, noscript, template, #__jd_marks') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let str = '', space = true;
    for (let n; (n = walker.nextNode());) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const blank = /\s/.test(v[i]);
        if (blank && space) continue;
        str += blank ? ' ' : v[i];
        map.push([n, i]);
        space = blank;
      }
    }
    return { str, map };
  }

  // the occurrences of the quote in root, the one with the best matching text around it first
  function findText(root, quote, prefix = '', suffix = '') {
    const q = norm(quote);
    if (!q || !root) return [];
    const { str, map } = textIndex(root), hits = [];
    for (let at = str.indexOf(q); at >= 0; at = str.indexOf(q, at + 1)) {
      const score = (prefix && str.slice(Math.max(0, at - prefix.length), at) === prefix ? 2 : 0)
                  + (suffix && str.slice(at + q.length, at + q.length + suffix.length) === suffix ? 1 : 0);
      hits.push({ at, end: at + q.length, score, str, map });
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  function toRange(doc, h) {
    const r = doc.createRange(), [n1, i1] = h.map[h.at], [n2, i2] = h.map[h.end - 1];
    r.setStart(n1, i1);
    r.setEnd(n2, i2 + 1);
    return r;
  }

  const elementOf = node => node.nodeType === 1 ? node : node.parentElement;
  const keyed = el => el.closest('[id], [data-src]');

  // the path of tag:nth-of-type steps from root (not included) down to el
  function path(el, root) {
    const steps = [];
    for (let e = el; e && e !== root && e.parentElement; e = e.parentElement) {
      let k = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === e.localName) k++;
      steps.unshift(`${CSS.escape(e.localName)}:nth-of-type(${k})`);
    }
    return steps.join(' > ');
  }

  function anchorOf(doc, el, quote, prefix, suffix) {
    let base = keyed(el);
    if (base === doc.body || base === doc.documentElement) base = null;
    const src = el.closest('[data-src]')?.getAttribute('data-src') || null;
    return { id: base?.id || null, src, path: base ? path(el, base) : null,
             selector: 'body > ' + path(el, doc.body), tag: el.localName, quote, prefix, suffix };
  }

  // where a comment is now: a text range or an element, or null when it cannot be placed
  function locate(doc, a) {
    const an = a.anchor || {};
    let base = null;
    try {
      base = an.id ? doc.getElementById(an.id) : an.src ? doc.querySelector(`[data-src="${CSS.escape(an.src)}"]`) : null;
    } catch {}
    if (base) {
      if (a.kind === 'text') {
        const h = findText(base, an.quote ?? a.text, an.prefix, an.suffix)[0];
        if (h) return { range: toRange(doc, h) };
      }
      let el = base;
      if (an.path) try { el = base.querySelector(':scope > ' + an.path) || base; } catch {}
      return { el };
    }
    // an element with an id (or data-src) that is gone was removed: its text elsewhere is another element
    if (a.kind === 'element' && (an.id || an.src)) return null;
    const h = findText(doc.body, an.quote ?? a.text, an.prefix, an.suffix)[0];
    if (h) return a.kind === 'text' ? { range: toRange(doc, h) } : { el: elementOf(h.map[h.at][0]) };
    if (an.selector) try { const el = doc.querySelector(an.selector); if (el) return { el }; } catch {}
    return null;
  }

  // ---- storage ----

  async function load(st) {
    try { st.annots = (await (await fetch(api(st.t, 'api/annotations'))).json()).annots || []; } catch { return; }
    // a new comment that is still being written is not saved yet
    const e = st.editing;
    if (e?.mode === 'new' && e.annot && !st.annots.some(a => a.id === e.id)) st.annots.push(e.annot);
  }

  async function save(st) {
    try {
      const r = await fetch(api(st.t, 'api/annotations'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ annots: st.annots }) });
      if (!r.ok) throw new Error();
    } catch { toast('NOT SAVED: the server is not responding', true); return; }
    await load(st);   // the numbers come from the server
    place(st);
    draw();
  }

  // place every comment on the page; a change of "detached" is saved
  function place(st) {
    const doc = st.f.contentDocument;
    if (!doc?.body) return;
    st.where = {};
    let changed = false;
    for (const a of st.annots) {
      const loc = locate(doc, a);
      if (loc) st.where[a.id] = loc;
      if (!!a.detached !== !loc) { a.detached = !loc; changed = true; }
    }
    if (changed) save(st);
  }

  // ---- where a comment stands: as in the PDF viewer (index.html), with the same names ----

  // what was seen is remembered for each page between runs; the state of the tab is st
  const sk = (st, k) => `live:${st.t.remote || ''}|${st.t.path}:${k}`;
  const sget = (st, k, d) => { try { const v = localStorage.getItem(sk(st, k)); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const sset = (st, k, v) => { try { localStorage.setItem(sk(st, k), JSON.stringify(v)); } catch {} };

  // the times of the Ctrl+Enter presses, one per round, in seconds
  async function loadRounds(st) {
    try { st.rounds = (await (await fetch(api(st.t, 'api/rounds'))).json()).rounds || []; } catch {}
  }
  // the time of the last hand-over in ms; 0 before the first
  const roundStart = st => (st.rounds.at(-1) || 0) * 1000;
  // who spoke last on a comment: the name of the other side, or '' for the author
  const lastFrom = a => (a.replies || []).at(-1)?.from || '';
  // when the author last said something on a comment: its creation or their last reply, in ms
  const spokeAt = a => Math.max(Date.parse(a.created) || 0, ...(a.replies || []).filter(r => !r.from).map(r => Date.parse(r.at) || 0));
  // when a --wait last showed the comment to the assistant, in ms; 0 if never
  const seenAt = a => Date.parse((a.seen || []).at(-1)) || 0;

  // what came from outside for a comment; st.looked remembers this number for each comment between runs
  const outside = a => (a.replies || []).filter(r => r.from).length + (a.done ? 1 : 0);
  const isNew = (st, a) => outside(a) > (st.looked[a.id] || 0);

  function markSeen(st, id) {
    const a = st.annots.find(x => x.id === id);
    if (!a || !isNew(st, a)) return;
    st.looked[id] = outside(a);
    sset(st, 'seen', st.looked);
    showNews(st);
  }

  // the number of comments with news goes to the tab
  function showNews(st) {
    // with the changes marked, n goes through them too
    const n = st.changes ? reviewItems(st).filter(it => !itemSeen(st, it)).length : st.annots.filter(a => isNew(st, a)).length;
    if (st.badge !== n) { st.badge = n; window.tabNews?.(st.t.id, n, false); }
  }

  // A comment that is done leaves the list at the next Ctrl+Enter, if it was looked at by
  // then ("filed"); D shows those too.
  const listedNow = (st, a) => !(a.done && st.filed.includes(a.id)) || isNew(st, a);
  const listed = (st, a) => listedNow(st, a) || st.archive || a.id === st.sel;

  // where a comment stands, for the mark on its row: [class, word]
  function standing(st, a) {
    if (isNew(st, a)) return ['new', lastFrom(a) ? 'new reply' : 'new: done'];
    if (a.done) return ['done', 'done ✓'];
    if (lastFrom(a)) return ['read', 'answered'];
    // the author spoke last: since the hand-over, not shown to the assistant yet, or shown and left
    if (!st.rounds.length || spokeAt(a) > roundStart(st)) return ['draft', 'not handed over'];
    if (seenAt(a) >= spokeAt(a)) return ['skip', 'seen ' + new Date(seenAt(a)).toTimeString().slice(0, 5) + ', no reply'];
    return ['wait', 'not seen yet'];
  }

  // whether the row of a comment is open; the selected one is, unless it was closed with za
  const unfolded = (st, a) => a.id === st.sel ? !st.selFolded : st.allOpen !== st.flip.has(a.id);

  // za: open or close the row of the selected comment; zR / zM: open / close all rows
  function fold(st, all) {
    if (all) { st.allOpen = st.chgOpen = all === 'R'; st.flip.clear(); st.selFolded = !st.allOpen; draw(); return; }
    if (st.item && !st.sel) { st.chgOpen = !st.chgOpen; draw(); return; }
    if (!st.sel) { fhint('go to a comment first (n)'); setTimeout(() => fhint(''), 3000); return; }
    st.selFolded = !st.selFolded;
    draw();
  }

  // how a comment stands to the last hand-over: 1 written since, 2 answered or done since,
  // 3 open, 4 done before it; 0 before the first hand-over
  function groupOf(st, a) {
    const since = roundStart(st);
    return !since ? 0 : Date.parse(a.created) > since ? 1
      : (a.replies || []).some(r => r.from && Date.parse(r.at) > since) || Date.parse(a.done_at) > since ? 2 : a.done ? 4 : 3;
  }

  // whether you can still edit what you wrote last: the assistant has not seen it
  function unseen(a) {
    const last = (a.replies || []).at(-1), mine = last ? (!last.from ? last : null) : a;
    const spoke = mine && (mine === a ? a.created : mine.at);
    return !!spoke && !(a.seen || []).some(s => s >= spoke);
  }

  // the list is in page order, always: where a comment stands its mark on the row says
  function listOrder(st) {
    const at = a => { const l = st.where?.[a.id]; return l ? (l.range?.startContainer || l.el) : null; };
    return st.annots.filter(a => listed(st, a)).sort((a, b) => {
      const x = at(a), y = at(b);
      if (x && y && x !== y) { const c = x.compareDocumentPosition(y); if (c & 4) return -1; if (c & 2) return 1; }
      if (!x !== !y) return x ? -1 : 1;
      return (a.n ?? 1e9) - (b.n ?? 1e9);
    });
  }

  // ---- what changed: the words of the page now against the words of an earlier version ----
  // As in the PDF viewer (index.html), with the same words and marks. The page is compared by the text
  // the reader sees, not by its HTML; plots, pictures and the layout are not compared (gb shows them).

  const ALNUM = /[\p{L}\p{N}]/u;
  const SINCE = { handed: 'the last hand-over', commit: 'the last commit' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // the letters and digits of a word, in lower case: punctuation and hyphens do not matter
  function keyOf(s) {
    let key = '';
    for (const c of s) if (ALNUM.test(c)) { const l = c.toLowerCase(); key += l.length === 1 ? l : c; }
    return key;
  }

  // The words of a page in reading order, each as { raw, key, n1, i1, n2, i2, blk }: the word, its key,
  // where it starts and ends in the DOM and the block it stands in. Text in scripts, styles, plots
  // (svg), canvas and fields, hidden text and the marks of just-doc are left out. A word ends at a
  // space and at the end of a block.
  function wordsOf(doc) {
    const win = doc.defaultView, shown = new Map(), blocks = new Map(), words = [];
    const visible = e => {
      let v = shown.get(e);
      if (v === undefined) { v = !e.checkVisibility || e.checkVisibility(); shown.set(e, v); }
      return v;
    };
    const blockOf = n => {
      for (let e = n.parentElement; e && e !== doc.body; e = e.parentElement) {
        let b = blocks.get(e);
        if (b === undefined) { b = !/^(inline|contents|ruby)/.test(win.getComputedStyle(e).display); blocks.set(e, b); }
        if (b) return e;
      }
      return doc.body;
    };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: n => {
      const p = n.parentElement;
      return !p || p.closest('script, style, noscript, template, svg, canvas, textarea, #__jd_marks') || !visible(p)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    let cur = null, block = null;
    const flush = () => {
      if (cur) { cur.key = keyOf(cur.raw); if (cur.key) words.push(cur); cur = null; }
    };
    for (let n; (n = walker.nextNode());) {
      const b = blockOf(n);
      if (b !== block) { flush(); block = b; }
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) { flush(); continue; }
        if (!cur) cur = { raw: '', n1: n, i1: i, blk: b };
        cur.raw += v[i];
        cur.n2 = n;
        cur.i2 = i + 1;
      }
    }
    flush();
    return words;
  }

  // the words of a text that the server kept
  const wordsOfText = text => text.split(/\s+/).filter(Boolean).map(raw => ({ raw, key: keyOf(raw) })).filter(w => w.key);

  // waits until the text of a page that scripts draw does not change any more
  async function settled(doc, ms = 6000) {
    const sig = () => wordsOf(doc).map(w => w.key).join(' ');
    let last = sig();
    for (let t = 0; t < ms; t += 300) {
      await sleep(300);
      const now = sig();
      if (now === last) return;
      last = now;
    }
  }

  // The stretches of two lists that are not the same, as [a0, a1, b0, b1]. Words that stand once in
  // both are matched first, in the longest order that both have; then the same is done between them,
  // and a short stretch is compared word by word. (The same as in index.html.)
  function diffWords(a, b) {
    const out = [];
    const small = (a0, a1, b0, b1) => {
      const n = a1 - a0, m = b1 - b0, w = m + 1, t = new Uint16Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
        t[i * w + j] = a[a0 + i] === b[b0 + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      let i = 0, j = 0, i0 = 0, j0 = 0;
      while (i < n && j < m) {
        if (a[a0 + i] === b[b0 + j]) { if (i > i0 || j > j0) out.push([a0 + i0, a0 + i, b0 + j0, b0 + j]); i0 = ++i; j0 = ++j; }
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++; else j++;
      }
      if (i0 < n || j0 < m) out.push([a0 + i0, a1, b0 + j0, b1]);
    };
    const walk = (a0, a1, b0, b1) => {
      while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { a0++; b0++; }
      while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; }
      if (a0 === a1 && b0 === b1) return;
      if (a0 === a1 || b0 === b1) { out.push([a0, a1, b0, b1]); return; }
      const inA = new Map(), inB = new Map();
      for (let i = a0; i < a1; i++) inA.set(a[i], inA.has(a[i]) ? -1 : i);
      for (let j = b0; j < b1; j++) inB.set(b[j], inB.has(b[j]) ? -1 : j);
      // the longest run of such pairs that rises in both lists
      const tails = [], pairs = [];
      for (let i = a0; i < a1; i++) {
        const j = inA.get(a[i]) === i ? inB.get(a[i]) ?? -1 : -1;
        if (j < 0) continue;
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]].j < j) lo = mid + 1; else hi = mid; }
        pairs.push({ i, j, prev: lo ? tails[lo - 1] : -1 });
        tails[lo] = pairs.length - 1;
      }
      if (!tails.length) {
        if ((a1 - a0) * (b1 - b0) <= 4e6) small(a0, a1, b0, b1); else out.push([a0, a1, b0, b1]);
        return;
      }
      const run = [];
      for (let k = tails[tails.length - 1]; k >= 0; k = pairs[k].prev) run.push(pairs[k]);
      let i = a0, j = b0;
      for (const m of run.reverse()) { walk(i, m.i, j, m.j); i = m.i + 1; j = m.j + 1; }
      walk(i, a1, j, b1);
    };
    walk(0, a.length, 0, b.length);
    return out;
  }

  // The changes between two word lists, each with the words as they were (was) and as they are (now),
  // and a few words around it (pre, post) so that it reads as a sentence. A word or two that stayed
  // between two changes make one change.
  function compareWords(a, b) {
    const ids = new Map(), id = w => { if (!ids.has(w.key)) ids.set(w.key, ids.size); return ids.get(w.key); };
    const marks = [];
    for (const [a0, a1, b0, b1] of diffWords(a.map(id), b.map(id))) {
      const last = marks[marks.length - 1];
      if (last && a0 - last.a1 === b0 - last.b1 && b0 - last.b1 <= 2) { last.a1 = a1; last.b1 = b1; }
      else marks.push({ a0, a1, b0, b1 });
    }
    const text = (ws, i0, i1) => ws.slice(Math.max(0, i0), Math.max(0, i1)).map(w => w.raw).join(' ');
    for (const m of marks) {
      m.was = text(a, m.a0, m.a1);
      m.now = text(b, m.b0, m.b1);
      m.pre = text(b, m.b0 - 6, m.b0);
      m.post = text(b, m.b1, m.b1 + 6);
      m.sig = m.was + '→' + m.now;
    }
    return marks;
  }

  // what a change is remembered by once it was seen: its text and the words before it
  const seenKey = m => m.sig + '@' + m.pre;

  // A change in the page: ranges over its new words, one for each block. Text that was removed has
  // none, but the place where it stood (cutAt: a node, an offset and 0 before / 1 after that character).
  function placeMarks(doc, b, marks) {
    for (const m of marks) {
      m.ranges = [];
      for (let i = m.b0; i < m.b1; ) {
        let k = i;
        while (k + 1 < m.b1 && b[k + 1].blk === b[i].blk) k++;
        const r = doc.createRange();
        r.setStart(b[i].n1, b[i].i1);
        r.setEnd(b[k].n2, b[k].i2);
        m.ranges.push(r);
        i = k + 1;
      }
      if (!m.ranges.length) {
        const end = m.b0 >= b.length, w = b[end ? b.length - 1 : m.b0];
        m.cut = true;
        m.cutAt = w ? (end ? [w.n2, w.i2 - 1, 1] : [w.n1, w.i1, 0]) : null;
      }
    }
    return marks.filter(m => m.ranges.length || m.cutAt);
  }

  // the places of a change on the page, in page coordinates; removed text is a thin mark at its place
  function changeRects(st, m) {
    const w = st.f.contentWindow, doc = st.f.contentDocument;
    if (m.cut) {
      if (!m.cutAt || !m.cutAt[0].isConnected) return [];
      const r = doc.createRange();
      r.setStart(m.cutAt[0], m.cutAt[1]);
      r.setEnd(m.cutAt[0], m.cutAt[1] + 1);
      const q = r.getClientRects()[0];
      return q ? [{ l: (m.cutAt[2] ? q.right : q.left) - 2 + w.scrollX, t: q.top + w.scrollY, w: 3, h: q.height }] : [];
    }
    return m.ranges.flatMap(r => [...r.getClientRects()]).filter(r => r.width > 0 || r.height > 0)
      .map(r => ({ l: r.left + w.scrollX, t: r.top + w.scrollY, w: r.width, h: r.height }));
  }

  // the words of the version that the marks compare with
  async function oldWords(st, kind) {
    if (kind === 'commit') return commitWords(st);
    const n = st.rounds.length;
    if (!n) throw new Error('nothing was handed over yet (Ctrl+Enter)');
    return roundWords(st, n);
  }

  async function roundWords(st, n) {
    st.texts = st.texts || {};
    if (!(n in st.texts)) {
      const r = await fetch(api(st.t, 'api/was') + '&n=' + n);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'the version of this round is not kept');
      st.texts[n] = (await r.json()).text;
    }
    return wordsOfText(st.texts[n]);
  }

  // The folder of the page as an address: an earlier version of the page is served there, so that its
  // relative files and /_lib/ work.
  const folder = st => new URL('.', st.f.contentWindow.location.href).href;

  // The page as it was at the last commit: loaded out of sight, as the page is, and read when it has
  // stopped changing.
  async function commitWords(st) {
    const url = folder(st) + '.jd-commit.html', r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'the version of the last commit is not known');
    const f = document.createElement('iframe'), live = st.f.getBoundingClientRect();
    f.style.cssText = `position:absolute;left:-20000px;top:0;border:0;width:${live.width}px;height:${live.height}px`;
    try {
      await new Promise(res => { f.onload = res; f.src = url; document.body.appendChild(f); });
      await settled(f.contentDocument);
      return wordsOf(f.contentDocument);
    } finally { f.remove(); }
  }

  // m and M: mark what is not as it was at the last Ctrl+Enter / at the last commit; again hides the
  // marks, unless fresh asks for them to be made again
  async function showChanges(st, kind, fresh = false) {
    if (st.comparing) return;
    if (!fresh && st.changes && st.changes.kind === kind) kind = '';
    await showOld(st, null);
    st.changes = null;
    st.item = null;
    st.chgKind = kind;
    sset(st, 'changes', kind);
    if (kind) {
      st.comparing = true;
      draw();
      try {
        const doc = st.f.contentDocument, a = await oldWords(st, kind), b = wordsOf(doc);
        const marks = placeMarks(doc, b, compareWords(a, b)), all = sget(st, 'chgseen', {});
        // a change that n went to is seen; what the list holds of older rounds is dropped
        const seen = (all[kind] || []).filter(g => marks.some(m => seenKey(m) === g));
        sset(st, 'chgseen', { ...all, [kind]: seen });
        st.changes = { kind, marks, seen, b };
      } catch (err) {
        st.chgKind = '';
        sset(st, 'changes', '');
        toast(err.message, true);
      }
      st.comparing = false;
    }
    showNews(st);
    draw();
  }

  // the line of the key bar about the marks
  function changeInfo(st) {
    const c = st.changes;
    let t = st.comparing ? 'comparing …' : '';
    if (c) {
      const n = c.marks.length, own = c.marks.filter(m => !owner(st, m)).length;
      t = !n ? `no changes since ${SINCE[c.kind]}` : `${n} change${n > 1 ? 's' : ''} since ${SINCE[c.kind]}` + (own ? ` · ${own} not asked for` : '');
    }
    return st.oldShown ? `${st.oldShown.label} · gb: as it is now` + (t ? ' · ' + t : '') : t;
  }

  // where a comment stands in the words of the page: [lo, hi), the words it covers; an element
  // without words (a plot) stands where the text after it begins
  const spans = new WeakMap();
  function wordSpan(st, a) {
    const c = st.changes, loc = st.where?.[a.id];
    if (!c || !loc) return null;
    const hit = spans.get(loc);
    if (hit && hit.c === c) return hit.span;
    let lo = -1, hi = -1, after = -1;
    for (let i = 0; i < c.b.length; i++) {
      const w = c.b[i];
      let inside = false;
      try {
        inside = loc.range ? loc.range.comparePoint(w.n2, w.i2 - 1) >= 0 && loc.range.comparePoint(w.n1, w.i1) <= 0 : loc.el.contains(w.n1);
        if (!inside && after < 0 && loc.el && loc.el.compareDocumentPosition(w.n1) & Node.DOCUMENT_POSITION_FOLLOWING) after = i;
      } catch {}
      if (inside) { if (lo < 0) lo = i; hi = i + 1; }
    }
    const span = lo >= 0 ? { lo, hi } : { lo: after < 0 ? c.b.length : after, hi: after < 0 ? c.b.length : after };
    spans.set(loc, { c, span });
    return span;
  }

  // a change is near a comment when no more than this many words are between them
  const NEAR = 20;

  // The comment that a change belongs to: the nearest comment that is in the list, within a few
  // words of it. A comment on a change does not count. A change without one was not asked for.
  function owner(st, m) {
    let best = null, dist = Infinity;
    for (const a of st.annots) {
      if (a.change !== undefined || (a.done && st.filed.includes(a.id))) continue;
      const s = wordSpan(st, a);
      if (!s) continue;
      const d = Math.max(0, s.lo - m.b1, m.b0 - s.hi);
      if (d <= NEAR && d < dist) { best = a; dist = d; }
    }
    return best;
  }

  // a comment the other side answered in this round, with a reply or a done mark, or one with news not read yet
  const answered = (st, a) => isNew(st, a) || (a.replies || []).some(r => r.from && Date.parse(r.at) > roundStart(st))
                              || Date.parse(a.done_at) > roundStart(st);

  // What there is to look at after a round: each answered comment, together with the changes near
  // it, and the other changes, a stretch of text at a time.
  function reviewItems(st) {
    const items = [], mine = new Map();
    let block = null;
    for (const m of st.changes?.marks || []) {
      const a = owner(st, m);
      if (a && answered(st, a)) { mine.set(a, [...(mine.get(a) || []), m]); continue; }
      // changes with less than about three lines of text between them are one stretch
      const end = block?.marks.at(-1);
      if (end && m.b0 - end.b1 < 40) { block.marks.push(m); continue; }
      // an open comment near it; one that is done belongs to an earlier round
      block = { key: 'm' + m.b0, marks: [m], near: a && !a.done ? a : null };
      items.push(block);
    }
    for (const a of st.annots) if (answered(st, a)) items.push({ key: 'c' + a.id, a, marks: mine.get(a) || [] });
    return items;
  }
  const itemSeen = (st, it) => !(it.a && isNew(st, it.a)) && it.marks.every(m => st.changes.seen.includes(seenKey(m)));

  // What n and p go through: the comments as the list shows them, each with the changes near it
  // when it was answered, then the changes on their own. What was done before this round is skipped,
  // unless D shows it.
  function navItems(st) {
    const review = st.changes ? reviewItems(st) : [], marks = new Map(review.filter(it => it.a).map(it => [it.a.id, it.marks]));
    const shown = listOrder(st).filter(a => groupOf(st, a) !== 4 || st.archive || a.id === st.sel);
    return [...shown.map(a => ({ key: 'c' + a.id, a, marks: marks.get(a.id) || [] })), ...review.filter(it => !it.a)];
  }

  // what the card and the marks are about: the selected comment with the changes near it, or the change n went to
  function subject(st) {
    const a = st.annots.find(x => x.id === st.sel);
    if (a) return { a, marks: st.changes ? reviewItems(st).find(it => it.a?.id === a.id)?.marks || [] : [], it: null };
    return st.item ? { a: null, marks: st.item.marks, it: st.item } : null;
  }

  // a change as a sentence: the old words struck out and the new ones in green
  function changeLine(doc, m, div) {
    const add = (tag, text, cls) => div.append(el(doc, tag, text, cls));
    if (m.pre) { add('span', '… ' + m.pre + ' ', 'ctx'); }
    if (m.was) { add('del', m.was); div.append(' '); }
    if (m.now) { add('ins', m.now); div.append(' '); }
    if (m.post) add('span', m.post + ' …', 'ctx');
    return div;
  }

  // ---- drawing ----

  // the marks, the dots and the card are in one layer on the page, outside its layout
  const LAYER_CSS = `
    #__jd_hl, #__jd_dots, #__jd_card { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; }
    #__jd_card { z-index: 2147483647; }
    #__jd_hl { mix-blend-mode: multiply; }
    #__jd_hl .m { position: absolute; border-radius: 2px; box-sizing: border-box; }
    #__jd_hl .t { background: #ffe45c; }
    #__jd_hl .t.c { background: #ffb347; }
    #__jd_hl .e { background: rgba(255, 179, 71, .16); border: 2px solid #f08000; border-radius: 3px; }
    #__jd_hl .on { outline: 3px solid #d00000; outline-offset: 1px; }
    #__jd_hl.has-sel .m:not(.on):not(.chg), #__jd_dots.has-sel .dot:not(.on) { opacity: .3; }
    /* a change has no fill, only a blue line under it: a fill is a comment of yours */
    #__jd_hl .chg { background: linear-gradient(transparent calc(100% - 2px), #2f7bff calc(100% - 2px)); border-radius: 0; }
    #__jd_hl .chg.cut { background: #d00000; }
    /* a wavy line: a change that no comment is near, so nobody asked for it */
    #__jd_hl .chg.own { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 3.5 Q2 0.5 4 3.5 T8 3.5' fill='none' stroke='%232f7bff' stroke-width='1.6'/%3E%3C/svg%3E") repeat-x left bottom / 8px 5px; }
    #__jd_hl .chg.own.cut { background: #d00000; outline: 2px dashed #2f7bff; outline-offset: 1px; }
    #__jd_hl .chg.seen { opacity: .35; }
    #__jd_hl .chg.cur { opacity: 1; }
    #__jd_hl .done:not(.on) { opacity: .3; }
    #__jd_hl.dark { mix-blend-mode: normal; }
    #__jd_hl.dark .t { background: rgba(255, 228, 92, .38); }
    #__jd_hl.dark .t.c { background: rgba(255, 179, 71, .5); }
    #__jd_dots .dot { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #f08000; border: 2px solid #fff;
                      box-shadow: 0 0 3px #000; box-sizing: border-box; }
    #__jd_dots .dot.on { background: #d00000; }
    #__jd_card .link { position: absolute; background: #2f7bff; border-radius: 2px; pointer-events: none; }
    #__jd_card .card, #__jd_card .card * { all: revert; box-sizing: border-box; }
    #__jd_card .card { position: absolute; display: block; pointer-events: auto; width: max-content; max-width: 460px;
        max-height: 70vh; overflow-y: auto; padding: 6px 9px; background: #fff; color: #222; border: 2px solid #2f7bff;
        border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.35); font: 14px/1.45 system-ui, sans-serif; text-align: left; }
    #__jd_card .card.editing { width: 440px; }
    #__jd_card .card div, #__jd_card .card span, #__jd_card .card b { font: inherit; color: inherit; }
    #__jd_card .card div { display: block; }
    #__jd_card .card b { font-weight: 600; }
    #__jd_card .card .h { font-size: 12px; color: #666; margin-bottom: 3px; }
    #__jd_card .card .h b { color: #fff; background: #2f7bff; border-radius: 8px; padding: 0 7px; margin-right: 6px; }
    #__jd_card .card .t { font-size: 15px; font-weight: 700; color: #0050d0; white-space: nowrap; }
    #__jd_card .card .h .n { float: right; margin-left: 12px; }
    #__jd_card .card .h .st { font-size: 12px; margin-left: 8px; vertical-align: 2px; flex: none; padding: 0 6px; border-radius: 8px;
                              font-weight: 700; background: #c9f2c9; color: #14601f; white-space: nowrap; }
    #__jd_card .card.own { border-style: dashed; }
    #__jd_card .card del { color: #c00000; background: #ffe3e3; text-decoration: line-through; text-decoration-thickness: 2px; }
    #__jd_card .card ins { color: #0b5d1e; background: #d4f5d4; text-decoration: none; font-weight: 600; }
    #__jd_card .card .ctx { color: #888; }
    #__jd_card .card .chl { margin-top: 4px; }
    #__jd_card .card .yours { color: #777; font-size: 12px; }
    #__jd_card .card .yours b, #__jd_card .card .rep.mine b { color: #777; font-weight: 600; }
    #__jd_card .card .rep { margin: 3px 0 0 4px; padding-left: 6px; border-left: 3px solid #0050d0; white-space: pre-wrap; }
    #__jd_card .card .rep b { color: #0050d0; }
    #__jd_card .card .rep.mine { border-left-color: #bbb; color: #666; font-size: 12px; }
    #__jd_card .card .none { margin-top: 4px; color: #999; font-size: 12px; }
    #__jd_card .card .k { margin-top: 4px; font-size: 11px; color: #777; }
    #__jd_card .card kbd { background: #eee; border: 1px solid #ccc; border-radius: 3px; padding: 0 4px; font: inherit; color: #222; }
    #__jd_card .card .editor { margin-top: 6px; padding-top: 6px; border-top: 1px solid #eee; }
    #__jd_card .card textarea { display: block; width: 100%; height: 70px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px;
        outline: 0; resize: vertical; font: 14px/1.4 system-ui, sans-serif; background: #fff; color: #222; }
    #__jd_card .card textarea:focus { border-color: #2f7bff; }
    #__jd_card .card small { color: #888; font-size: 11px; }`;

  function layerOf(st) {
    const doc = st.f.contentDocument;
    let layer = doc.getElementById('__jd_marks');
    if (!layer) {
      layer = doc.createElement('div');
      layer.id = '__jd_marks';
      // no z-index here: the marks blend with the page (multiply) only when they are in its stacking context
      layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none';
      layer.innerHTML = `<style>${LAYER_CSS}</style><div id="__jd_hl"></div><div id="__jd_dots"></div><div id="__jd_card"></div>`;
      doc.documentElement.appendChild(layer);
    }
    return layer;
  }

  // whether the page has a dark background: the marks are not multiplied there
  function isDark(doc) {
    for (const e of [doc.body, doc.documentElement]) {
      if (!e || !doc.defaultView) continue;
      const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(doc.defaultView.getComputedStyle(e).backgroundColor);
      if (m && (m[4] === undefined || +m[4] > 0.5)) return 0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3] < 110;
    }
    return false;
  }

  // the <jd-scene> of a comment that is pinned to a point of its model, and the text for that point
  const sceneOf = (st, a) => { const el = a.anchor?.scene && st.where?.[a.id]?.el; return el && typeof el.setMarks === 'function' ? el : null; };
  const pinned = (st, a) => { const sc = sceneOf(st, a); return sc && sc.markRect(a.id) ? sc : null; };
  const num = v => Number(Number(v).toPrecision(4));
  const sceneText = s => `part: ${s.part || '?'} · at (${(s.point || []).map(num).join(', ')})${s.units ? ' ' + s.units : ''}`;

  // the markers of the comments go to the 3D views, which draw them
  function sceneMarks(st) {
    const by = new Map();
    for (const sc of st.f.contentDocument.querySelectorAll('jd-scene')) if (typeof sc.setMarks === 'function') by.set(sc, []);
    for (const a of marked(st)) {
      const sc = sceneOf(st, a);
      if (sc && by.has(sc)) by.get(sc).push({ id: a.id, n: a.n ?? '+', state: standing(st, a)[0], selected: a.id === st.sel,
                                              point: a.anchor.scene.point, normal: a.anchor.scene.normal });
    }
    for (const [sc, list] of by) sc.setMarks(list);
  }

  // the places of a comment on the page, in page coordinates
  function rectsOf(st, a) {
    const loc = st.where?.[a.id], w = st.f.contentWindow;
    if (!loc) return [];
    // a point of a 3D view: the marker, where it is on the screen
    const m = pinned(st, a)?.markRect(a.id);
    if (m) return [{ l: m.left + w.scrollX, t: m.top + w.scrollY, w: m.width, h: m.height }];
    return [...(loc.range ? loc.range.getClientRects() : [loc.el.getBoundingClientRect()])]
      .filter(r => r.width > 0 || r.height > 0).map(r => ({ l: r.left + w.scrollX, t: r.top + w.scrollY, w: r.width, h: r.height }));
  }

  // the comments that are marked on the page: a done one leaves the page with the list; C hides all but the selected
  const marked = st => st.annots.filter(a => a.id === st.sel || (!st.noHl && (!a.done || listedNow(st, a))));

  function marks(st) {
    const doc = st.f.contentDocument;
    if (!doc?.documentElement) return;
    const layer = layerOf(st), hl = layer.querySelector('#__jd_hl'), dots = layer.querySelector('#__jd_dots');
    let html = '', dot = '';
    sceneMarks(st);
    for (const a of marked(st)) {
      if (pinned(st, a)) continue;   // its marker is in the 3D view
      const rects = rectsOf(st, a);
      if (!rects.length) continue;
      const loc = st.where[a.id], on = a.id === st.sel;
      const cls = (loc.range ? 't ' : 'e ') + (a.comment ? 'c ' : '') + (a.done ? 'done ' : '') + (on ? 'on' : '');
      rects.forEach((r, i) => {
        // an element is outlined just outside its own edge
        const g = loc.range ? r : { l: r.l - 2, t: r.t - 2, w: r.w + 4, h: r.h + 4 };
        html += `<div class="m ${cls}"${i ? '' : ` data-id="${esc(a.id)}"`} style="left:${g.l}px;top:${g.t}px;width:${g.w}px;height:${g.h}px"></div>`;
      });
      const at = a.anchor?.at;
      if (loc.el && at) dot += `<div class="dot${on ? ' on' : ''}" style="left:${rects[0].l + at[0] * rects[0].w - 6}px;top:${rects[0].t + at[1] * rects[0].h - 6}px"></div>`;
    }
    // the changes: a line under the new words; the ones n went to are not faded
    const cur = new Set(subject(st)?.marks || []);
    for (const m of st.changes?.marks || []) {
      const cls = 'chg ' + (m.cut ? 'cut ' : '') + (owner(st, m) ? '' : 'own ') + (st.changes.seen.includes(seenKey(m)) ? 'seen ' : '') + (cur.has(m) ? 'cur' : '');
      for (const r of changeRects(st, m)) html += `<div class="m ${cls}" style="left:${r.l}px;top:${r.t}px;width:${r.w}px;height:${r.h}px"></div>`;
    }
    const has = !!st.annots.some(a => a.id === st.sel), dark = isDark(doc);
    hl.classList.toggle('has-sel', has);
    dots.classList.toggle('has-sel', has);
    hl.classList.toggle('dark', dark);
    if (hl.dataset.html !== html) { hl.innerHTML = html; hl.dataset.html = html; }
    if (dots.dataset.html !== dot) { dots.innerHTML = dot; dots.dataset.html = dot; }
    card(st);
    placeCard(st);
  }

  // a click on a mark selects its comment: text anywhere in it, an element at its edge or at its dot
  function hit(st, e) {
    const w = st.f.contentWindow, sel = w.getSelection();
    if (e.target.closest?.('#__jd_marks') || (sel && !sel.isCollapsed)) return;
    const x = e.clientX + w.scrollX, y = e.clientY + w.scrollY, near = (r, m) => x >= r.l - m && x <= r.l + r.w + m && y >= r.t - m && y <= r.t + r.h + m;
    let best = null;
    for (const a of marked(st)) {
      const loc = st.where?.[a.id];
      if (!loc || pinned(st, a)) continue;
      for (const r of rectsOf(st, a)) {
        const inside = loc.range ? near(r, 0) : near(r, 3) && !(r.w > 24 && r.h > 24 && near({ l: r.l + 8, t: r.t + 8, w: r.w - 16, h: r.h - 16 }, 0));
        const at = a.anchor?.at, dot = loc.el && at && near({ l: r.l + at[0] * r.w - 6, t: r.t + at[1] * r.h - 6, w: 12, h: 12 }, 0);
        if (!inside && !dot) continue;
        const score = (loc.range ? 0 : 1e9) + r.w * r.h;
        if (!best || score < best.score) best = { a, score };
      }
    }
    if (best) { if (best.a.id !== st.sel) select(st, best.a.id, false); return; }
    // a change: its words, or a point on the mark of removed text
    for (const m of st.changes?.marks || []) {
      if (!changeRects(st, m).some(r => near(r, m.cut ? 3 : 0))) continue;
      const it = navItems(st).find(x => x.marks.includes(m));
      if (it && (it.a ? it.a.id !== st.sel : it.key !== st.item?.key)) goItem(st, it, true);
      return;
    }
  }

  const el = (doc, tag, text, cls) => {
    const e = doc.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };

  // The card: one box for a comment and what belongs to it, beside or under its mark. It shows your
  // comment, the last replies, the changes near it and the keys; the field to write in is at its bottom.
  // The change that n went to without a comment has a card of its own (dashed when nobody asked for it).
  function card(st) {
    const doc = st.f.contentDocument, box = doc.getElementById('__jd_card');
    const sub = st.oldShown ? null : subject(st), a = sub?.a || null, ed = a && st.editing?.id === a.id ? st.editing : null;
    if (!sub) { if (box.firstChild) box.replaceChildren(); delete box.dataset.sig; return; }
    const items = navItems(st), key = a ? 'c' + a.id : sub.it.key, at = items.findIndex(x => x.key === key);
    const [, word] = a ? standing(st, a) : ['', ''];
    // the card is built again only when something in it changed, so the field keeps what is typed
    const sig = JSON.stringify([a, ed && ed.mode, at, items.length, word, a && unseen(a), sub.marks.map(m => m.sig), key, !!st.changes]);
    if (box.dataset.sig === sig && box.firstChild) return;
    box.dataset.sig = sig;
    box.replaceChildren();
    const writing = ed && (ed.mode === 'new' || ed.mode === 'comment');
    const c = el(doc, 'div', '', 'card' + (a ? '' : ' own') + (ed ? ' editing' : '')), h = el(doc, 'div', '', 'h');
    if (a) h.append(el(doc, 'b', '#' + (a.n ?? '…') + ' '));
    if (at >= 0) h.append(el(doc, 'span', `${at + 1} of ${items.length}`, 'n'));
    const r = a && (a.replies || []).filter(x => x.from).at(-1);
    const t = el(doc, 'span', !a ? (sub.marks.length > 1 ? `${sub.marks.length} changes` : 'a change') + (sub.it.near ? ' near your comment' : '')
                 : ed?.mode === 'new' ? 'new comment' : writing ? 'edit your comment' : ed?.mode === 'edit' ? 'edit your reply'
                 : r ? r.from + ' replied' : a.done ? 'no reply' : 'your comment · ' + word, 't');
    if (a?.done && !writing) t.append(el(doc, 'span', 'done ✓', 'st done'));
    h.append(t);
    if (!a && !sub.it.near) h.append(' ', el(doc, 'b', 'not asked for'));
    c.append(h);
    if (a?.anchor?.scene) c.append(el(doc, 'div', sceneText(a.anchor.scene), 'yours'));
    if (a && !writing) {
      const y = el(doc, 'div', '', 'yours');
      y.append(el(doc, 'b', 'you: '), a.comment || '(no comment)');
      c.append(y);
    }
    const rs = a ? a.replies || [] : [];
    if (rs.length > 3) c.append(el(doc, 'div', `… ${rs.length - 3} earlier`, 'none'));
    for (const q of rs.slice(-3)) {
      // the reply in the field is not shown twice
      if (ed?.mode === 'edit' && q === rs.at(-1)) continue;
      const d = el(doc, 'div', '', 'rep' + (q.from ? '' : ' mine'));
      d.append(el(doc, 'b', (q.from || 'you') + ': '), q.text);
      c.append(d);
    }
    // a comment on a change keeps the change in view
    if (a?.change !== undefined) c.append(changeLine(doc, { was: a.change, now: a.text, pre: '', post: '' }, el(doc, 'div', '', 'chl')));
    for (const m of sub.marks.slice(0, 4)) c.append(changeLine(doc, m, el(doc, 'div', '', 'chl')));
    if (sub.marks.length > 4) c.append(el(doc, 'div', `… and ${sub.marks.length - 4} more changes here`, 'none'));
    if (a && st.changes && !sub.marks.length && answered(st, a)) c.append(el(doc, 'div', 'no change near it', 'none'));
    if (ed) {
      const e = el(doc, 'div', '', 'editor'), ta = doc.createElement('textarea');
      ta.id = 'ed';
      ta.placeholder = ed.mode === 'reply' ? 'reply …' : 'comment …';
      ta.value = ed.text || '';
      ta.oninput = () => ed.text = ta.value;
      ta.onkeydown = ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey) { ev.preventDefault(); commit(st, ta.value); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(st); }
      };
      e.append(ta, el(doc, 'small', 'Enter saves · Shift+Enter new line · Esc cancels'));
      c.append(e);
      // a click on the card leaves the field open
      c.addEventListener('mousedown', ev => { if (ev.target !== ta) ev.preventDefault(); });
      box.append(c);
      st.f.contentWindow.focus();
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }
    const k = el(doc, 'div', '', 'k');
    k.innerHTML = (a ? `<kbd>a</kbd> ${unseen(a) ? 'edit' : 'reply'} &nbsp;<kbd>x</kbd> ${a.done ? 'open again' : 'done'} &nbsp;`
                     : `<kbd>a</kbd> comment on ${sub.marks.length > 1 ? 'the first' : 'it'} &nbsp;`)
      + '<kbd>n</kbd> next &nbsp;<kbd>p</kbd> back &nbsp;' + (st.changes ? '<kbd>gb</kbd> page as it was &nbsp;' : '') + '<kbd>Esc</kbd> close';
    c.append(k);
    box.append(c);
  }

  // beside its mark when there is room, else under it; scrolls with the page
  function placeCard(st) {
    const doc = st.f.contentDocument, w = st.f.contentWindow, box = doc.getElementById('__jd_card'), c = box?.querySelector('.card');
    for (const l of box?.querySelectorAll('.link') || []) l.remove();
    if (!c) return;
    const sub = subject(st), a = sub?.a;
    const rects = !sub ? [] : a ? rectsOf(st, a) : sub.marks.flatMap(m => changeRects(st, m));
    const vw = doc.documentElement.clientWidth, vh = w.innerHeight, gap = 10, cw = c.offsetWidth, ch = c.offsetHeight;
    c.style.maxWidth = Math.min(460, vw - 16) + 'px';
    if (!rects.length) {
      // a comment that is not on the page: the card stands in the corner
      c.style.left = w.scrollX + Math.max(8, vw - cw - 16) + 'px';
      c.style.top = w.scrollY + 10 + 'px';
      return;
    }
    // beside the text it belongs to, not beside the words: the card would cover the rest of the line
    const range = a ? st.where[a.id]?.range : sub.marks[0]?.ranges?.[0];
    let block = range ? elementOf(range.commonAncestorContainer) : null;
    while (block?.parentElement && /^inline|^contents/.test(w.getComputedStyle(block).display)) block = block.parentElement;
    const left = Math.min(...rects.map(r => r.l)), right = Math.max(...rects.map(r => r.l + r.w), block ? block.getBoundingClientRect().right + w.scrollX : 0);
    const top = Math.min(...rects.map(r => r.t)), low = Math.max(...rects.map(r => r.t + r.h));
    let x, y;
    if (right + gap + cw <= w.scrollX + vw - 4) {
      x = right + gap;
      y = top - 12;
      const link = css => { const d = el(doc, 'div', '', 'link'); d.style.cssText = css; box.append(d); };
      link(`left:${right + 3}px;top:${top - 3}px;width:3px;height:${low - top + 6}px`);
      link(`left:${right + 3}px;top:${top - 3}px;width:${gap}px;height:2px`);
    } else {
      x = Math.max(w.scrollX + 4, Math.min(left, w.scrollX + vw - cw - 4));
      y = low + 6;
    }
    // a mark that is partly in view keeps its card in view
    if (low > w.scrollY && top < w.scrollY + vh) y = Math.max(w.scrollY + 8, Math.min(y, w.scrollY + vh - ch - 8));
    c.style.left = x + 'px';
    c.style.top = y + 'px';
  }

  function visible(st) {
    return !!st && (panel === true || (panel === null && (st.annots.length > 0 || !!st.editing)) || (panel === false && !!st.editing));
  }

  // the key bar and the panel
  side.innerHTML = '<h1>Comments (<span id="count">0</span>) <small id="archive"></small></h1><div id="list"></div>';

  function span(tag, text, cls) {
    const e = document.createElement(tag);
    e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function drawList(st) {
    const shown = listOrder(st), hidden = st.annots.length - shown.length;
    side.querySelector('#count').textContent = st.annots.filter(a => !a.done).length;
    side.querySelector('#archive').textContent = st.archive ? '· with the done ones · D hides them' : hidden ? `· ${hidden} done · D shows them` : '';
    const list = side.querySelector('#list');
    list.replaceChildren();
    if (!shown.length && !st.changes) list.append(span('p', 'No comments. Select text or point at an element and press a.', 'none'));
    for (const a of shown) {
      const it = document.createElement('div');
      it.className = 'it' + (a.id === st.sel ? ' on' : '') + (a.done ? ' done' : '') + (groupOf(st, a) === 4 ? ' old' : '')
        + (unfolded(st, a) ? ' open' : '') + (isNew(st, a) ? ' new' : '');
      it.dataset.id = a.id;
      // a closed row is two lines: where the comment stands, its place and text; and who spoke last
      const [key, word] = standing(st, a), quote = (a.text || '').replace(/\s+/g, ' '), tag = a.anchor?.scene ? sceneText(a.anchor.scene) : '‹' + (a.anchor?.tag || 'element') + '›';
      const where = (a.anchor?.id ? '#' + a.anchor.id : a.anchor?.src || a.anchor?.tag || '') + (a.anchor?.src && a.anchor?.id ? ' · ' + a.anchor.src : '');
      const l1 = document.createElement('div'); l1.className = 'l1';
      l1.append(span('span', word, 'st ' + key), span('b', '#' + (a.n ?? '…')), span('span', where + (a.detached ? ' · not found on the page' : ''), 'wh'));
      l1.append(span('span', quote ? '«' + quote + '»' : a.change ? '(removed) «' + a.change + '»' : tag, 'qq'));
      const r = (a.replies || []).at(-1), l2 = document.createElement('div');
      l2.className = 'l2' + (r?.from ? '' : ' me');
      l2.append(span('b', (r?.from || 'you') + ': '), r ? r.text : a.comment || '(no comment)');
      const q = span('div', (a.kind === 'element' ? '▭ ' : '') + (quote ? '«' + quote + '»' : tag), 'q');
      if (a.change !== undefined) {
        // a comment on a change shows the change: the text as it was, and what stands there now
        const was = document.createElement('s'), now = document.createElement('u');
        was.textContent = a.change ? '«' + a.change + '»' : '(new)';
        now.textContent = a.text ? '«' + a.text + '»' : '(deleted)';
        q.replaceChildren(was, ' → ', now);
      }
      const c = span('div', a.comment || '(no comment)', 'c' + (a.comment ? '' : ' none'));
      it.append(l1, l2, q, c);
      for (const x of a.replies || []) {
        const d = document.createElement('div'); d.className = 'r' + (x.from ? '' : ' mine');
        if (x.from) d.append(span('b', x.from + ' '));
        d.append(x.text);
        it.append(d);
      }
      it.addEventListener('dblclick', () => { select(st, a.id, true); reply(st, a); });
      list.append(it);
    }
    drawChangeRows(st, list);
    list.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
  }

  function draw() {
    const st = S[active];
    // the key bar shows while a live page is shown; the page and the panel end above it
    const foot = document.getElementById('foot');
    document.body.classList.toggle('livefoot', !!tabs.find(t => t.id === active)?.live);
    document.body.style.setProperty('--foot', (foot.offsetHeight || 22) + 'px');
    for (const id in S) {
      const on = id === active && visible(S[id]);
      S[id].f.style.width = on ? 'calc(100% - var(--left) - 340px)' : '';
      if (S[id].old) { S[id].old.style.width = S[id].f.style.width; S[id].old.style.display = id === active ? '' : 'none'; }
      marks(S[id]);
    }
    document.getElementById('fchg').textContent = st ? changeInfo(st) : '';
    document.body.classList.toggle('oldview', !!st?.oldShown);
    if (histEl.classList.contains('open') && histEl.dataset.id !== active) histEl.classList.remove('open');
    side.style.display = st && visible(st) ? 'flex' : 'none';
    if (st && visible(st)) drawList(st);
  }

  side.addEventListener('click', e => {
    const it = e.target.closest('.it');
    const st = S[active];
    if (it && st) select(st, it.dataset.id, true);
  });

  // ---- the rows of the changes in the list ----

  // Below the comments, the changes that n goes to on their own, closed to one line: the header and
  // the row that n is on. za on a change, zR and zM, or a click open and close it.
  function drawChangeRows(st, list) {
    const items = st.changes ? reviewItems(st).filter(it => !it.a) : [];
    if (!items.length) return;
    const left = items.filter(it => !itemSeen(st, it)).length;
    const h = span('div', `${st.chgOpen ? '▾' : '▸'} ${items.length} change${items.length > 1 ? 's' : ''} without a comment`
                          + (left ? ` · ${left} to look at` : ' · all looked at'), 'grp chgs');
    h.addEventListener('click', () => { st.chgOpen = !st.chgOpen; draw(); });
    list.append(h);
    for (const it of items) {
      const on = it.key === st.item?.key;
      if (!st.chgOpen && !on) continue;
      const m = it.marks[0], row = document.createElement('div');
      row.className = 'it chg' + (on ? ' on' : '') + (itemSeen(st, it) ? ' seen' : '');
      const l1 = document.createElement('div'); l1.className = 'l1';
      l1.append(span('span', 'change', 'st chg'), span('span', m.now ? '«' + m.now + '»' : '(removed) «' + m.was + '»', 'qq'));
      const l2 = span('div', (it.marks.length > 1 ? `${it.marks.length} changes` : 'one change')
                             + (it.near ? ' · near your comment' : ' · not asked for'), 'l2 me');
      row.append(l1, l2);
      row.addEventListener('click', () => goItem(st, it));
      list.append(row);
    }
  }

  // ---- the page as it was (gb) and the history of the rounds (gh) ----

  // gb: the page as it was in the version that the marks compare with, in place of the page, read
  // only; again: as it is now. spec: { url, label, endOf } of the version, or null for the page.
  async function showOld(st, spec) {
    st.old?.remove();
    st.old = null;
    const was = st.oldShown;
    st.oldShown = null;
    if (!spec) { if (was) { st.f.contentWindow.focus(); draw(); } return; }
    try {
      const r = await fetch(spec.url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'this version is not kept');
    } catch (err) { toast(err.message, true); draw(); return; }
    const f = document.createElement('iframe'), live = st.f.contentWindow;
    f.className = 'on ol';
    f.onload = () => {
      const w = f.contentWindow;
      w.scrollTo(live.scrollX, live.scrollY);
      w.addEventListener('submit', e => e.preventDefault(), true);
      w.addEventListener('keydown', e => { if (key(e, st.t.id)) { e.preventDefault(); e.stopPropagation(); } }, true);
      w.focus();
    };
    f.src = spec.url;
    document.body.appendChild(f);
    st.old = f;
    st.oldShown = spec;
    draw();
  }

  // gb
  async function toggleOld(st) {
    if (st.oldShown) { await showOld(st, null); return; }
    const n = st.rounds.length, commit = st.changes?.kind === 'commit';
    if (!commit && !n) { toast('nothing was handed over yet (Ctrl+Enter)', true); return; }
    await showOld(st, { url: folder(st) + (commit ? '.jd-commit.html' : `.jd-round${n}.html`),
                        label: 'the page as it was at ' + (commit ? SINCE.commit : SINCE.handed) });
  }

  const histEl = document.getElementById('hist'), histList = document.getElementById('histlist');
  // the round whose end the window shows: the last one is now
  const shownRound = st => st.oldShown?.endOf ?? st.rounds.length;

  function toggleHistory(st) {
    if (histEl.classList.toggle('open')) {
      if (!st.rounds.length) { histEl.classList.remove('open'); toast('no rounds yet: Ctrl+Enter hands the comments over and starts one', true); return; }
      histEl.dataset.id = st.t.id;
      st.hist = { at: 0, marks: {} };
      markRound(st, st.rounds.length - shownRound(st));
    }
  }

  // j / k: the round whose details show; its changes are compared when it is first shown
  async function markRound(st, i) {
    const h = st.hist;
    h.at = Math.min(st.rounds.length - 1, Math.max(0, i));
    drawHistory(st);
    const n = st.rounds.length - h.at;
    if (!h.marks[n]) {
      try { await roundChanges(st, n); } catch (err) { h.marks[n] = []; toast(err.message, true); }
      if (st.hist === h && st.rounds.length - h.at === n) drawHistory(st);
    }
  }

  // Enter: show the page as it was at the end of round n in the window (the version of the next
  // Ctrl+Enter); the last round is now
  async function goRound(st, n) {
    histEl.classList.remove('open');
    if (n >= st.rounds.length) { await showOld(st, null); return; }
    await showOld(st, { url: folder(st) + `.jd-round${n + 1}.html`, label: `the page at the end of round ${n}`, endOf: n });
  }

  // the changes made in round n: from the page at its Ctrl+Enter to the one at the next, or to now
  async function roundChanges(st, n) {
    const h = st.hist;
    if (h.marks[n]) return h.marks[n];
    if (st.rounds.length < n) throw new Error('no such round');
    const old = await roundWords(st, n), now = n < st.rounds.length ? await roundWords(st, n + 1) : wordsOf(st.f.contentDocument);
    h.marks[n] = compareWords(old, now);
    return h.marks[n];
  }

  function drawHistory(st) {
    histList.replaceChildren();
    const h = st.hist, doc = document;
    const when = t => new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const quote = a => span('i', '«' + (a.text || a.change || '').replace(/\s+/g, ' ').slice(0, 80) + '»');
    const inside = (x, lo, hi) => { const v = Date.parse(x) / 1000; return v > lo && v <= hi; };
    for (let i = 0; i < st.rounds.length; i++) {
      const n = st.rounds.length - i, t0 = n > 1 ? st.rounds[n - 2] : -Infinity, t = st.rounds[n - 1], t1 = n < st.rounds.length ? st.rounds[n] : Infinity;
      // what you handed over at its Ctrl+Enter, and what came back before the next one
      const asked = st.annots.filter(a => inside(a.created, t0, t));
      const mine = st.annots.flatMap(a => (a.replies || []).filter(r => !r.from && inside(r.at, t0, t)).map(r => [a, r]));
      const back = st.annots.flatMap(a => (a.replies || []).filter(r => r.from && inside(r.at, t, t1)).map(r => [a, r]));
      const e = span('div', '', 'hr' + (i === h.at ? ' on' : ''));
      const hh = span('div', `Round ${n} · ${when(t)}${n === st.rounds.length ? ' · now' : ''}${n === shownRound(st) ? ' · shown' : ''} `, 'hh');
      hh.append(span('small', `${asked.length + mine.length} handed over · ${back.length} answered`));
      hh.addEventListener('click', () => (i === h.at ? goRound(st, n) : markRound(st, i)));
      e.append(hh);
      if (i === h.at) {
        const row = (a, ...parts) => {
          const r = span('div', '', 'hi');
          r.append(quote(a), ' ', ...parts);
          r.addEventListener('click', () => { histEl.classList.remove('open'); select(st, a.id, true); });
          e.append(r);
        };
        if (asked.length + mine.length) e.append(span('div', 'you handed over', 'hs'));
        for (const a of asked) row(a, a.comment || '(no comment)');
        for (const [a, x] of mine) row(a, 'you: ', x.text);
        if (back.length) e.append(span('div', 'answers', 'hs'));
        for (const [a, x] of back) row(a, span('b', x.from), ': ', x.text);
        e.append(span('div', n === st.rounds.length ? 'changes so far' : 'changes in the page', 'hs'));
        const ch = h.marks[n];
        if (!ch) e.append(span('div', 'comparing …', 'hn'));
        else if (!ch.length) e.append(span('div', 'no changes', 'hn'));
        else for (const m of ch) e.append(changeLine(doc, m, span('div', '', 'hi')));
      }
      histList.append(e);
    }
    histList.querySelector('.hr.on')?.scrollIntoView({ block: 'nearest' });
  }

  function histKey(st, e) {
    const k = e.key;
    if (k === 'j' || k === 'ArrowDown') markRound(st, st.hist.at + 1);
    else if (k === 'k' || k === 'ArrowUp') markRound(st, st.hist.at - 1);
    else if (k === 'Enter') goRound(st, st.rounds.length - st.hist.at);
    else if (k === 'Escape' || (k === 'h' && st.hist.g)) histEl.classList.remove('open');
    st.hist.g = k === 'g';
  }

  // ---- actions ----

  function select(st, id, scroll) {
    // what is written in the field of another comment is saved first
    if (st.editing && st.editing.id !== id) commit(st, st.f.contentDocument.getElementById('ed')?.value ?? st.editing.text ?? '');
    if (id !== st.sel) st.selFolded = false;
    st.sel = id;
    st.item = null;
    if (id) markSeen(st, id);
    const loc = st.where?.[id];
    if (scroll && loc) {
      const e = loc.el || elementOf(loc.range.startContainer);
      e.scrollIntoView({ block: 'center', behavior: 'instant' });
      // a point of a 3D view that is out of sight is brought into view; one that is seen stays where it is
      const a = st.annots.find(x => x.id === id), sc = a && sceneOf(st, a);
      if (sc) { sceneMarks(st); sc.reveal(id); }
    }
    draw();
  }

  // a: a new comment on the selected text or on the element under the mouse (or the element with an
  // id around it); on a selected comment edit
  // what you wrote last while the assistant has not seen it, else reply
  function add(st) {
    const w = st.f.contentWindow, doc = st.f.contentDocument, sel = w.getSelection();
    if (st.oldShown) { toast('the old page is read only · gb goes back', true); return; }
    if (sel && !sel.isCollapsed && norm(sel.toString())) {
      const r = sel.getRangeAt(0), quote = norm(sel.toString()).slice(0, 500);
      newComment(st, 'text', quote, textAnchor(doc, r, quote));
      sel.removeAllRanges();
      return;
    }
    if (st.item && !st.sel) { addFromChange(st); return; }
    const a = st.annots.find(x => x.id === st.sel);
    if (a) { reply(st, a); return; }
    const p = st.pointer;
    let e = p && doc.elementFromPoint(p.x, p.y);
    if (e?.closest('#__jd_marks')) e = null;
    // the model of a 3D view: the point of its surface under the mouse
    const sc = e?.closest('jd-scene');
    if (sc && typeof sc.pick === 'function' && e.localName === 'canvas') {
      const at = sc.pick(p.x, p.y);
      if (at) { const anchor = anchorOf(doc, sc, '', '', ''); anchor.scene = at; newComment(st, 'element', '', anchor); return; }
    }
    // the element with an id (or data-src) around it: a section, a figure, a plot, which stays when its inside is drawn again
    const k = e && keyed(e);
    if (k && k !== doc.body && k !== doc.documentElement) e = k;
    if (!e || e === doc.body || e === doc.documentElement) { toast('Select text or point at an element with the mouse, then press a', true); return; }
    const rect = e.getBoundingClientRect();
    // the text of a plot or a drawing is tick labels and the like, no help for finding it again
    const quote = e.querySelector('svg, canvas') || /^(svg|canvas)$/.test(e.localName) ? '' : norm(e.textContent).slice(0, 120);
    const anchor = anchorOf(doc, e, quote, '', '');
    if (rect.width > 0 && rect.height > 0) anchor.at = [(p.x - rect.left) / rect.width, (p.y - rect.top) / rect.height].map(v => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000);
    newComment(st, 'element', quote, anchor);
  }

  // the anchor of a comment on the text of the range r, whose normalised text is quote
  function textAnchor(doc, r, quote) {
    const h = findText(doc.body, quote).find(h => r.intersectsNode(h.map[h.at][0])) || findText(doc.body, quote)[0];
    const prefix = h ? h.str.slice(Math.max(0, h.at - 32), h.at) : '', suffix = h ? h.str.slice(h.end, h.end + 32) : '';
    return anchorOf(doc, elementOf(r.commonAncestorContainer), quote, prefix, suffix);
  }

  // a on a change that n went to: a comment on the change; it keeps the text as it was, for the author
  // of the change. Removed text has nothing to point at: the comment is on the element around the place.
  function addFromChange(st) {
    const m = st.item.marks[0], doc = st.f.contentDocument;
    if (m.cut) {
      const e = m.cutAt && elementOf(m.cutAt[0]);
      if (!e) { toast('the place of the removed text is not on the page', true); return; }
      newComment(st, 'element', '', anchorOf(doc, e, '', '', ''), { change: m.was });
    } else {
      // the first block of the change; the whole change is in the card
      const r = m.ranges[0], quote = norm(r.toString()).slice(0, 500);
      newComment(st, 'text', quote, textAnchor(doc, r, quote), { change: m.was });
    }
  }

  function newComment(st, kind, text, anchor, extra = {}) {
    const a = { id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, text, comment: '',
                created: now(), anchor, replies: [], ...extra };
    st.annots.push(a);
    st.where = st.where || {};
    st.where[a.id] = locate(st.f.contentDocument, a);
    st.sel = a.id;
    st.item = null;
    st.selFolded = false;
    st.editing = { id: a.id, mode: 'new', text: '', annot: a };
    draw();
  }

  function reply(st, a) {
    const replies = a.replies || [], last = replies.at(-1);
    // what the author said last, and whether a --wait has shown it to the assistant since
    const mine = last ? (!last.from ? last : null) : a;
    st.editing = unseen(a) ? { id: a.id, mode: mine === a ? 'comment' : 'edit', text: mine === a ? a.comment : mine.text }
                           : { id: a.id, mode: 'reply', text: '' };
    st.selFolded = false;
    draw();
  }

  function commit(st, text) {
    const e = st.editing, a = st.annots.find(x => x.id === e.id);
    st.editing = null;
    if (a) {
      text = text.trim();
      if (e.mode === 'new' || e.mode === 'comment') a.comment = text;
      else if (e.mode === 'edit') {
        if (text) a.replies.at(-1).text = text; else a.replies.pop();
      } else if (text) {
        a.replies = [...(a.replies || []), { text, at: now() }];
        // an answer opens a comment that was done; false and not removed, so the server does not put the mark back
        if (a.done) { a.done = false; delete a.done_at; st.looked[a.id] = outside(a); sset(st, 'seen', st.looked); }
      }
    }
    st.f.contentWindow.focus();
    return save(st);
  }

  function cancel(st) {
    if (st.editing?.mode === 'new') st.annots = st.annots.filter(a => a.id !== st.editing.id);
    st.editing = null;
    st.f.contentWindow.focus();
    draw();
  }

  // n / p: the next / previous one in the list: a comment with the changes near it, or a change that
  // no comment is near; done ones of earlier hand-overs are skipped unless D shows them
  function step(st, by) {
    const list = navItems(st);
    if (!list.length) { toast(st.annots.length ? 'nothing open · D shows the done ones' : 'no comments'); return; }
    const at = list.findIndex(it => st.sel ? it.a?.id === st.sel : it.key === st.item?.key);
    goItem(st, list[at < 0 ? (by > 0 ? 0 : list.length - 1) : (at + by + list.length) % list.length]);
  }

  // go to a comment or a change and show its card (stay: a click on the page, which does not scroll);
  // a change in it counts as seen
  function goItem(st, it, stay = false) {
    const c = st.changes;
    if (c) {
      for (const m of it.marks) if (!c.seen.includes(seenKey(m))) c.seen.push(seenKey(m));
      sset(st, 'chgseen', { ...sget(st, 'chgseen', {}), [c.kind]: c.seen });
    }
    if (it.a) select(st, it.a.id, !stay);
    else {
      select(st, null, false);
      st.item = it;
      const m = it.marks[0], node = m.ranges?.[0] ? m.ranges[0].startContainer : m.cutAt?.[0];
      if (!stay && node) elementOf(node).scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    showNews(st);
    draw();
  }

  // Ctrl+Enter: the comments are saved already; the answers go with the hand-over
  async function handOver(st) {
    const ta = st.f.contentDocument.getElementById('ed');
    if (st.editing) await commit(st, ta ? ta.value : st.editing.text || '');
    if (st.oldShown) { toast('the old page is read only · gb goes back', true); return; }
    const got = answers(st.f.contentDocument), n = Object.keys(got).length;
    // the words of the page as the reader sees it now: the next round's m compares with them
    const text = wordsOf(st.f.contentDocument).map(w => w.raw).join(' ');
    // open: a comment that waits for an answer, as --wait counts it
    const open = st.annots.filter(a => !a.done && !lastFrom(a)).length;
    try {
      const r = await fetch(api(st.t, 'api/answers'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ answers: got, text }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      // the comments that are done and were looked at leave the list now
      st.filed = st.annots.filter(a => a.done && !isNew(st, a)).map(a => a.id);
      sset(st, 'filed', st.filed);
      await loadRounds(st);
      st.texts = {};
      st.hist = null;
      // the marks compare with the page as it is now
      if (st.changes?.kind === 'handed') showChanges(st, 'handed', true); else draw();
      const what = [open && `${open} open comment(s)`, n && `${n} answer(s)`].filter(Boolean).join(' and ');
      toast(!j.listening ? 'Handed over, but nobody is waiting yet: start just-doc with --live --wait'
            : what ? `Handed over ${what}` : 'Handed over, but there is no open comment and no named field');
    } catch (e) { toast('Not handed over: ' + (e.message || 'the server is not responding'), true); }
  }

  // ? : the keys of a live page, filtered with /
  const help = document.getElementById('help'), hq = document.getElementById('hq');
  function filterHelp() {
    const q = hq.value.trim().toLowerCase();
    for (const tr of help.querySelectorAll('tr')) tr.hidden = q && !tr.textContent.toLowerCase().includes(q);
  }
  function toggleHelp() {
    help.classList.toggle('open');
    hq.value = '';
    hq.blur();
    filterHelp();
    if (!help.classList.contains('open')) S[active]?.f.contentWindow.focus();
  }
  hq.addEventListener('input', filterHelp);
  hq.addEventListener('keydown', e => {
    // Enter keeps the filter and leaves the field; Esc clears it, and closes the list when it is empty
    if (e.key === 'Enter') { e.preventDefault(); hq.blur(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (hq.value) { hq.value = ''; filterHelp(); hq.blur(); } else toggleHelp();
    }
    e.stopPropagation();
  });
  // the same keys while the window itself has the keyboard (the list is open, the field left)
  document.addEventListener('keydown', e => {
    if (e.target === hq || !help.classList.contains('open')) return;
    if (S[active] && key(e, active)) e.preventDefault();
  });
  let quitAt = 0;
  const fhint = msg => { document.getElementById('fhint').textContent = msg; };

  // the keys of a live page; true when the key was used
  function key(e, id) {
    const st = S[id];
    if (!st) return false;
    if (help.classList.contains('open')) {
      if (e.key === 'Escape' || e.key === '?') toggleHelp();
      else if (e.key === '/') hq.focus();
      return !e.ctrlKey && !e.altKey;
    }
    if (e.ctrlKey && !e.altKey && e.key === 'Enter') { handOver(st); return true; }
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const typing = e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');
    if (typing || e.key === 'Shift') return false;
    // the history takes every key while it is open
    if (histEl.classList.contains('open') && histEl.dataset.id === id) { histKey(st, e); return true; }
    const a = st.annots.find(x => x.id === st.sel);
    // g: gb the page as it was, gh the history, gn / gN next / previous
    if (st.g && Date.now() - st.g < 1500 && 'bhnN'.includes(e.key)) {
      st.g = 0;
      if (e.key === 'b') toggleOld(st);
      else if (e.key === 'h') toggleHistory(st);
      else step(st, e.key === 'n' ? 1 : -1);
      return true;
    }
    st.g = 0;
    // the page of an earlier version cannot be commented
    if (st.oldShown && 'axdu'.includes(e.key)) { toast('the old page is read only · gb goes back', true); return true; }
    if (st.z && Date.now() - st.z < 1500 && 'aRM'.includes(e.key)) {
      st.z = 0;
      if (e.key === 'a') fold(st);
      else fold(st, e.key);
      return true;
    }
    st.z = 0;
    // q asks first: it stops just-doc and closes its windows, also for a --wait that is waiting
    if (quitAt) {
      quitAt = 0;
      fhint('');
      if (e.key === 'y') fetch('api/quit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return true;
    }
    switch (e.key) {
      case '?': toggleHelp(); return true;
      case 'q':
        quitAt = Date.now();
        fhint('stop just-doc and close the window? y');
        setTimeout(() => { if (Date.now() - quitAt >= 4000) { quitAt = 0; fhint(''); } }, 4000);
        return true;
      case 'z': st.z = Date.now(); return true;
      case 'g': st.g = Date.now(); return true;
      // m: mark what is not as it was at the last Ctrl+Enter; M: at the last commit; again hides the marks
      case 'm': showChanges(st, 'handed'); return true;
      case 'M': showChanges(st, 'commit'); return true;
      case 'a': add(st); return true;
      // x: you mark a comment done yourself, when the answer needs no reply; x again opens it. It is not news: you did it.
      case 'x':
        if (!a) return false;
        if (a.done) { a.done = false; delete a.done_at; } else { a.done = true; a.done_at = now(); }
        st.looked[a.id] = outside(a);
        sset(st, 'seen', st.looked);
        save(st);
        return true;
      case 'd':
        if (!a) return false;
        st.undo.push(a);
        st.annots = st.annots.filter(x => x !== a);
        st.sel = null;
        save(st);
        return true;
      case 'u':
        if (!st.undo.length) return false;
        st.annots.push(st.undo.pop());
        save(st);
        return true;
      case 'n': step(st, 1); return true;
      case 'p': step(st, -1); return true;
      // D shows or hides the comments that are done and filed; C hides the marks on the page, the selected one stays
      case 'D': st.archive = !st.archive; draw(); return true;
      case 'C': st.noHl = !st.noHl; draw(); return true;
      case 'c':
        panel = !visible(st);
        try { localStorage.setItem('livePanel', JSON.stringify(panel)); } catch {}
        draw();
        return true;
      case 'Escape':
        if (st.oldShown) { showOld(st, null); return true; }
        if (!st.sel && !st.item) return false;
        st.sel = null;
        st.item = null;
        draw();
        return true;
    }
    return false;
  }

  // a live page was loaded (again): read its comments and place them
  async function attach(f, t) {
    const st = S[t.id] = S[t.id] || { annots: [], undo: [], rounds: [], allOpen: false, flip: new Set(), selFolded: false,
                                      archive: false, noHl: false, looked: null, filed: [], chgOpen: false };
    Object.assign(st, { t, f, where: {}, pointer: null });
    // the page was loaded again: what was marked on the old one is gone, and the old page of gb with it
    st.old?.remove();
    Object.assign(st, { old: null, oldShown: null, changes: null, item: null, texts: {}, comparing: false });
    const w = f.contentWindow;
    w.addEventListener('mousemove', e => st.pointer = { x: e.clientX, y: e.clientY }, true);
    w.addEventListener('resize', () => marks(st));
    w.addEventListener('click', e => hit(st, e), true);
    // the 3D views: a click on a marker, a changed picture (the card follows its marker), a view that was built
    w.addEventListener('jd-mark', e => { if (e.detail?.id) select(st, e.detail.id, false); });
    w.addEventListener('jd-view', () => marks(st));
    w.addEventListener('jd-ready', () => marks(st));
    await Promise.all([load(st), loadRounds(st)]);
    // on the first run everything that is there counts as looked at
    if (!st.looked) {
      st.filed = sget(st, 'filed', []);
      st.looked = sget(st, 'seen', null);
      if (!st.looked) { st.looked = {}; for (const a of st.annots) st.looked[a.id] = outside(a); sset(st, 'seen', st.looked); }
    }
    place(st);
    showNews(st);
    draw();
    // plots and other content that scripts draw a moment later
    setTimeout(() => { place(st); draw(); }, 1500);
    // the marks of the changes stay on when the page is loaded again
    const kind = st.chgKind ?? sget(st, 'changes', '');
    if (kind) {
      await settled(f.contentDocument);
      if (st.f === f) showChanges(st, kind, true);
    }
  }

  // the comments were changed from outside (a reply of the assistant)
  async function refresh(id) {
    const st = S[id];
    if (!st) return;
    const before = st.annots.filter(a => isNew(st, a)).length;
    await load(st);
    place(st);
    showNews(st);
    draw();
    const n = st.annots.filter(a => isNew(st, a)).length;
    if (n > before && !st.editing) toast(`${n} new ${n > 1 ? 'replies' : 'reply'} — n goes to the next one`);
  }

  function forget(id) { S[id]?.old?.remove(); delete S[id]; }

  // the page moves under the marks when its layout changes (a plot is drawn, a window resized)
  setInterval(() => { const st = S[active]; if (st) marks(st); }, 1000);

  return { attach, key, refresh, draw, forget };
})();
