// Comments on live pages, loaded by tabs.html. The page stays as it is: its comments are drawn on
// a layer over it (#__jd_marks, outside its layout) and listed in a side panel of the window.
//
// A comment is anchored to an element of the page: the id (or data-src) of the element or of the
// nearest ancestor that has one, the path from there to the element, a CSS path from <body> and
// the quoted text with a little text before and after it. After the page is loaded again, the
// comment is placed by the id first, then by the quote, then by the CSS path; one that cannot be
// placed is marked detached and stays in the list.
const LIVE = (() => {
  const S = {};          // tab id -> its state: t, f, annots, where, sel, editing, rounds, looked, filed, undo, pointer, ...
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
    const n = st.annots.filter(a => isNew(st, a)).length;
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
    if (all) { st.allOpen = all === 'R'; st.flip.clear(); st.selFolded = !st.allOpen; draw(); return; }
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
    #__jd_hl.has-sel .m:not(.on), #__jd_dots.has-sel .dot:not(.on) { opacity: .3; }
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

  // the places of a comment on the page, in page coordinates
  function rectsOf(st, a) {
    const loc = st.where?.[a.id], w = st.f.contentWindow;
    if (!loc) return [];
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
    for (const a of marked(st)) {
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
      if (!loc) continue;
      for (const r of rectsOf(st, a)) {
        const inside = loc.range ? near(r, 0) : near(r, 3) && !(r.w > 24 && r.h > 24 && near({ l: r.l + 8, t: r.t + 8, w: r.w - 16, h: r.h - 16 }, 0));
        const at = a.anchor?.at, dot = loc.el && at && near({ l: r.l + at[0] * r.w - 6, t: r.t + at[1] * r.h - 6, w: 12, h: 12 }, 0);
        if (!inside && !dot) continue;
        const score = (loc.range ? 0 : 1e9) + r.w * r.h;
        if (!best || score < best.score) best = { a, score };
      }
    }
    if (best && best.a.id !== st.sel) select(st, best.a.id, false);
  }

  const el = (doc, tag, text, cls) => {
    const e = doc.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };

  // The card: one box for a comment and what belongs to it, beside or under its mark. It shows your
  // comment, the last replies and the keys; the field to write in is at its bottom.
  function card(st) {
    const doc = st.f.contentDocument, box = doc.getElementById('__jd_card');
    const a = st.annots.find(x => x.id === st.sel), ed = a && st.editing?.id === a.id ? st.editing : null;
    if (!a) { if (box.firstChild) box.replaceChildren(); return; }
    const items = listOrder(st), at = items.findIndex(x => x.id === a.id), [key, word] = standing(st, a);
    // the card is built again only when something in it changed, so the field keeps what is typed
    const sig = JSON.stringify([a, ed && ed.mode, at, items.length, word, unseen(a)]);
    if (box.dataset.sig === sig && box.firstChild) return;
    box.dataset.sig = sig;
    box.replaceChildren();
    const writing = ed && (ed.mode === 'new' || ed.mode === 'comment');
    const c = el(doc, 'div', '', 'card' + (ed ? ' editing' : '')), h = el(doc, 'div', '', 'h');
    h.append(el(doc, 'b', '#' + (a.n ?? '…') + ' '));
    if (at >= 0) h.append(el(doc, 'span', `${at + 1} of ${items.length}`, 'n'));
    const r = (a.replies || []).filter(x => x.from).at(-1);
    const t = el(doc, 'span', ed?.mode === 'new' ? 'new comment' : writing ? 'edit your comment' : ed?.mode === 'edit' ? 'edit your reply'
                 : r ? r.from + ' replied' : a.done ? 'no reply' : 'your comment · ' + word, 't');
    if (a.done && !writing) t.append(el(doc, 'span', 'done ✓', 'st done'));
    h.append(t);
    c.append(h);
    if (!writing) {
      const y = el(doc, 'div', '', 'yours');
      y.append(el(doc, 'b', 'you: '), a.comment || '(no comment)');
      c.append(y);
    }
    const rs = a.replies || [];
    if (rs.length > 3) c.append(el(doc, 'div', `… ${rs.length - 3} earlier`, 'none'));
    for (const q of rs.slice(-3)) {
      // the reply in the field is not shown twice
      if (ed?.mode === 'edit' && q === rs.at(-1)) continue;
      const d = el(doc, 'div', '', 'rep' + (q.from ? '' : ' mine'));
      d.append(el(doc, 'b', (q.from || 'you') + ': '), q.text);
      c.append(d);
    }
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
    k.innerHTML = `<kbd>a</kbd> ${unseen(a) ? 'edit' : 'reply'} &nbsp;<kbd>x</kbd> ${a.done ? 'open again' : 'done'} &nbsp;`
      + '<kbd>n</kbd> next &nbsp;<kbd>p</kbd> back &nbsp;<kbd>Esc</kbd> close';
    c.append(k);
    box.append(c);
  }

  // beside its mark when there is room, else under it; scrolls with the page
  function placeCard(st) {
    const doc = st.f.contentDocument, w = st.f.contentWindow, box = doc.getElementById('__jd_card'), c = box?.querySelector('.card');
    for (const l of box?.querySelectorAll('.link') || []) l.remove();
    if (!c) return;
    const a = st.annots.find(x => x.id === st.sel), rects = a ? rectsOf(st, a) : [];
    const vw = doc.documentElement.clientWidth, vh = w.innerHeight, gap = 10, cw = c.offsetWidth, ch = c.offsetHeight;
    c.style.maxWidth = Math.min(460, vw - 16) + 'px';
    if (!rects.length) {
      // a comment that is not on the page: the card stands in the corner
      c.style.left = w.scrollX + Math.max(8, vw - cw - 16) + 'px';
      c.style.top = w.scrollY + 10 + 'px';
      return;
    }
    // beside the text it belongs to, not beside the words: the card would cover the rest of the line
    const loc = st.where[a.id];
    let block = loc.range ? elementOf(loc.range.commonAncestorContainer) : null;
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
    if (!shown.length) list.append(span('p', 'No comments. Select text or point at an element and press a.', 'none'));
    for (const a of shown) {
      const it = document.createElement('div');
      it.className = 'it' + (a.id === st.sel ? ' on' : '') + (a.done ? ' done' : '') + (groupOf(st, a) === 4 ? ' old' : '')
        + (unfolded(st, a) ? ' open' : '') + (isNew(st, a) ? ' new' : '');
      it.dataset.id = a.id;
      // a closed row is two lines: where the comment stands, its place and text; and who spoke last
      const [key, word] = standing(st, a), quote = (a.text || '').replace(/\s+/g, ' '), tag = '‹' + (a.anchor?.tag || 'element') + '›';
      const where = (a.anchor?.id ? '#' + a.anchor.id : a.anchor?.src || a.anchor?.tag || '') + (a.anchor?.src && a.anchor?.id ? ' · ' + a.anchor.src : '');
      const l1 = document.createElement('div'); l1.className = 'l1';
      l1.append(span('span', word, 'st ' + key), span('b', '#' + (a.n ?? '…')), span('span', where + (a.detached ? ' · not found on the page' : ''), 'wh'));
      l1.append(span('span', quote ? '«' + quote + '»' : tag, 'qq'));
      const r = (a.replies || []).at(-1), l2 = document.createElement('div');
      l2.className = 'l2' + (r?.from ? '' : ' me');
      l2.append(span('b', (r?.from || 'you') + ': '), r ? r.text : a.comment || '(no comment)');
      const q = span('div', (a.kind === 'element' ? '▭ ' : '') + (quote ? '«' + quote + '»' : tag), 'q');
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
      S[id].f.style.width = on ? 'calc(100% - 340px)' : '';
      marks(S[id]);
    }
    side.style.display = st && visible(st) ? 'flex' : 'none';
    if (st && visible(st)) drawList(st);
  }

  side.addEventListener('click', e => {
    const it = e.target.closest('.it');
    const st = S[active];
    if (it && st) select(st, it.dataset.id, true);
  });

  // ---- actions ----

  function select(st, id, scroll) {
    // what is written in the field of another comment is saved first
    if (st.editing && st.editing.id !== id) commit(st, st.f.contentDocument.getElementById('ed')?.value ?? st.editing.text ?? '');
    if (id !== st.sel) st.selFolded = false;
    st.sel = id;
    if (id) markSeen(st, id);
    const loc = st.where?.[id];
    if (scroll && loc) {
      const e = loc.el || elementOf(loc.range.startContainer);
      e.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    draw();
  }

  // a: a new comment on the selected text or on the element under the mouse (or the element with an
  // id around it); on a selected comment edit
  // what you wrote last while the assistant has not seen it, else reply
  function add(st) {
    const w = st.f.contentWindow, doc = st.f.contentDocument, sel = w.getSelection();
    if (sel && !sel.isCollapsed && norm(sel.toString())) {
      const r = sel.getRangeAt(0), quote = norm(sel.toString()).slice(0, 500);
      const h = findText(doc.body, quote).find(h => r.intersectsNode(h.map[h.at][0])) || findText(doc.body, quote)[0];
      const prefix = h ? h.str.slice(Math.max(0, h.at - 32), h.at) : '', suffix = h ? h.str.slice(h.end, h.end + 32) : '';
      newComment(st, 'text', quote, anchorOf(doc, elementOf(r.commonAncestorContainer), quote, prefix, suffix));
      sel.removeAllRanges();
      return;
    }
    const a = st.annots.find(x => x.id === st.sel);
    if (a) { reply(st, a); return; }
    const p = st.pointer;
    let e = p && doc.elementFromPoint(p.x, p.y);
    if (e?.closest('#__jd_marks')) e = null;
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

  function newComment(st, kind, text, anchor) {
    const a = { id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, text, comment: '',
                created: now(), anchor, replies: [] };
    st.annots.push(a);
    st.where = st.where || {};
    st.where[a.id] = locate(st.f.contentDocument, a);
    st.sel = a.id;
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

  // n / p: the next / previous comment in the list; done ones of earlier hand-overs are skipped unless D shows them
  function step(st, by) {
    const list = listOrder(st);
    if (!list.length) return;
    const at = list.findIndex(a => a.id === st.sel);
    select(st, list[at < 0 ? (by > 0 ? 0 : list.length - 1) : (at + by + list.length) % list.length].id, true);
  }

  // Ctrl+Enter: the comments are saved already; the answers go with the hand-over
  async function handOver(st) {
    const ta = st.f.contentDocument.getElementById('ed');
    if (st.editing) await commit(st, ta ? ta.value : st.editing.text || '');
    const got = answers(st.f.contentDocument), n = Object.keys(got).length;
    // open: a comment that waits for an answer, as --wait counts it
    const open = st.annots.filter(a => !a.done && !lastFrom(a)).length;
    try {
      const r = await fetch(api(st.t, 'api/answers'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ answers: got }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      // the comments that are done and were looked at leave the list now
      st.filed = st.annots.filter(a => a.done && !isNew(st, a)).map(a => a.id);
      sset(st, 'filed', st.filed);
      await loadRounds(st);
      draw();
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
    const a = st.annots.find(x => x.id === st.sel);
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
        if (!st.sel) return false;
        st.sel = null;
        draw();
        return true;
    }
    return false;
  }

  // a live page was loaded (again): read its comments and place them
  async function attach(f, t) {
    const st = S[t.id] = S[t.id] || { annots: [], undo: [], rounds: [], allOpen: false, flip: new Set(), selFolded: false,
                                      archive: false, noHl: false, looked: null, filed: [] };
    Object.assign(st, { t, f, where: {}, pointer: null });
    const w = f.contentWindow;
    w.addEventListener('mousemove', e => st.pointer = { x: e.clientX, y: e.clientY }, true);
    w.addEventListener('resize', () => marks(st));
    w.addEventListener('click', e => hit(st, e), true);
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

  function forget(id) { delete S[id]; }

  // the page moves under the marks when its layout changes (a plot is drawn, a window resized)
  setInterval(() => { const st = S[active]; if (st) marks(st); }, 1000);

  return { attach, key, refresh, draw, forget };
})();
